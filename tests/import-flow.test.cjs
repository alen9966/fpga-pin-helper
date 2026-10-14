const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function makePage() {
  const elements = new Map();
  function element() {
    const classes = new Set(["hidden"]);
    return { value: "", textContent: "", innerHTML: "", dataset: {}, listeners: {}, children: [],
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, force) => { if (force ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
      addEventListener(event, handler) { this.listeners[event] = handler; },
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = vm.createContext({ console, TextDecoder, TextEncoder, ArrayBuffer, Set, Map,
    setTimeout: () => 0, navigator: {},
    document: { getElementById: get, querySelector: get, querySelectorAll: () => [], createElement: element, body: element() } });
  for (const file of ["matcher.js", "netlist.js", "xdc-review.js", "app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../static", file), "utf8"), context);
  }
  return { context, get };
}
const component = ref => `[\n${ref}\nfootprint\npart\n]\n`;
const net = (name, ...nodes) => `(\n${name}\n${nodes.join("\n")}\n)\n`;
const coreText = component("U5") + component("J8") + net("35_24_P", "U5-A13", "J8-D21") + net("GND", "U5-A1", "U5-A2", "J8-A3", "J8-A4");
const baseText = component("U10") + component("U2") + net("TX_FRAME_P", "U10-D21", "U2-G9") + net("GND", "U10-A3", "U10-A4", "U2-A1");
function file(name, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
(async () => {
  const page = makePage();
  const actual = process.argv.slice(2);
  const core = file("ZC7.820.0239-V1.NET", actual[0] ? fs.readFileSync(actual[0]) : coreText);
  const base = file("ZC7.820.0240_V1.0.NET", actual[1] ? fs.readFileSync(actual[1]) : baseText);
  // File selection order must not change the user-confirmed board roles.
  page.get("fileInput").files = [base, core];
  await page.get("fileInput").listeners.change();
  const report = vm.runInContext("report", page.context);
  assert(report?.netlist_mode);
  assert.equal(report.detected.fpga, "U5");
  assert.equal(report.detected.connector, "J8");
  assert.equal(report.detected.baseConnector, "U10");
  assert.equal(report.matched.length, actual.length ? 79 : 1);
  assert.equal((page.get("tbody").innerHTML.match(/<tr>/g) || []).length, report.matched.length + report.core_internal.length);
  assert(page.get("tbody").innerHTML.includes("TX_FRAME_P"));
  assert(!page.get("tbody").innerHTML.includes("0805C"));
  await assert.rejects(() => vm.runInContext("parseExcelFile({name:'wrong.NET'}, 'wrong.NET')", page.context), /网表/);
  const generic = makePage();
  generic.get("fileInput").files = [file("core.net", coreText), file("base.net", baseText)];
  await generic.get("fileInput").listeners.change();
  assert.equal(vm.runInContext("report", generic.context), null);
  assert(!generic.get("netlistPanel").classList.contains("hidden"));
  assert.equal(generic.get("matchNetlists").disabled, false);
  await generic.get("matchNetlists").listeners.click();
  assert(vm.runInContext("report.netlist_mode", generic.context));
  console.log(`File-picker routing and default connection display passed (${report.matched.length} direct connections)`);
})().catch(error => { console.error(error); process.exitCode = 1; });

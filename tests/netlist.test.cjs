const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
for (const file of ["matcher.js", "netlist.js", "xdc-review.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../static", file), "utf8"));
}
const component = (ref, value = "part") => `[\n${ref}\nfootprint\n${value}\n\n]\n`;
const net = (name, ...nodes) => `(\n${name}\n${nodes.join("\n")}\n)\n`;
const core = parseProtelNetlist(component("U1") + component("J1") +
  net("35_24_P", "U1-A13", "J1-D21") + net("GND", "U1-A1", "U1-A2", "J1-A3", "J1-A4") +
  net("PS_TMS", "U1-B1", "J1-B3"), "core.NET");
const base = parseProtelNetlist(component("U2") + component("P1") +
  net("TX_FRAME_P", "P1-D21", "U2-G9") + net("GND", "P1-A3", "P1-A4", "U2-A1") +
  net("PS_TMS", "P1-B3", "U2-B1"), "base.net");
const report = analyzeNetlists(core, base, "U1", "J1", "P1");
assert.equal(report.matched.length, 2);
assert.equal(report.matched[0].package_pin, "A13");
assert.equal(report.matched[0].base_endpoints, "U2-G9");
assert.equal(report.matched[0].io_name, "");
assert.equal(report.matched[0].bank, "");
assert.equal(report.fpga_other.length, 1);
assert.match(report.fpga_other[0].core_node, /U1-A1/);
const reviewed = reviewXdc("set_property PACKAGE_PIN A13 [get_ports TX_FRAME_P]\nset_property PACKAGE_PIN A13 [get_ports other]", report);
assert.equal(reviewed.counts.ok, 1);
assert.equal(reviewed.counts.bad, 1);
assert(!reviewed.missing.some(row => row.function === "PS_TMS"));
assert.throws(() => parseProtelNetlist("(\nunfinished\nU1-A1", "bad.net"));
assert.throws(() => analyzeNetlists(core, base, "U1", "U1", "P1"));
const conflict = parseProtelNetlist(component("R1", "NC") + component("R1", "10K") +
  net("one", "R1-1") + net("two", "R1-1") + net("three", "R1-1"), "conflict.net");
assert(conflict.ambiguousComponents.has("R1"));
assert(conflict.ambiguousNodes.has("R1-1"));
assert(!conflict.byNode.has("R1-1"));
assert(conflict.warnings.length >= 2);
console.log("Netlist connectivity, shared nets, XDC eligibility and ambiguity checks passed");
const mapping = pinMappingCsv({ matched: [
  { function: 'SPI,"DO"', package_pin: "A13" },
  { function: 'SPI,"DO"', package_pin: "A13" },
  { function: "other", package_pin: "" },
  { function: "", package_pin: "B1" },
] });
assert.equal(mapping, '\uFEFF"底板功能","PACKAGE_PIN"\r\n"SPI,""DO""","A13"');
assert(pinMappingCsv(report).includes('"TX_FRAME_P","A13"'));
assert(!pinMappingCsv(report).includes('"GND"'));
console.log("Two-column mapping CSV export passed");

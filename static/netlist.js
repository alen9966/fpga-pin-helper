// Protel netlists carry electrical connectivity, not FPGA pin capabilities.
function decodeNetlist(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("gb18030").decode(buffer); }
}

function parseProtelNetlist(text, filename) {
  const components = new Map();
  const nets = [];
  const byNode = new Map();
  const warnings = [];
  const ambiguousNodes = new Set();
  const ambiguousComponents = new Set();
  let kind = null, block = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line === "[" || line === "(") {
      if (kind) throw new Error("网表块未闭合");
      kind = line; block = [];
    } else if (line === "]" || line === ")") {
      if ((kind === "[" && line !== "]") || (kind === "(" && line !== ")") || !kind) throw new Error("网表块格式错误");
      if (kind === "[") {
        if (!block[0]) throw new Error("器件位号为空");
        const component = { ref: block[0], footprint: block[1] || "", value: block[2] || "" };
        const previous = components.get(component.ref);
        if (previous && (previous.footprint !== component.footprint || previous.value !== component.value)) {
          ambiguousComponents.add(component.ref);
          warnings.push(`器件 ${component.ref} 重复定义且参数不同，请在 AD 中检查位号`);
          previous.value += " / " + component.value;
        } else components.set(component.ref, component);
      } else {
        if (!block[0]) throw new Error("网络名为空");
        const net = { name: block[0], nodes: block.slice(1).filter(Boolean) };
        for (const node of net.nodes) {
          if (byNode.has(node) || ambiguousNodes.has(node)) {
            ambiguousNodes.add(node);
            byNode.delete(node);
            warnings.push(`管脚 ${node} 出现在多个网络中，不参与跨板匹配`);
          } else byNode.set(node, net);
        }
        nets.push(net);
      }
      kind = null;
    } else if (kind) block.push(line);
    else if (line) throw new Error("请选择 AD 导出的 Protel 格式 .NET 网表");
  }
  if (kind || !components.size || !nets.length) throw new Error("网表不完整或不是 Protel 格式");
  return { filename, components, nets, byNode, warnings, ambiguousNodes, ambiguousComponents };
}

function netlistPins(netlist, ref) {
  const prefix = ref + "-";
  return [...netlist.byNode.keys()].filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length));
}

function suggestNetlistRefs(core, base) {
  const ranked = [...core.components.keys()].map(ref => ({ ref, count: netlistPins(core, ref).filter(p => /^[A-Z]+\d+$/i.test(p)).length })).sort((a, b) => b.count - a.count);
  const fpga = ranked[0]?.ref || "";
  const connectors = [...core.components.keys()].filter(r => /^(J|P|CN)\d/i.test(r)).sort((a, b) => netlistPins(core, b).length - netlistPins(core, a).length);
  const connector = connectors[0] || "";
  const corePins = new Set(netlistPins(core, connector));
  const baseCandidates = [...base.components.keys()].map(ref => ({ ref, overlap: netlistPins(base, ref).filter(p => corePins.has(p)).length })).sort((a, b) => b.overlap - a.overlap);
  return { fpga, connector, baseConnector: baseCandidates[0]?.ref || "" };
}

function analyzeNetlists(core, base, fpga, connector, baseConnector) {
  if (!core.components.has(fpga) || !core.components.has(connector) || !base.components.has(baseConnector)) throw new Error("请选择有效的 FPGA 和连接器位号");
  if (fpga === connector) throw new Error("FPGA 和核心板连接器不能是同一个器件");
  if (core.ambiguousComponents.has(fpga) || core.ambiguousComponents.has(connector) || base.ambiguousComponents.has(baseConnector)) throw new Error("所选 FPGA / 连接器存在重复位号，请先修正网表");
  const matched = [], unrouted = [], baseOther = [], shared = [];
  const usedBase = new Set();
  const prefix = fpga + "-", connPrefix = connector + "-";
  for (const net of core.nets) {
    const fpgaNodes = net.nodes.filter(n => n.startsWith(prefix) && !core.ambiguousNodes.has(n));
    const connNodes = net.nodes.filter(n => n.startsWith(connPrefix) && !core.ambiguousNodes.has(n));
    if (fpgaNodes.length > 1) {
      const links = connNodes.map(n => {
        const baseNode = baseConnector + "-" + n.slice(connPrefix.length);
        const baseNet = base.byNode.get(baseNode);
        if (baseNet) usedBase.add(baseNode);
        return baseNet ? `${n} ↔ ${baseNode} (${baseNet.name})` : n;
      });
      const row = makeRow({ category: "fpga_other", function: net.name, core_silk: net.name,
        connector_pin: links.join(" · "), extra: fpgaNodes.concat(net.nodes.filter(n => !n.startsWith(prefix) && !n.startsWith(connPrefix))).join(" · ") });
      row.review_eligible = false;
      row.base_endpoints = [...new Set(connNodes.flatMap(n => base.byNode.get(baseConnector + "-" + n.slice(connPrefix.length))?.nodes || []))].join(" · ");
      row.core_node = fpgaNodes.join(" · ");
      shared.push(row);
      continue;
    }
    for (const node of fpgaNodes) {
      let connected = false;
      for (const connNode of connNodes) {
        const pin = connNode.slice(connPrefix.length);
        const baseNode = baseConnector + "-" + pin;
        const baseNet = base.byNode.get(baseNode);
        if (!baseNet) continue;
        connected = true; usedBase.add(baseNode);
        const endpoints = baseNet.nodes.filter(n => !n.startsWith(baseConnector + "-"));
        const row = makeRow({ category: "matched", function: baseNet.name, package_pin: node.slice(prefix.length),
          connector_pin: `${connNode} ↔ ${baseNode}`, core_silk: net.name, extra: endpoints.join(" · ") });
        row.core_node = node;
        row.base_endpoints = endpoints.join(" · ");
        // Only conventional numbered GPIO net labels are eligible for PACKAGE_PIN review.
        // Netlists alone cannot establish IO names, banks, supplies, PS, or MGT capabilities.
        row.review_eligible = /^\d+_\d+(?:_(?:MRC|SRC|MRCC|SRCC))?(?:_[PN])?$/i.test(net.name);
        matched.push(row);
      }
      if (!connected) unrouted.push(makeRow({ category: "unrouted", function: net.name, package_pin: node.slice(prefix.length), core_silk: net.name, extra: net.nodes.filter(n => n !== node).join(" · ") }));
    }
  }
  for (const pin of netlistPins(base, baseConnector)) {
    const node = baseConnector + "-" + pin;
    if (usedBase.has(node)) continue;
    const net = base.byNode.get(node);
    baseOther.push(makeRow({ category: "base_other", function: net.name, connector_pin: node, extra: net.nodes.filter(n => n !== node).join(" · ") }));
  }
  if (!matched.length) throw new Error("所选器件之间没有同名连接器脚可匹配，请检查位号和连接器对接方式");
  return { matched, unrouted, base_other: baseOther, fpga_other: shared, ps: [], banks: [],
    stats: { matched: matched.length, unrouted: unrouted.length, base_other: baseOther.length, fpga_other: shared.length, ps: 0, core_pins: netlistPins(core, fpga).length, base_pins: netlistPins(base, baseConnector).length },
    core_file: core.filename, base_file: base.filename, netlist_mode: true,
    detected: { guessed: false, fpga, connector, baseConnector } };
}

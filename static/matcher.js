const PIN_HEADERS = ["标号", "pin", "pin number", "designator", "pad"];
const NAME_HEADERS = ["引脚名称", "pin name", "name", "signal"];
const NET_HEADERS = ["网络", "net", "net name", "netname"];
const DIFF_HEADERS = ["差分", "总线", "diff", "bus"];
const ELEC_HEADERS = ["电气", "electrical", "type"];

const IO_DIFF_RE = /^IO_L(\d+)([PN])(?:_[A-Z0-9]+)*_(\d+)$/i;
const IO_SE_RE = /^IO_(\d+)_(\d+)$/i;
const BASE_DIFF_RE = /^BANK(\d+)_(\d+)(?:_(?:MRC|SRC|MRCC|SRCC))?_([PN])$/i;
const BASE_SE_RE = /^BANK(\d+)_(\d+)$/i;
const BANK_TOKEN_RE = /BANK(\d+)/i;

function _norm(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function _headerIndex(headers, aliases, fallback) {
  const lowered = headers.map((h) => String(h || "").toLowerCase().replace(/\.+$/, ""));
  for (const alias of aliases) {
    const aliasL = alias.toLowerCase();
    for (let i = 0; i < lowered.length; i++) {
      if (lowered[i] === aliasL || lowered[i].includes(aliasL)) return i;
    }
  }
  return fallback < headers.length ? fallback : 0;
}

function parseWorkbook(wb, filename) {
  let bestRows = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true });
    const nonempty = rows.filter((r) => r.some((c) => _norm(c))).length;
    const bestNonempty = bestRows.filter((r) => r.some((c) => _norm(c))).length;
    if (nonempty > bestNonempty) bestRows = rows;
  }
  if (!bestRows.length) return { filename, rows: [] };

  const headers = (bestRows[0] || []).map(_norm);
  const pinI = _headerIndex(headers, PIN_HEADERS, 0);
  const nameI = _headerIndex(headers, NAME_HEADERS, 1);
  const netI = _headerIndex(headers, NET_HEADERS, 2);
  const diffI = _headerIndex(headers, DIFF_HEADERS, 3);
  const elecI = _headerIndex(headers, ELEC_HEADERS, 4);

  const parsed = [];
  let uid = 1;
  for (const raw of bestRows.slice(1)) {
    if (!raw || !raw.some((c) => _norm(c))) continue;
    const col = (idx) => (idx < raw.length ? _norm(raw[idx]) : "");
    const pin = col(pinI);
    const name = col(nameI);
    const net = col(netI);
    if (!pin && !name && !net) continue;
    parsed.push({
      _uid: uid++,
      pin,
      name,
      net,
      diff: col(diffI),
      electrical: col(elecI),
    });
  }
  return { filename, rows: parsed };
}

function silkBase(name) {
  return _norm(name).split("/")[0].trim();
}

function canonicalFromFpga(ioName) {
  const name = _norm(ioName);
  let m = name.match(IO_DIFF_RE);
  if (m) return `BANK${m[3]}_${m[1]}_${m[2].toUpperCase()}`;
  m = name.match(IO_SE_RE);
  if (m) return `BANK${m[2]}_${m[1]}`;
  return null;
}

function canonicalFromBase(pinName) {
  const name = silkBase(pinName);
  if (!name || name.toUpperCase() === "GND") return null;
  let m = name.match(BASE_DIFF_RE);
  if (m) return `BANK${m[1]}_${m[2]}_${m[3].toUpperCase()}`;
  m = name.match(BASE_SE_RE);
  if (m) return `BANK${m[1]}_${m[2]}`;
  return null;
}

function bankOf(canonical) {
  if (!canonical) return "";
  const m = String(canonical).match(BANK_TOKEN_RE);
  return m ? m[1] : "";
}

function isPlIo(name) {
  return Boolean(canonicalFromFpga(name));
}

function isPs(name) {
  return _norm(name).toUpperCase().startsWith("PS_");
}

function detectKind(rows) {
  let core = 0;
  let base = 0;
  for (const r of rows) {
    const name = r.name;
    if (isPlIo(name) || isPs(name)) core += 1;
    const silk = silkBase(name);
    if (silk.toUpperCase().startsWith("BANK") || canonicalFromBase(name)) base += 1;
  }
  if (core > base) return "core";
  if (base > core) return "base";
  return "unknown";
}

function searchBlob(...parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function makeRow(fields) {
  const bank = fields.bank || "";
  return {
    category: fields.category,
    function: fields.function || "",
    package_pin: fields.package_pin || "",
    io_name: fields.io_name || "",
    bank,
    connector_pin: fields.connector_pin || "",
    core_silk: fields.core_silk || "",
    canonical: fields.canonical || "",
    electrical: fields.electrical || "",
    extra: fields.extra || "",
    search_text: searchBlob(
      fields.function,
      fields.package_pin,
      fields.io_name,
      bank,
      bank ? `BANK${bank}` : "",
      fields.connector_pin,
      fields.core_silk,
      fields.canonical,
      fields.extra
    ),
  };
}

function sortKey(row) {
  const bankN = /^\d+$/.test(row.bank || "") ? Number(row.bank) : 10000;
  const m = String(row.canonical || "").match(/_(\d+)(?:_([PN]))?$/);
  const pair = m ? Number(m[1]) : 10000;
  const pn = m && m[2] ? { P: 0, N: 1 }[m[2].toUpperCase()] ?? 2 : 2;
  return [bankN, pair, pn, row.package_pin || "", row.connector_pin || ""];
}

function cmpKey(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function matchTables(coreRows, baseRows) {
  const coreByKey = {};
  const plRows = [];
  const fpgaOther = [];
  for (const r of coreRows) {
    const key = canonicalFromFpga(r.name);
    if (key) {
      (coreByKey[key] ||= []).push(r);
      plRows.push(r);
    } else {
      fpgaOther.push(r);
    }
  }

  const baseByKey = {};
  const baseOther = [];
  for (const r of baseRows) {
    const key = canonicalFromBase(r.name);
    if (key) (baseByKey[key] ||= []).push(r);
    else baseOther.push(r);
  }

  const matched = [];
  const usedCore = new Set();
  const usedBase = new Set();

  for (const [key, bases] of Object.entries(baseByKey)) {
    const cores = coreByKey[key] || [];
    if (!cores.length) {
      baseOther.push(...bases);
      continue;
    }
    bases.forEach((b, i) => {
      const c = cores[Math.min(i, cores.length - 1)];
      usedCore.add(c._uid);
      usedBase.add(b._uid);
      const silk = silkBase(b.name);
      matched.push(
        makeRow({
          category: "matched",
          function: b.net || silk,
          package_pin: c.pin,
          io_name: c.name,
          bank: bankOf(key),
          connector_pin: b.pin,
          core_silk: silk,
          canonical: key,
          electrical: b.electrical || c.electrical,
          extra: c.diff,
        })
      );
    });
  }

  const unmatchedPl = [];
  for (const r of plRows) {
    if (usedCore.has(r._uid)) continue;
    const key = canonicalFromFpga(r.name) || "";
    const net = r.net;
    let func;
    if (net && !net.toUpperCase().startsWith("NET")) func = net;
    else func = r.diff || "核心板自用";
    unmatchedPl.push(
      makeRow({
        category: "unrouted",
        function: func,
        package_pin: r.pin,
        io_name: r.name,
        bank: bankOf(key),
        core_silk: key,
        canonical: key,
        electrical: r.electrical,
        extra: r.diff,
      })
    );
  }

  const foldedBase = [];
  for (const r of baseOther) {
    if (usedBase.has(r._uid)) continue;
    const silk = silkBase(r.name);
    foldedBase.push(
      makeRow({
        category: "base_other",
        function: r.net || silk || "(空网络)",
        connector_pin: r.pin,
        core_silk: silk,
        electrical: r.electrical,
      })
    );
  }

  const foldedFpga = fpgaOther.map((r) =>
    makeRow({
      category: isPs(r.name) ? "ps" : "fpga_other",
      function: r.net || r.name,
      package_pin: r.pin,
      io_name: r.name,
      electrical: r.electrical,
      extra: r.diff,
    })
  );

  matched.sort(cmpKey);
  unmatchedPl.sort(cmpKey);
  const banks = [...new Set(matched.concat(unmatchedPl).map((r) => r.bank).filter(Boolean))].sort(
    (a, b) => (Number(a) || 0) - (Number(b) || 0)
  );
  const fpgaOtherRows = foldedFpga.filter((r) => r.category !== "ps");
  const psCount = foldedFpga.filter((r) => r.category === "ps").length;

  return {
    matched,
    unrouted: unmatchedPl,
    base_other: foldedBase,
    fpga_other: fpgaOtherRows,
    ps: [],
    banks,
    stats: {
      matched: matched.length,
      unrouted: unmatchedPl.length,
      base_other: foldedBase.length,
      fpga_other: fpgaOtherRows.length,
      ps: psCount,
      core_pins: coreRows.length,
      base_pins: baseRows.length,
    },
  };
}

function analyzeTables(fileA, fileB) {
  const k1 = detectKind(fileA.rows);
  const k2 = detectKind(fileB.rows);
  let core;
  let base;
  let guessed = false;
  if (k1 === "core" && k2 !== "core") {
    core = fileA;
    base = fileB;
  } else if (k2 === "core" && k1 !== "core") {
    core = fileB;
    base = fileA;
  } else if (k1 === "base" && k2 !== "base") {
    core = fileB;
    base = fileA;
  } else if (k2 === "base" && k1 !== "base") {
    core = fileA;
    base = fileB;
  } else {
    const s1 = fileA.rows.filter((r) => isPlIo(r.name)).length;
    const s2 = fileB.rows.filter((r) => isPlIo(r.name)).length;
    core = s1 >= s2 ? fileA : fileB;
    base = s1 >= s2 ? fileB : fileA;
    guessed = true;
  }
  const report = matchTables(core.rows, base.rows);
  report.core_file = core.filename;
  report.base_file = base.filename;
  report.detected = {
    file_a: { name: fileA.filename, kind: detectKind(fileA.rows), rows: fileA.rows.length },
    file_b: { name: fileB.filename, kind: detectKind(fileB.rows), rows: fileB.rows.length },
    core_is: core.filename,
    base_is: base.filename,
    guessed,
  };
  return report;
}

async function parseExcelFile(fileOrBuffer, filename) {
  const buf = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  return parseWorkbook(wb, filename || fileOrBuffer.name || "");
}

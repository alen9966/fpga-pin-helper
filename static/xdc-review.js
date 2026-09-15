const ANN_PREFIX = "##[核对]";
const ANN_STRIP_RE = /\s*##\[核对\].*$/;
const TRAILING_EMPTY_HASH_RE = /[ \t]+##[ \t]*$/;
const PACKAGE_PIN_RE = /PACKAGE_PIN\s+([A-Za-z]\d*[A-Za-z]?\d*)/i;
const PORT_START_RE = /\[get_ports\s+/i;
const NOISE_TOKENS = new Set([
  "TTL", "FI", "FO", "PO", "PI", "IO", "IN", "OUT", "R", "I", "O",
  "LVCMOS", "LVCMOS18", "LVCMOS25", "LVCMOS33", "CH",
]);
const TOKEN_ALIASES = {
  UATR: "UART",
  RSTN: "RST",
  NRST: "RST",
  RESET: "RST",
  TXD: "TX",
  RXD: "RX",
  SCK: "SCLK",
  SCL: "SCLK",
  SI: "MOSI",
  SO: "MISO",
  SDIO: "MOSI",
  SDO: "MISO",
  FREQUNCE: "FREQ",
  FREQUENCY: "FREQ",
  FREQ: "FREQ",
};
const STATUS_OK = "正确";
const STATUS_BAD = "错误";
const STATUS_EXTRA = "多余";

function sequenceRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return (2 * dp[m]) / (n + m);
}

function splitAlnum(token) {
  return token.toUpperCase().match(/[A-Z]+|\d+/g) || [token.toUpperCase()];
}

function nameTokens(name) {
  let text = String(name || "").toUpperCase().replaceAll("UATR", "UART");
  text = text.replace(/\[.*?\]/g, "");
  const raw = text.split(/[^A-Z0-9]+/);
  const out = [];
  for (let piece of raw) {
    if (!piece) continue;
    piece = TOKEN_ALIASES[piece] || piece;
    for (let part of splitAlnum(piece)) {
      part = TOKEN_ALIASES[part] || part;
      if (part && !NOISE_TOKENS.has(part)) out.push(part);
    }
  }
  return out;
}

function namesRelated(port, func) {
  const a = String(port || "").trim();
  const b = String(func || "").trim();
  if (!a || !b) return false;
  let au = a.toUpperCase().replaceAll("UATR", "UART");
  let bu = b.toUpperCase().replaceAll("UATR", "UART");
  au = au.replace(/\[.*?\]/g, "");
  bu = bu.replace(/\[.*?\]/g, "");
  if (au === bu || au.includes(bu) || bu.includes(au)) return true;
  const lastA = au.split(/[./]/).pop();
  const lastB = bu.split(/[./]/).pop();
  if (lastA === lastB || lastA.includes(lastB) || lastB.includes(lastA)) return true;
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return false;
  const inter = [...ta].filter((t) => tb.has(t));
  const letters = inter.filter((t) => /^[A-Z]+$/.test(t) && t.length >= 3);
  const numsA = [...ta].filter((t) => /^\d+$/.test(t));
  const numsB = [...tb].filter((t) => /^\d+$/.test(t));
  const numHit = numsA.some((x) =>
    numsB.some((y) => x === y || (Math.min(x.length, y.length) >= 2 && (x.startsWith(y) || y.startsWith(x))))
  );
  if (letters.length && numHit) return true;
  if (!inter.length) return sequenceRatio(lastA, lastB) >= 0.72;
  const union = new Set([...ta, ...tb]);
  const jaccard = inter.length / union.size;
  const cover = inter.length / Math.min(ta.size, tb.size);
  if (jaccard >= 0.4 || cover >= 0.66) return true;
  return sequenceRatio(lastA, lastB) >= 0.72;
}

function extractPort(line) {
  const m = line.match(PORT_START_RE);
  if (!m) return "";
  const rest = line.slice(m.index + m[0].length);
  let depth = 1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "[") depth += 1;
    else if (rest[i] === "]") {
      depth -= 1;
      if (depth === 0) return rest.slice(0, i).trim();
    }
  }
  return rest.trim();
}

function cleanSourceLine(line) {
  return line.replace(ANN_STRIP_RE, "").replace(TRAILING_EMPTY_HASH_RE, "").replace(/\s+$/, "");
}

function extractPinPort(line) {
  const pinM = line.match(PACKAGE_PIN_RE);
  if (!pinM) return null;
  return { pin: pinM[1].toUpperCase(), port: extractPort(line) };
}

function reviewXdc(text, report) {
  const byPin = {};
  const allPins = new Set();
  for (const row of report.matched || []) {
    const pin = String(row.package_pin || "").toUpperCase();
    if (pin) {
      byPin[pin] = row;
      allPins.add(pin);
    }
  }
  for (const row of [...(report.unrouted || []), ...(report.fpga_other || [])]) {
    const pin = String(row.package_pin || "").toUpperCase();
    if (pin) allPins.add(pin);
  }

  const seenPins = {};
  const usedBoardPins = new Set();
  const linesOut = [];
  const counts = { [STATUS_OK]: 0, [STATUS_BAD]: 0, [STATUS_EXTRA]: 0 };
  const rawLines = String(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

  rawLines.forEach((original, idx) => {
    const lineno = idx + 1;
    const cleaned = cleanSourceLine(original);
    const item = { lineno, source: cleaned, status: "", note: "", display: cleaned };
    const stripped = cleaned.trim();
    if (!stripped || stripped.startsWith("#")) {
      linesOut.push(item);
      return;
    }
    const extracted = extractPinPort(cleaned);
    if (!extracted) {
      linesOut.push(item);
      return;
    }
    const { pin, port } = extracted;
    let status = STATUS_EXTRA;
    let note = "";
    const board = byPin[pin];
    if (seenPins[pin]) {
      status = STATUS_BAD;
      note = `重复约束同一焊盘 ${pin}（首次在第 ${seenPins[pin]} 行）`;
      if (board && namesRelated(port, board.function || "")) {
        note += `；本端口名与底板功能 ${board.function} 相符，但焊盘已被占用`;
      }
    } else if (board) {
      usedBoardPins.add(pin);
      const func = board.function || "";
      const conn = board.connector_pin || "";
      const silk = board.core_silk || "";
      if (namesRelated(port, func)) {
        status = STATUS_OK;
        note = `底板=${func}  连接器=${conn}  丝印=${silk}`;
      } else {
        status = STATUS_BAD;
        note = `该脚底板功能是 ${func}（连接器 ${conn}），不是端口 ${port}`;
      }
    } else if (allPins.has(pin)) {
      status = STATUS_EXTRA;
      note = `${pin} 在核心板封装上，但未接到本底板连接器`;
    } else {
      status = STATUS_EXTRA;
      note = `核心板封装上无 PACKAGE_PIN ${pin}`;
    }
    if (!seenPins[pin]) seenPins[pin] = lineno;
    counts[status] += 1;
    item.status = status;
    item.note = note;
    item.pin = pin;
    item.port = port;
    item.display = `${cleaned}  ${ANN_PREFIX}${status} ${note}`;
    linesOut.push(item);
  });

  const missing = [];
  for (const row of report.matched || []) {
    const pin = String(row.package_pin || "").toUpperCase();
    const func = row.function || "";
    if (pin && !usedBoardPins.has(pin) && func && !func.toUpperCase().startsWith("NET")) {
      missing.push({
        function: func,
        package_pin: row.package_pin || "",
        connector_pin: row.connector_pin || "",
        io_name: row.io_name || "",
      });
    }
  }

  const footer = [
    "",
    `# ${ANN_PREFIX}摘要  正确=${counts[STATUS_OK]}  错误=${counts[STATUS_BAD]}  多余=${counts[STATUS_EXTRA]}  底板未约束=${missing.length}`,
    `# ${ANN_PREFIX}说明  本段由对照助手追加，不影响 Vivado 语法；行尾 ${ANN_PREFIX} 为核对批注。`,
  ];
  if (missing.length) {
    footer.push(`# ${ANN_PREFIX}底板已连接但本文件未写 PACKAGE_PIN 的功能：`);
    for (const row of missing) {
      footer.push(
        `# ${ANN_PREFIX}  未约束  ${row.function}  PACKAGE_PIN=${row.package_pin}  连接器=${row.connector_pin}  ${row.io_name}`
      );
    }
  }
  let annotated = linesOut.map((item) => item.display).join("\n");
  if (annotated && !annotated.endsWith("\n")) annotated += "\n";
  annotated += footer.join("\n") + "\n";

  return {
    counts: {
      ok: counts[STATUS_OK],
      bad: counts[STATUS_BAD],
      extra: counts[STATUS_EXTRA],
      missing: missing.length,
      package_pin_lines: counts[STATUS_OK] + counts[STATUS_BAD] + counts[STATUS_EXTRA],
    },
    missing,
    lines: linesOut,
    annotated,
    ann_prefix: ANN_PREFIX,
  };
}

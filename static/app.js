const fileInput = document.getElementById("fileInput");
const sampleBtn = document.getElementById("sampleBtn");
const fileStatus = document.getElementById("fileStatus");
const toolbar = document.getElementById("toolbar");
const detectLine = document.getElementById("detectLine");
const searchInput = document.getElementById("searchInput");
const resultCount = document.getElementById("resultCount");
const bankFilters = document.getElementById("bankFilters");
const statsLine = document.getElementById("statsLine");
const emptyHint = document.getElementById("emptyHint");
const errorBox = document.getElementById("errorBox");
const tableWrap = document.getElementById("tableWrap");
const tbody = document.getElementById("tbody");
const toast = document.getElementById("toast");
const xdcInput = document.getElementById("xdcInput");
const sampleXdcBtn = document.getElementById("sampleXdcBtn");
const reviewWrap = document.getElementById("reviewWrap");
const reviewTitle = document.getElementById("reviewTitle");
const reviewStats = document.getElementById("reviewStats");
const reviewPre = document.getElementById("reviewPre");
const missingBox = document.getElementById("missingBox");
const downloadXdcBtn = document.getElementById("downloadXdcBtn");

let review = null;
let reviewFilter = "all";

const CATEGORY_LABEL = {
  matched: "已连接",
  unrouted: "未引出",
  base_other: "底板其他",
  fpga_other: "核心板其他",
  ps: "PS",
};

let report = null;
let selectedBanks = new Set();
let selectedScopes = new Set(["matched"]);

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.toggle("hidden", !msg);
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 1400);
}

function allRows() {
  if (!report) return [];
  return [
    ...report.matched,
    ...report.unrouted,
    ...report.base_other,
    ...report.fpga_other,
  ];
}

function parseQuery(raw) {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function rowMatches(row, tokens, banks, scopes) {
  if (scopes.size && !scopes.has(row.category)) return false;
  if (banks.size && row.bank && !banks.has(row.bank)) return false;
  if (banks.size && !row.bank) return false;
  if (!tokens.length) return true;
  const hay = row.search_text || "";
  return tokens.some((t) => hay.includes(t));
}

function highlight(text, tokens) {
  const value = text || "";
  if (!tokens.length || !value) return escapeHtml(value);
  const src = escapeHtml(value);
  const pattern = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return src;
  return src.replace(new RegExp(`(${pattern})`, "ig"), "<mark>$1</mark>");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function copyText(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(
    () => showToast(`已复制 ${text}`),
    () => showToast("复制失败")
  );
}

function renderFilters() {
  const banks = report.banks || [];
  bankFilters.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `chip ${selectedBanks.size === 0 ? "on" : ""}`;
  allBtn.textContent = "全部 BANK";
  allBtn.addEventListener("click", () => {
    selectedBanks.clear();
    render();
  });
  bankFilters.appendChild(allBtn);
  for (const bank of banks) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip ${selectedBanks.has(bank) ? "on" : ""}`;
    btn.textContent = `BANK${bank}`;
    btn.addEventListener("click", () => {
      if (selectedBanks.has(bank)) selectedBanks.delete(bank);
      else selectedBanks.add(bank);
      render();
    });
    bankFilters.appendChild(btn);
  }
}

function render() {
  if (!report) return;
  try {
  renderFilters();
  document.querySelectorAll("[data-scope]").forEach((btn) => {
    btn.classList.toggle("on", selectedScopes.has(btn.dataset.scope));
  });

  const tokens = parseQuery(searchInput.value);
  const searching = tokens.length > 0;
  const scopes = searching ? new Set(["matched", "unrouted", "base_other", "fpga_other"]) : selectedScopes;
  const rows = allRows().filter((row) => rowMatches(row, tokens, selectedBanks, scopes));

  tbody.innerHTML = rows
    .map((row) => {
      const cat = CATEGORY_LABEL[row.category] || row.category;
      return `<tr>
        <td class="func">${highlight(row.function, tokens)}</td>
        <td class="pin" data-copy="${escapeHtml(row.package_pin)}">${highlight(row.package_pin, tokens)}</td>
        <td class="io" data-copy="${escapeHtml(row.io_name)}">${highlight(row.io_name, tokens)}</td>
        <td>${highlight(row.bank ? "BANK" + row.bank : "", tokens)}</td>
        <td>${highlight(row.connector_pin, tokens)}</td>
        <td>${highlight(row.core_silk, tokens)}</td>
        <td><span class="tag ${row.category}">${cat}</span></td>
      </tr>`;
    })
    .join("");

  resultCount.textContent = searching
    ? `命中 ${rows.length} 条（任一关键字）`
    : `显示 ${rows.length} 条`;
  tableWrap.dataset.rows = String(rows.length);
  document.body.dataset.ready = "1";

  const s = report.stats;
  statsLine.textContent =
    `已连接 ${s.matched}　未引出 ${s.unrouted}　底板其他 ${s.base_other}　核心板其他 ${s.fpga_other}` +
    (s.ps ? `　PS ${s.ps}（本版不对照）` : "");

  const d = report.detected;
  detectLine.textContent = `已识别：核心板「${report.core_file}」· 底板「${report.base_file}」` +
    (d?.guessed ? "（按 IO 数量推断）" : "");
  } catch (err) {
    showError("界面渲染失败：" + (err && err.message ? err.message : err));
  }
}

function acceptReport(data) {
  if (data.error) {
    showError(data.error);
    return;
  }
  report = data;
  selectedBanks.clear();
  selectedScopes = new Set(["matched"]);
  searchInput.value = "";
  showError("");
  emptyHint.classList.add("hidden");
  toolbar.classList.remove("hidden");
  tableWrap.classList.remove("hidden");
  fileStatus.textContent = `${data.stats.matched} 条 PL 已连接`;
  render();
}

async function loadSamples() {
  fileStatus.textContent = "正在加载示例…";
  try {
    const [coreBuf, baseBuf] = await Promise.all([
      fetch(encodeURI("samples/核心板.xlsx")).then((r) => {
        if (!r.ok) throw new Error("找不到 samples/核心板.xlsx");
        return r.arrayBuffer();
      }),
      fetch(encodeURI("samples/底板.xlsx")).then((r) => {
        if (!r.ok) throw new Error("找不到 samples/底板.xlsx");
        return r.arrayBuffer();
      }),
    ]);
    const core = await parseExcelFile(coreBuf, "核心板.xlsx");
    const base = await parseExcelFile(baseBuf, "底板.xlsx");
    acceptReport(analyzeTables(core, base));
    fileStatus.textContent = "已加载示例：核心板.xlsx / 底板.xlsx";
  } catch (err) {
    showError("加载示例失败：" + (err && err.message ? err.message : err));
  }
}

async function loadLocalExcels(files) {
  try {
    const parsed = [];
    for (const f of files) parsed.push(await parseExcelFile(f, f.name));
    acceptReport(analyzeTables(parsed[0], parsed[1]));
  } catch (err) {
    showError("解析表格失败：" + (err && err.message ? err.message : err));
  }
}

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  if (files.length !== 2) {
    showError("请一次选中两个表格（核心板 + 底板）。");
    return;
  }
  fileStatus.textContent = `${files[0].name}  +  ${files[1].name}`;
  await loadLocalExcels(files);
});

sampleBtn.addEventListener("click", () => loadSamples());

searchInput.addEventListener("input", render);

document.querySelector(".filters").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-scope]");
  if (!btn) return;
  const scope = btn.dataset.scope;
  if (selectedScopes.has(scope) && selectedScopes.size === 1) return;
  if (selectedScopes.has(scope)) selectedScopes.delete(scope);
  else selectedScopes.add(scope);
  render();
});

tbody.addEventListener("click", (ev) => {
  const cell = ev.target.closest("[data-copy]");
  if (!cell) return;
  copyText(cell.getAttribute("data-copy"));
});

function statusClass(status) {
  if (status === "正确") return "ok";
  if (status === "错误") return "bad";
  if (status === "多余") return "extra";
  return "";
}

function renderReview() {
  if (!review) return;
  reviewWrap.classList.remove("hidden");
  const c = review.counts || {};
  reviewTitle.textContent = `约束核对 · ${review.filename || ""}`;
  reviewStats.textContent =
    `PACKAGE_PIN ${c.package_pin_lines || 0} 条　正确 ${c.ok || 0}　错误 ${c.bad || 0}　多余 ${c.extra || 0}　底板未约束 ${c.missing || 0}` +
    `　批注前缀 ${review.ann_prefix || "##[核对]"}`;

  document.querySelectorAll("[data-review]").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.review === reviewFilter);
  });

  if (reviewFilter === "missing") {
    reviewPre.innerHTML = "";
    missingBox.classList.remove("hidden");
    missingBox.innerHTML =
      "<strong>底板已连接但约束文件未写 PACKAGE_PIN</strong><ul>" +
      (review.missing || [])
        .map(
          (row) =>
            `<li>${escapeHtml(row.function)}　PACKAGE_PIN ${escapeHtml(row.package_pin)}　连接器 ${escapeHtml(row.connector_pin)}　${escapeHtml(row.io_name)}</li>`
        )
        .join("") +
      "</ul>";
    return;
  }

  missingBox.classList.add("hidden");
  const rows = review.lines || [];
  reviewPre.innerHTML = rows
    .filter((line) => reviewFilter === "all" || line.status === reviewFilter)
    .map((line) => {
      const cls = statusClass(line.status);
      return `<div class="xdc-line ${cls}">${escapeHtml(line.display || "")}</div>`;
    })
    .join("");
}

function acceptReview(data) {
  if (data.error) {
    showError(data.error);
    return;
  }
  review = data;
  reviewFilter = "all";
  showError("");
  renderReview();
  showToast(`核对完成：正确 ${data.counts.ok} / 错误 ${data.counts.bad} / 多余 ${data.counts.extra}`);
}

async function postXdc(file) {
  if (!report) {
    showError("请先加载核心板和底板表格。");
    return;
  }
  try {
    let text;
    let filename;
    if (file) {
      text = await file.text();
      filename = file.name;
    } else {
      const res = await fetch(encodeURI("samples/引脚约束.txt"));
      if (!res.ok) throw new Error("找不到 samples/引脚约束.txt");
      text = await res.text();
      filename = "引脚约束.txt";
    }
    const data = reviewXdc(text, report);
    data.filename = filename;
    acceptReview(data);
  } catch (err) {
    showError("约束核对失败：" + (err && err.message ? err.message : err));
  }
}

xdcInput.addEventListener("change", async () => {
  const file = xdcInput.files && xdcInput.files[0];
  if (!file) return;
  await postXdc(file);
  xdcInput.value = "";
});

sampleXdcBtn.addEventListener("click", () => postXdc(null));

document.getElementById("reviewFilters").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-review]");
  if (!btn || !review) return;
  reviewFilter = btn.dataset.review;
  renderReview();
});

downloadXdcBtn.addEventListener("click", () => {
  if (!review || !review.annotated) return;
  const raw = review.filename || "pins.txt";
  const dot = raw.lastIndexOf(".");
  const name = dot > 0 ? `${raw.slice(0, dot)}_核对${raw.slice(dot)}` : `${raw}_核对.txt`;
  const blob = new Blob([review.annotated], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
});

"""Review a Vivado XDC against core-board / baseboard pin mapping."""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

ANN_PREFIX = "##[核对]"
ANN_STRIP_RE = re.compile(r"\s*" + re.escape(ANN_PREFIX) + r".*$")
TRAILING_EMPTY_HASH_RE = re.compile(r"[ \t]+##[ \t]*$")
PACKAGE_PIN_RE = re.compile(r"PACKAGE_PIN\s+([A-Za-z]\d*[A-Za-z]?\d*)", re.IGNORECASE)
PORT_START_RE = re.compile(r"\[get_ports\s+", re.IGNORECASE)
NOISE_TOKENS = {
    "TTL", "FI", "FO", "PO", "PI", "IO", "IN", "OUT", "R", "I", "O",
    "LVCMOS", "LVCMOS18", "LVCMOS25", "LVCMOS33", "CH",
}
TOKEN_ALIASES = {
    "UATR": "UART",
    "RSTN": "RST",
    "NRST": "RST",
    "RESET": "RST",
    "TXD": "TX",
    "RXD": "RX",
    "SCK": "SCLK",
    "SCL": "SCLK",
    "SI": "MOSI",
    "SO": "MISO",
    "SDIO": "MOSI",
    "SDO": "MISO",
    "FREQUNCE": "FREQ",
    "FREQUENCY": "FREQ",
    "FREQ": "FREQ",
}

STATUS_OK = "正确"
STATUS_BAD = "错误"
STATUS_EXTRA = "多余"


def decode_text(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _split_alnum(token: str) -> list[str]:
    parts = re.findall(r"[A-Z]+|\d+", token.upper())
    return parts or [token.upper()]


def name_tokens(name: str) -> list[str]:
    text = (name or "").upper().replace("UATR", "UART")
    text = re.sub(r"\[.*?\]", "", text)
    raw = re.split(r"[^A-Z0-9]+", text)
    out: list[str] = []
    for piece in raw:
        if not piece:
            continue
        piece = TOKEN_ALIASES.get(piece, piece)
        for part in _split_alnum(piece):
            part = TOKEN_ALIASES.get(part, part)
            if part and part not in NOISE_TOKENS:
                out.append(part)
    return out


def names_related(port: str, function: str) -> bool:
    a, b = (port or "").strip(), (function or "").strip()
    if not a or not b:
        return False
    au, bu = a.upper().replace("UATR", "UART"), b.upper().replace("UATR", "UART")
    au = re.sub(r"\[.*?\]", "", au)
    bu = re.sub(r"\[.*?\]", "", bu)
    if au == bu or au in bu or bu in au:
        return True
    last_a = re.split(r"[./]", au)[-1]
    last_b = re.split(r"[./]", bu)[-1]
    if last_a == last_b or last_a in last_b or last_b in last_a:
        return True
    ta, tb = set(name_tokens(a)), set(name_tokens(b))
    if not ta or not tb:
        return False
    inter = ta & tb
    letters = {t for t in inter if t.isalpha() and len(t) >= 3}
    nums_a = {t for t in ta if t.isdigit()}
    nums_b = {t for t in tb if t.isdigit()}
    num_hit = any(
        x == y or (min(len(x), len(y)) >= 2 and (x.startswith(y) or y.startswith(x)))
        for x in nums_a
        for y in nums_b
    )
    if letters and num_hit:
        return True
    if not inter:
        return SequenceMatcher(None, last_a, last_b).ratio() >= 0.72
    jaccard = len(inter) / len(ta | tb)
    cover = len(inter) / min(len(ta), len(tb))
    if jaccard >= 0.4 or cover >= 0.66:
        return True
    return SequenceMatcher(None, last_a, last_b).ratio() >= 0.72


def _extract_port(line: str) -> str:
    m = PORT_START_RE.search(line)
    if not m:
        return ""
    rest = line[m.end():]
    depth = 1
    for i, ch in enumerate(rest):
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return rest[:i].strip()
    return rest.strip()


def _is_active_constraint(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and not stripped.startswith("#")


def _clean_source_line(line: str) -> str:
    line = ANN_STRIP_RE.sub("", line)
    line = TRAILING_EMPTY_HASH_RE.sub("", line)
    return line.rstrip()


def _extract_pin_port(line: str) -> tuple[str, str] | None:
    pin_m = PACKAGE_PIN_RE.search(line)
    if not pin_m:
        return None
    port = _extract_port(line)
    return pin_m.group(1).upper(), port


def _index_report(report: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], set[str], dict[str, dict[str, Any]]]:
    by_pin: dict[str, dict[str, Any]] = {}
    all_pins: set[str] = set()
    by_function: dict[str, dict[str, Any]] = {}
    for row in report.get("matched") or []:
        pin = (row.get("package_pin") or "").upper()
        if pin:
            by_pin[pin] = row
            all_pins.add(pin)
        func = (row.get("function") or "").strip()
        if func:
            by_function.setdefault(func.upper(), row)
    for row in (report.get("unrouted") or []) + (report.get("fpga_other") or []):
        pin = (row.get("package_pin") or "").upper()
        if pin:
            all_pins.add(pin)
    return by_pin, all_pins, by_function


def review_xdc(text: str, report: dict[str, Any]) -> dict[str, Any]:
    by_pin, all_pins, _by_function = _index_report(report)
    seen_pins: dict[str, int] = {}
    used_board_pins: set[str] = set()
    lines_out: list[dict[str, Any]] = []
    counts = {STATUS_OK: 0, STATUS_BAD: 0, STATUS_EXTRA: 0}

    raw_lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for lineno, original in enumerate(raw_lines, 1):
        cleaned = _clean_source_line(original)
        item = {
            "lineno": lineno,
            "source": cleaned,
            "status": "",
            "note": "",
            "display": cleaned,
        }
        if not _is_active_constraint(cleaned):
            lines_out.append(item)
            continue
        extracted = _extract_pin_port(cleaned)
        if not extracted:
            lines_out.append(item)
            continue

        pin, port = extracted
        status = STATUS_EXTRA
        note = ""
        board = by_pin.get(pin)

        if pin in seen_pins:
            status = STATUS_BAD
            prev = seen_pins[pin]
            note = f"重复约束同一焊盘 {pin}（首次在第 {prev} 行）"
            if board and names_related(port, board.get("function") or ""):
                note += f"；本端口名与底板功能 {board.get('function')} 相符，但焊盘已被占用"
        elif board:
            used_board_pins.add(pin)
            func = board.get("function") or ""
            conn = board.get("connector_pin") or ""
            silk = board.get("core_silk") or ""
            if names_related(port, func):
                status = STATUS_OK
                note = f"底板={func}  连接器={conn}  丝印={silk}"
            else:
                status = STATUS_BAD
                note = f"该脚底板功能是 {func}（连接器 {conn}），不是端口 {port}"
        elif pin in all_pins:
            status = STATUS_EXTRA
            note = f"{pin} 在核心板封装上，但未接到本底板连接器"
        else:
            status = STATUS_EXTRA
            note = f"核心板封装上无 PACKAGE_PIN {pin}"

        seen_pins.setdefault(pin, lineno)
        counts[status] = counts.get(status, 0) + 1
        item["status"] = status
        item["note"] = note
        item["pin"] = pin
        item["port"] = port
        item["display"] = f"{cleaned}  {ANN_PREFIX}{status} {note}"
        lines_out.append(item)

    missing: list[dict[str, str]] = []
    for row in report.get("matched") or []:
        pin = (row.get("package_pin") or "").upper()
        func = row.get("function") or ""
        if pin and pin not in used_board_pins and func and not func.upper().startswith("NET"):
            missing.append(
                {
                    "function": func,
                    "package_pin": row.get("package_pin") or "",
                    "connector_pin": row.get("connector_pin") or "",
                    "io_name": row.get("io_name") or "",
                }
            )

    footer = [
        "",
        f"# {ANN_PREFIX}摘要  正确={counts[STATUS_OK]}  错误={counts[STATUS_BAD]}  多余={counts[STATUS_EXTRA]}  底板未约束={len(missing)}",
        f"# {ANN_PREFIX}说明  本段由对照助手追加，不影响 Vivado 语法；行尾 {ANN_PREFIX} 为核对批注。",
    ]
    if missing:
        footer.append(f"# {ANN_PREFIX}底板已连接但本文件未写 PACKAGE_PIN 的功能：")
        for row in missing:
            footer.append(
                f"# {ANN_PREFIX}  未约束  {row['function']}  PACKAGE_PIN={row['package_pin']}  连接器={row['connector_pin']}  {row['io_name']}"
            )
    annotated = "\n".join(item["display"] for item in lines_out)
    if annotated and not annotated.endswith("\n"):
        annotated += "\n"
    annotated += "\n".join(footer) + "\n"

    return {
        "counts": {
            "ok": counts[STATUS_OK],
            "bad": counts[STATUS_BAD],
            "extra": counts[STATUS_EXTRA],
            "missing": len(missing),
            "package_pin_lines": counts[STATUS_OK] + counts[STATUS_BAD] + counts[STATUS_EXTRA],
        },
        "missing": missing,
        "lines": lines_out,
        "annotated": annotated,
        "ann_prefix": ANN_PREFIX,
    }

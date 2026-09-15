"""Local web UI for FPGA core-board vs baseboard pin lookup."""

from __future__ import annotations

import socket
import threading
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

from matcher import analyze_files
from xdc_review import decode_text, review_xdc

ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / "samples"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

LAST_REPORT: dict | None = None


def _store_report(report: dict) -> dict:
    global LAST_REPORT
    LAST_REPORT = report
    return report


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/samples/<path:name>")
def sample_file(name):
    return send_from_directory(SAMPLES, name)


@app.get("/CHANGELOG.md")
def changelog_file():
    return send_from_directory(ROOT, "CHANGELOG.md", mimetype="text/markdown; charset=utf-8")


@app.post("/api/match")
def api_match():
    files = request.files.getlist("files")
    if len(files) != 2:
        return jsonify({"error": "请一次选择两个 Excel 文件：核心板一份、底板一份。"}), 400
    blobs = []
    names = []
    for f in files:
        data = f.read()
        if not data:
            return jsonify({"error": f"文件为空：{f.filename}"}), 400
        blobs.append(data)
        names.append(f.filename or "")
    try:
        report = analyze_files(blobs[0], blobs[1], names[0], names[1])
    except Exception as exc:  # noqa: BLE001 — show parse errors in UI
        return jsonify({"error": f"解析失败：{exc}"}), 400
    return jsonify(_store_report(report))


@app.post("/api/samples")
def api_samples():
    core = SAMPLES / "核心板.xlsx"
    base = SAMPLES / "底板.xlsx"
    if not core.exists() or not base.exists():
        return jsonify({"error": "未找到 samples 目录下的示例表格。"}), 404
    report = analyze_files(core, base, core.name, base.name)
    return jsonify(_store_report(report))


@app.post("/api/review-xdc")
def api_review_xdc():
    if LAST_REPORT is None:
        return jsonify({"error": "请先加载核心板和底板表格，再上传约束文件。"}), 400
    uploaded = request.files.get("xdc")
    if uploaded is None or not uploaded.filename:
        sample = SAMPLES / "引脚约束.txt"
        if not sample.exists():
            return jsonify({"error": "请上传 .xdc / .txt 约束文件。"}), 400
        text = sample.read_text(encoding="utf-8")
        filename = sample.name
    else:
        text = decode_text(uploaded.read())
        filename = uploaded.filename
    result = review_xdc(text, LAST_REPORT)
    result["filename"] = filename
    return jsonify(result)


@app.get("/changelog")
def changelog():
    return send_from_directory(ROOT, "CHANGELOG.md", mimetype="text/markdown; charset=utf-8")


def lan_ips() -> list[str]:
    ips: list[str] = []
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        ip = probe.getsockname()[0]
        probe.close()
        if ip and not ip.startswith("127.") and ip not in ips:
            ips.insert(0, ip)
    except OSError:
        pass
    return ips


def main():
    port = 8765
    print("本机访问:  http://127.0.0.1:{}/".format(port))
    addrs = lan_ips()
    if addrs:
        print("同事访问:")
        for ip in addrs:
            print("          http://{}:{}/".format(ip, port))
    else:
        print("未自动读到局域网 IP，请在 ipconfig 里查看本机 IPv4，同事用 http://本机IP:{}/ 访问。".format(port))
    threading.Timer(0.8, lambda: webbrowser.open("http://127.0.0.1:{}/".format(port))).start()
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()

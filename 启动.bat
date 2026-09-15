@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 FPGA 引脚对照助手...
echo 启动后本机用 http://127.0.0.1:8765/ ，同事用下面打印的局域网地址。
py -3 -m pip install -r requirements.txt -q
py -3 app.py
pause

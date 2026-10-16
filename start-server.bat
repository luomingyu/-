@echo off
rem ============================================================
rem  月度排课系统 · 开机自启脚本
rem  由 start-server-hidden.vbs 以隐藏窗口方式调用
rem  崩溃/端口占用时每 5 秒自动重试，日志写入 server.log
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

:loop
node server/index.mjs >> server.log 2>&1
timeout /t 5 /nobreak >nul <nul
goto loop

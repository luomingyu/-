@echo off
rem ============================================================
rem  One-time installer for auto-start.
rem  Double-click this file to register the LAN server to start
rem  automatically at Windows logon (no admin rights needed).
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
pause

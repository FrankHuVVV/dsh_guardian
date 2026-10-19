@echo off
rem DSH Guardian UI - 打开状态窗口（后端常驻托盘，关闭窗口不停止后端）
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0guardian-console.ps1"

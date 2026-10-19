@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ---- Require administrator rights (needed for the autostart scheduled task) ----
net session >nul 2>&1
if errorlevel 1 (
  echo [DSH Guardian] Administrator privileges are required.
  echo [DSH Guardian] Requesting elevation - please confirm the UAC prompt...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c', ([char]34 + '%~f0' + [char]34) -Verb RunAs"
  exit /b
)

echo [DSH Guardian] Starting the one-click installer...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo [DSH Guardian] Installation did not finish successfully. See the messages above.
)

echo.
pause

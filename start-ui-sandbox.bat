@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  pause
  exit /b 1
)

echo [DSH Guardian] initializing sandbox...
node "ui\sandbox-init.mjs"
if errorlevel 1 (
  echo [ERROR] sandbox init failed.
  pause
  exit /b 1
)

set "GUARDIAN_SANDBOX=true"
echo.
echo [DSH Guardian] SANDBOX UI  -^>  http://127.0.0.1:3082/
echo   sandbox root : %CD%\sandbox
echo   production UI on 3081 is NOT affected.
echo.

node "ui\server.mjs" --sandbox

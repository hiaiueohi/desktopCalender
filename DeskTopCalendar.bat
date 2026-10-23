@echo off
rem Double-click to start DeskTop Calendar.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing Electron. Please wait...
  call npm install
  call node node_modules\electron\install.js
)
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .

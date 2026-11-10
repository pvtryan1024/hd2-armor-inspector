@echo off
rem Double-click to start the HD2 Armor Inspector. Close this window to stop it.
cd /d "%~dp0"
start "" http://localhost:8080
node serve.js
pause

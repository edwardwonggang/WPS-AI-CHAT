@echo off
setlocal
cd /d "%~dp0"

powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File ".\server\start-relay.ps1"
start "" wps.exe
endlocal

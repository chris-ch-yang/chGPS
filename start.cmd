@echo off
rem chGPS launcher - double-click this file.
rem start.ps1 elevates itself; tunneld needs admin to create a TUN interface.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"

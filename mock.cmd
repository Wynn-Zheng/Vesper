@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === mock channel ===
echo Type a message and press Enter. /quit to exit.
echo.
node dev/mock.ts
echo.
pause

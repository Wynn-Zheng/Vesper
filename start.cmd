@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".env" (
  echo No .env found. Copy .env.example to .env and fill ONEBOT_TOKEN first.
  pause
  exit /b 1
)
node --env-file-if-exists=.env src/index.ts
pause

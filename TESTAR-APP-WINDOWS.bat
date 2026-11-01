@echo off
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo Execute GERAR-APP-WINDOWS.bat primeiro.
  pause
  exit /b 1
)
call npm start

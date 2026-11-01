@echo off
setlocal
cd /d "%~dp0"
title MDF Cut Studio - Criar aplicativo Windows
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo O Node.js ainda nao esta instalado.
  echo Instale a versao LTS em https://nodejs.org/ e execute este arquivo novamente.
  echo.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm nao encontrado. Reinstale o Node.js LTS.
  pause
  exit /b 1
)
echo.
echo Instalando os componentes do aplicativo... (internet necessaria na primeira vez)
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo Falha ao baixar os componentes. Verifique a conexao e tente novamente.
  pause
  exit /b 1
)
echo.
echo Gerando executavel portatil para Windows 64 bits...
call npm run dist:portable
if errorlevel 1 (
  echo Falha ao gerar o programa. Confira as mensagens acima.
  pause
  exit /b 1
)
echo.
echo Pronto! Os arquivos do Windows estao na pasta dist.
start "" "%~dp0dist"
pause

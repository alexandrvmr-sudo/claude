@echo off
REM Двойной клик — запуск «Волшебного зеркала» на Windows
chcp 65001 > nul
cd /d "%~dp0"

where node > nul 2>&1
if errorlevel 1 (
  echo.
  echo   НЕ НАЙДЕН NODE.JS
  echo.
  echo   Установите его с https://nodejs.org ^(большая кнопка LTS^),
  echo   всё по умолчанию, и запустите этот файл снова.
  echo.
  pause
  exit /b 1
)

node server.js
pause

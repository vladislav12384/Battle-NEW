@echo off
chcp 65001 >nul
title Battle - combat sandbox
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js не найден.
  echo  Скачай и установи версию LTS с https://nodejs.org , потом запусти этот файл снова.
  echo.
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
if errorlevel 1 (
  echo.
  echo  Нужен Node.js 22.12 или новее. Сейчас установлен:
  node -v
  echo  Обнови его с https://nodejs.org (версия LTS^) и запусти этот файл снова.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo  Первый запуск: устанавливаю зависимости, это займёт минуту...
  call npm install
  if errorlevel 1 (
    echo  Установка не удалась, смотри сообщения выше.
    pause
    exit /b 1
  )
)

echo.
echo  Игра откроется в браузере: http://localhost:5173
echo  Чтобы остановить сервер, закрой это окно.
echo.
call npm run dev -- --open
pause

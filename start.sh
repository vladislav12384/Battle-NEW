#!/usr/bin/env bash
# Запуск полигона на macOS / Linux.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установи LTS с https://nodejs.org и запусти снова."
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"; then
  echo "Нужен Node.js 22.12 или новее, сейчас: $(node -v). Обнови с https://nodejs.org"
  exit 1
fi
[ -d node_modules ] || npm install
echo "Игра откроется в браузере: http://localhost:5173 (Ctrl+C — остановить)"
exec npm run dev -- --open

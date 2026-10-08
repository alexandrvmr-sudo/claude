#!/bin/bash
# Двойной клик — запуск «Волшебного зеркала» на macOS
cd "$(dirname "$0")" || exit 1

# При двойном клике профиль оболочки может не загрузиться, и node не найдётся
# в PATH. Поэтому ищем его ещё и в привычных местах установки.
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for candidate in \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /usr/bin/node \
    "$HOME/.nvm/versions/node/"*/bin/node \
    "$HOME/.volta/bin/node" \
    /opt/local/bin/node
  do
    [ -x "$candidate" ] && NODE="$candidate"
  done
fi

if [ -z "$NODE" ]; then
  echo
  echo "  НЕ НАЙДЕН NODE.JS"
  echo
  echo "  Установите его с https://nodejs.org (большая кнопка LTS),"
  echo "  всё по умолчанию, и запустите этот файл снова."
  echo
  read -n 1 -s -r -p "  Нажмите любую клавишу, чтобы закрыть окно"
  echo
  exit 1
fi

"$NODE" server.js

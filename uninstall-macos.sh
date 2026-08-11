#!/usr/bin/env bash
# Desinstala o Adaptive Shuffle do Spicetify (macOS / Linux).
set -euo pipefail
NAME="adaptive-shuffle"

EXT_DIR="${SPICETIFY_EXTENSIONS_DIR:-}"
if [ -z "$EXT_DIR" ]; then
  if command -v spicetify >/dev/null 2>&1; then
    CFG_HOME="$(spicetify path userdata 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$CFG_HOME" ]; then
    CFG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/spicetify"
  fi
  EXT_DIR="$CFG_HOME/Extensions"
fi

rm -f "$EXT_DIR/$NAME.js"
echo "✔ Extensão removida de $EXT_DIR"

# Desabilita na config: "spicetify config extensions <file>" alterna (liga/desliga).
# Se estivesse habilitada, isto remove; se nao, e no-op.
spicetify config extensions "$NAME.js" || true

spicetify apply
echo "✅ Adaptive Shuffle desinstalado."
echo "Os dados que ele aprendeu continuam no LocalStorage do Spotify."
echo "Pra apagar tudo: menu do Spicetify → Adaptive Shuffle → \"Começar do zero\"."
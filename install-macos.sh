#!/usr/bin/env bash
# Instala o Adaptive Shuffle no Spicetify (macOS / Linux).
# Execucao:  ./install-macos.sh
#
# O que faz:
#   1. Descobre a pasta de Extensoes do Spicetify.
#   2. Copia adaptive-shuffle.js pra la.
#   3. Habilita a extensao (spicetify config extensions ...).
#   4. Aplica (spicetify apply).
# So altera seu Spicetify quando VOCE roda este script.

set -euo pipefail

NAME="adaptive-shuffle"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/$NAME.js"

if [ ! -f "$SRC" ]; then
  echo "❌ Nao achei $SRC"
  echo "   Rode este script de dentro da pasta do projeto."
  exit 1
fi

echo "✨ Adaptive Shuffle — instalador (macOS/Linux)"
echo

# Descobre a pasta de configuracao do Spicetify
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

echo "📁 Pasta de extensões: $EXT_DIR"
mkdir -p "$EXT_DIR"
cp "$SRC" "$EXT_DIR/$NAME.js"
echo "✔ Extensão copiada."

echo "🔌 Habilitando a extensão..."
spicetify config extensions "$NAME.js"

echo "🎨 Aplicando mudanças..."
spicetify apply

echo
echo "✅ Pronto! Reinicie o Spotify e procure:"
echo "   • Um botão ✦ (shuffle com brilho) do lado direito da barra do player"
echo "   • \"Tocar com Adaptive Shuffle\" ao clicar com o direito numa playlist"
echo "   • \"Adaptive Shuffle\" ao clicar com o direito numa faixa (turbinar/evitar)"
echo
echo "Para DESINSTALAR: ./uninstall-macos.sh"
# Instala o Adaptive Shuffle no Spicetify (Windows, PowerShell).
# Execucao:  ./install-windows.ps1
#
# O que faz:
#   1. Descobre a pasta de Extensoes do Spicetify.
#   2. Copia adaptive-shuffle.js pra la.
#   3. Habilita a extensao (spicetify config extensions ...).
#   4. Aplica (spicetify apply).
# So altera seu Spicetify quando VOCE roda este script.

$ErrorActionPreference = "Stop"
$Name = "adaptive-shuffle"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src = Join-Path $Here "$Name.js"

if (-not (Test-Path $Src)) {
    Write-Host "❌ Nao achei $Src" -ForegroundColor Red
    Write-Host "   Rode este script de dentro da pasta do projeto."
    exit 1
}

Write-Host "✨ Adaptive Shuffle — instalador (Windows)" -ForegroundColor Cyan
Write-Host ""

# Descobre a pasta de configuracao do Spicetify
$ExtDir = $env:SPICETIFY_EXTENSIONS_DIR
if (-not $ExtDir) {
    $SpicetifyHome = Join-Path $env:APPDATA "spicetify"
    $ExtDir = Join-Path $SpicetifyHome "Extensions"
}

Write-Host "📁 Pasta de extenções: $ExtDir"
New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
Copy-Item $Src (Join-Path $ExtDir "$Name.js") -Force
Write-Host "✔ Extensão copiada." -ForegroundColor Green

Write-Host "🔌 Habilitando a extensão..."
spicetify config extensions "$Name.js"

Write-Host "🎨 Aplicando mudanças..."
spicetify apply

Write-Host ""
Write-Host "✅ Pronto! Reinicie o Spotify e procure:" -ForegroundColor Green
Write-Host "   • Um botão ✨ na barra do player"
Write-Host "   • `"Tocar com Adaptive Shuffle`" ao clicar com o direito numa playlist"
Write-Host "   • `"Adaptive Shuffle`" no menu do Spicetify (configurações)"
Write-Host ""
Write-Host "Para DESINSTALAR: .\uninstall.ps1"
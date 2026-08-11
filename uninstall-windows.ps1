# Desinstala o Adaptive Shuffle do Spicetify (Windows, PowerShell).
$ErrorActionPreference = "Stop"
$Name = "adaptive-shuffle"

$ExtDir = $env:SPICETIFY_EXTENSIONS_DIR
if (-not $ExtDir) {
    $SpicetifyHome = Join-Path $env:APPDATA "spicetify"
    $ExtDir = Join-Path $SpicetifyHome "Extensions"
}

Remove-Item (Join-Path $ExtDir "$Name.js") -Force -ErrorAction SilentlyContinue
Write-Host "✔ Extensão removida de $ExtDir" -ForegroundColor Green

# Desabilita na config: "spicetify config extensions <file>" alterna (liga/desliga).
spicetify config extensions "$Name.js"
spicetify apply
Write-Host "✅ Adaptive Shuffle desinstalado." -ForegroundColor Green
Write-Host "Os dados que ele aprendeu continuam no LocalStorage do Spotify."
Write-Host "Pra apagar tudo: menu do Spicetify → Adaptive Shuffle → `"Começar do zero`"."
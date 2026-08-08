# Copies the plugin files into a vault for live testing.
#
#   powershell -File scripts\syncToVault.ps1
#
# Then in Obsidian: Ctrl+P -> "Reload app without saving".
#
# The destination is deliberately NOT hard-coded here, so no one's local paths
# end up in a public repository. Point it at your vault once, either by
# creating scripts\vault.path (gitignored) containing the plugin folder, or by
# passing -VaultPlugin, or by setting $env:OBSIDIAN_TABLE_PLUGIN_DIR.

param(
    [string]$VaultPlugin
)

$repoRoot = Split-Path $PSScriptRoot -Parent
$pathFile = Join-Path $PSScriptRoot 'vault.path'

if (-not $VaultPlugin) { $VaultPlugin = $env:OBSIDIAN_TABLE_PLUGIN_DIR }
if (-not $VaultPlugin -and (Test-Path $pathFile)) {
    $VaultPlugin = (Get-Content $pathFile -Raw).Trim()
}

if (-not $VaultPlugin) {
    Write-Error @'
No destination configured. Do one of these once:

  Set-Content scripts\vault.path "C:\path\to\Vault\.obsidian\plugins\html-table-toolbar"

  or:  powershell -File scripts\syncToVault.ps1 -VaultPlugin "C:\path\to\..."
  or:  $env:OBSIDIAN_TABLE_PLUGIN_DIR = "C:\path\to\..."
'@
    exit 1
}

if (-not (Test-Path $VaultPlugin)) {
    New-Item -ItemType Directory -Force $VaultPlugin | Out-Null
}

Copy-Item `
    (Join-Path $repoRoot 'main.js'), `
    (Join-Path $repoRoot 'manifest.json'), `
    (Join-Path $repoRoot 'styles.css') `
    $VaultPlugin -Force

Write-Host "Synced main.js, manifest.json, styles.css -> $VaultPlugin"

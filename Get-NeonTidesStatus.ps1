[CmdletBinding()]
param([string]$InstallRoot = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'NeonTidesForCodex'
}
$installDirectory = [IO.Path]::GetFullPath($InstallRoot)
$manifestPath = Join-Path $installDirectory 'install-manifest.json'
$statePath = Join-Path $installDirectory 'manager-state.json'
$startupLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Neon Tides for Codex.lnk'

$manifest = if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
}
else { $null }
$state = if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
}
else { $null }
$port = if ($manifest) { [int]$manifest.port } else { 0 }
$listener = if ($port -gt 0) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
}
else { $null }

[pscustomobject]@{
    schema = 1
    product = 'Neon Tides for Codex'
    installed = $null -ne $manifest
    install_root = $installDirectory
    startup_link_exists = Test-Path -LiteralPath $startupLink -PathType Leaf
    disabled = Test-Path -LiteralPath (Join-Path $installDirectory 'disabled.flag') -PathType Leaf
    port = $port
    loopback_listener = [bool]($listener -and @($listener | Where-Object LocalAddress -eq '127.0.0.1').Count -gt 0)
    manager_status = if ($state) { [string]$state.status } else { 'not-running' }
    manager_detail = if ($state) { [string]$state.detail } else { '' }
    last_update = if ($state) { [string]$state.updated_at } else { $null }
} | ConvertTo-Json -Depth 5

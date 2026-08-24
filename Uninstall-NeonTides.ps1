[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [switch]$Purge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'NeonTidesForCodex'
}
$installDirectory = [IO.Path]::GetFullPath($InstallRoot)
$manifestPath = Join-Path $installDirectory 'install-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'NEON_TIDES_INSTALL_MANIFEST_NOT_FOUND'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]$manifest.product -ne 'Neon Tides for Codex' -or [string]$manifest.install_root -ne $installDirectory) {
    throw 'INSTALL_MANIFEST_MISMATCH'
}

$port = [int]$manifest.port
$managerPath = Join-Path $installDirectory 'neon-tides-manager.ps1'
$probePath = Join-Path $installDirectory 'neon-tides-compat-probe.ps1'
$disabledPath = Join-Path $installDirectory 'disabled.flag'
$startupLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Neon Tides for Codex.lnk'
$resultPath = Join-Path $installDirectory "restore-result-$(Get-Date -Format 'yyyyMMddTHHmmssfff').json"
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

[IO.File]::WriteAllText($disabledPath, 'disabled', [Text.UTF8Encoding]::new($false))

if (Test-Path -LiteralPath $startupLink -PathType Leaf) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupLink)
    $owned = [string]$shortcut.Arguments -like "*$managerPath*" -and
        [string]$shortcut.Description -like "*$($manifest.install_id)*"
    if ($owned) {
        Remove-Item -LiteralPath $startupLink -Force
    }
}

foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $commandLine = [string]$process.CommandLine
    if (
        [int]$process.ProcessId -ne $PID -and
        -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($managerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
        try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch { }
    }
}

if (Test-Path -LiteralPath $probePath -PathType Leaf) {
    & $powershellPath `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $probePath `
        -Mode Restore `
        -ResultPath $resultPath `
        -Port $port
}

$restore = if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
    Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
}
else { $null }

$purged = $false
if ($Purge) {
    $defaultDirectory = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NeonTidesForCodex'))
    if (-not $installDirectory.Equals($defaultDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'PURGE_REFUSED_FOR_NON_DEFAULT_INSTALL_ROOT'
    }

    $ownedFiles = @(
        'background.mp4',
        'disabled.flag',
        'inject-neon-tides.mjs',
        'install-manifest.json',
        'launch-neon-tides-runtime.ps1',
        'neon-tides-compat-probe.ps1',
        'neon-tides-manager.ps1',
        'neon-tides.css',
        'run-neon-injector-worker.ps1'
    )
    foreach ($name in $ownedFiles) {
        $path = Join-Path $installDirectory $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
    foreach ($pattern in @(
        'health-result-*.json',
        'injection-result-*.json',
        'launch-ready-*.json',
        'launch-result-*.json',
        'manager-state.json',
        'repair-result-*.json',
        'restore-result-*.json',
        'runtime-launch-*.json',
        'watchdog-ready-*.json'
    )) {
        foreach ($item in @(Get-ChildItem -LiteralPath $installDirectory -Filter $pattern -File -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $item.FullName -Force
        }
    }
    if (@(Get-ChildItem -LiteralPath $installDirectory -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $installDirectory -Force
    }
    $purged = $true
}

[pscustomobject]@{
    schema = 1
    product = 'Neon Tides for Codex'
    disabled = $true
    startup_link_removed = -not (Test-Path -LiteralPath $startupLink -PathType Leaf)
    restore_attempted = $null -ne $restore
    restore_ok = if ($restore) { [bool]$restore.restore_ok } else { $false }
    files_purged = $purged
    install_root = $installDirectory
} | ConvertTo-Json -Depth 5

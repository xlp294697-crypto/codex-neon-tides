[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BackgroundVideo,
    [Parameter(Mandatory)][string]$NodePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sandbox = [IO.Path]::GetFullPath((Join-Path $repositoryRoot '.install-smoke-sandbox'))
$expectedSandbox = [IO.Path]::GetFullPath((Join-Path $repositoryRoot '.install-smoke-sandbox'))
if (-not $sandbox.Equals($expectedSandbox, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SMOKE_SANDBOX_PATH_MISMATCH'
}
if (Test-Path -LiteralPath $sandbox) {
    throw 'SMOKE_SANDBOX_ALREADY_EXISTS'
}

$markerValue = [Guid]::NewGuid().ToString('D')
[void](New-Item -ItemType Directory -Path $sandbox)
$markerPath = Join-Path $sandbox '.neon-tides-smoke-test-marker'
[IO.File]::WriteAllText($markerPath, $markerValue, [Text.UTF8Encoding]::new($false))

$originalAppData = $env:APPDATA
$originalLocalAppData = $env:LOCALAPPDATA
try {
    $env:APPDATA = Join-Path $sandbox 'AppData\Roaming'
    $env:LOCALAPPDATA = Join-Path $sandbox 'AppData\Local'
    $installRoot = Join-Path $env:LOCALAPPDATA 'NeonTidesForCodex'
    $raw = & (Join-Path $repositoryRoot 'Install-NeonTides.ps1') `
        -BackgroundVideo $BackgroundVideo `
        -NodePath $NodePath `
        -InstallRoot $installRoot `
        -NoStart
    $installed = $raw | ConvertFrom-Json
    $manifestPath = Join-Path $installRoot 'install-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $linkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Neon Tides for Codex.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($linkPath)

    $checks = [ordered]@{
        installer_reported_success = [bool]$installed.installed
        all_installed_files_exist = @($installed.files | Where-Object { -not $_.exists }).Count -eq 0
        manifest_product_valid = [string]$manifest.product -eq 'Neon Tides for Codex'
        manifest_port_is_high = [int]$manifest.port -ge 49152
        installed_video_hash_matches = (
            (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $installRoot 'background.mp4')).Hash.ToLowerInvariant() -eq
            [string]$manifest.background_sha256
        )
        startup_shortcut_exists = Test-Path -LiteralPath $linkPath -PathType Leaf
        shortcut_targets_powershell = [IO.Path]::GetFileName([string]$link.TargetPath) -eq 'powershell.exe'
        shortcut_references_manager = [string]$link.Arguments -like '*neon-tides-manager.ps1*'
        shortcut_references_selected_port = [string]$link.Arguments -like ('*-Port ' + [int]$manifest.port + '*')
        manager_was_not_started = -not [bool]$installed.manager_started
        repository_contains_no_video = -not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'background.mp4'))
    }

    $probeStub = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Mode,
    [Parameter(Mandatory)][string]$ResultPath,
    [string]$ReadyPath,
    [int]$Port
)
$value = [ordered]@{
    schema = 1
    classification = 'RESTORE_NORMAL'
    restore_attempted = $true
    restore_ok = $true
}
[IO.File]::WriteAllText(
    $ResultPath,
    ($value | ConvertTo-Json -Compress),
    [Text.UTF8Encoding]::new($false)
)
'@
    [IO.File]::WriteAllText(
        (Join-Path $installRoot 'neon-tides-compat-probe.ps1'),
        $probeStub,
        [Text.UTF8Encoding]::new($false)
    )
    $uninstallRaw = & (Join-Path $repositoryRoot 'Uninstall-NeonTides.ps1') -InstallRoot $installRoot
    $uninstalled = $uninstallRaw | ConvertFrom-Json
    $checks.uninstaller_reported_disabled = [bool]$uninstalled.disabled
    $checks.uninstaller_restore_ok = [bool]$uninstalled.restore_ok
    $checks.uninstaller_removed_owned_shortcut = [bool]$uninstalled.startup_link_removed
    $checks.disabled_marker_exists = Test-Path -LiteralPath (Join-Path $installRoot 'disabled.flag') -PathType Leaf

    $passed = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value }).Count -eq 0
    [pscustomobject]@{
        schema = 1
        passed = $passed
        checks = $checks
    } | ConvertTo-Json -Depth 6
    if (-not $passed) { exit 1 }
}
finally {
    $env:APPDATA = $originalAppData
    $env:LOCALAPPDATA = $originalLocalAppData
    $markerMatches = (Test-Path -LiteralPath $markerPath -PathType Leaf) -and
        ((Get-Content -LiteralPath $markerPath -Raw) -eq $markerValue)
    if (
        $markerMatches -and
        $sandbox.Equals($expectedSandbox, [StringComparison]::OrdinalIgnoreCase) -and
        $sandbox.StartsWith($repositoryRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
    ) {
        Remove-Item -LiteralPath $sandbox -Recurse -Force
    }
}

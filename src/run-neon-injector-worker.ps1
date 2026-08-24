[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$InjectorPath,
    [Parameter(Mandatory)][string]$CssPath,
    [Parameter(Mandatory)][string]$BackgroundPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateRange(1024, 65535)][int]$Port = 9229,
    [ValidateRange(5, 90)][int]$WaitSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    foreach ($required in @($NodePath, $InjectorPath, $CssPath, $BackgroundPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw 'REQUIRED_FILE_MISSING'
        }
    }

    $nodeItem = Get-Item -LiteralPath $NodePath
    $nodeSignature = Get-AuthenticodeSignature -LiteralPath $nodeItem.FullName
    if (
        [string]$nodeSignature.Status -ne 'Valid' -or
        [string]$nodeSignature.SignerCertificate.Subject -notlike '*O=OpenJS Foundation*' -or
        [string]$nodeItem.VersionInfo.ProductName -ne 'Node.js'
    ) {
        throw 'NODE_SIGNATURE_NOT_TRUSTED'
    }

    $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
    if (-not $package) {
        throw 'CODEX_PACKAGE_NOT_FOUND'
    }
    $packageRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation).TrimEnd('\') + '\'
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        throw 'DEBUG_LISTENER_NOT_FOUND'
    }
    foreach ($listener in $listeners) {
        if ([string]$listener.LocalAddress -notin @('127.0.0.1', '::1')) {
            throw 'DEBUG_LISTENER_NOT_LOOPBACK'
        }
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$listener.OwningProcess)" -ErrorAction SilentlyContinue
        $ownerPath = [string]$owner.ExecutablePath
        if (
            -not $owner -or
            [string]::IsNullOrWhiteSpace($ownerPath) -or
            -not ([IO.Path]::GetFullPath($ownerPath)).StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase)
        ) {
            throw 'DEBUG_LISTENER_OWNER_MISMATCH'
        }
    }

    & $NodePath $InjectorPath "http://127.0.0.1:$Port" $CssPath $BackgroundPath $OutputPath $WaitSeconds
    if ($LASTEXITCODE -ne 0) {
        throw "NODE_INJECTOR_EXIT_$LASTEXITCODE"
    }
}
catch {
    if (-not (Test-Path -LiteralPath $OutputPath)) {
        $fallback = [ordered]@{
            schema = 1
            theme = 'Neon Tides'
            classification = 'INJECTION_WORKER_FAILED'
            theme_applied = $false
            restore_ok = $false
            error_type = $_.Exception.GetType().Name
            finished_at = [DateTimeOffset]::Now.ToString('o')
        }
        $temporary = "$OutputPath.tmp.$PID"
        [IO.File]::WriteAllText(
            $temporary,
            ($fallback | ConvertTo-Json -Depth 5 -Compress),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
    }
}

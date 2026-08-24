[CmdletBinding()]
param(
    [string]$NodePath = '',
    [ValidateRange(1024, 65535)][int]$Port = 9229,
    [ValidateRange(2, 30)][int]$PollSeconds = 3,
    [ValidateRange(10, 120)][int]$HealthSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$themeDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$launcherPath = Join-Path $themeDirectory 'launch-neon-tides-runtime.ps1'
$workerPath = Join-Path $themeDirectory 'run-neon-injector-worker.ps1'
$injectorPath = Join-Path $themeDirectory 'inject-neon-tides.mjs'
$cssPath = Join-Path $themeDirectory 'neon-tides.css'
$backgroundPath = Join-Path $themeDirectory 'background.mp4'
$disabledPath = Join-Path $themeDirectory 'disabled.flag'
$statePath = Join-Path $themeDirectory 'manager-state.json'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:ResolvedNode = $null
$script:LastInjectionResult = ''

$mutexCreated = $false
$mutex = [Threading.Mutex]::new($true, 'Local\OpenAI-Codex-Neon-Tides-Manager', [ref]$mutexCreated)
if (-not $mutexCreated) {
    $mutex.Dispose()
    exit
}

function Write-ManagerState {
    param(
        [Parameter(Mandatory)][string]$Status,
        [string]$Detail = '',
        [string]$InjectionResult = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($InjectionResult)) {
        $script:LastInjectionResult = $InjectionResult
    }
    $value = [ordered]@{
        schema = 1
        theme = 'Neon Tides'
        manager_pid = $PID
        port = $Port
        status = $Status
        detail = $Detail
        injection_result = $script:LastInjectionResult
        updated_at = [DateTimeOffset]::Now.ToString('o')
    }
    $temporary = "$statePath.tmp.$PID"
    [IO.File]::WriteAllText(
        $temporary,
        ($value | ConvertTo-Json -Depth 5 -Compress),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Test-Node22 {
    param([Parameter(Mandatory)][string]$Candidate)
    try {
        $item = Get-Item -LiteralPath $Candidate
        $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
        $versionText = (& $Candidate --version 2>$null | Select-Object -First 1)
        return (
            [string]$signature.Status -eq 'Valid' -and
            [string]$signature.SignerCertificate.Subject -like '*O=OpenJS Foundation*' -and
            [string]$item.VersionInfo.ProductName -eq 'Node.js' -and
            $versionText -match '^v(?<major>\d+)\.' -and
            [int]$Matches.major -ge 22
        )
    }
    catch { return $false }
}

function Resolve-NodeExecutable {
    if ($script:ResolvedNode -and (Test-Path -LiteralPath $script:ResolvedNode -PathType Leaf)) {
        return $script:ResolvedNode
    }

    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($NodePath) -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        $candidates.Add([IO.Path]::GetFullPath($NodePath))
    }
    foreach ($portable in @(
        (Join-Path $themeDirectory 'runtime\node.exe'),
        (Join-Path (Split-Path -Parent $themeDirectory) 'runtime\node.exe')
    )) {
        if (Test-Path -LiteralPath $portable -PathType Leaf) {
            $candidates.Add([IO.Path]::GetFullPath($portable))
        }
    }

    $runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes'
    if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
        $preferred = Join-Path $runtimeRoot 'codex-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $preferred -PathType Leaf) {
            $candidates.Add([IO.Path]::GetFullPath($preferred))
        }
        foreach ($candidate in @(
            Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\dependencies\\node\\bin\\node\.exe$' } |
                Sort-Object LastWriteTime -Descending
        )) {
            $candidates.Add($candidate.FullName)
        }
    }

    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($systemNode) {
        $candidates.Add([IO.Path]::GetFullPath($systemNode.Source))
    }

    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if (Test-Node22 -Candidate $candidate) {
            $script:ResolvedNode = $candidate
            return $candidate
        }
    }
    throw 'TRUSTED_NODE_22_OR_NEWER_NOT_FOUND'
}

function Get-CodexRootProcess {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
    if (-not $package) {
        return $null
    }
    $packageRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation).TrimEnd('\') + '\'
    $executableName = 'ChatGPT.exe'
    try {
        $manifest = Get-AppxPackageManifest -Package $package
        $application = @($manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' } | Select-Object -First 1)
        if ($application.Count -eq 0) {
            $application = @($manifest.Package.Applications.Application | Select-Object -First 1)
        }
        if ($application.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$application[0].Executable)) {
            $candidateName = [IO.Path]::GetFileName([string]$application[0].Executable)
            if ($candidateName -match '^[A-Za-z0-9_.-]+\.exe$') {
                $executableName = $candidateName
            }
        }
    }
    catch { }

    $roots = @(
        Get-CimInstance Win32_Process -Filter "Name='$executableName'" -ErrorAction SilentlyContinue |
            Where-Object {
                $executable = [string]$_.ExecutablePath
                $commandLine = [string]$_.CommandLine
                $executable -and
                $executable.StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase) -and
                -not $commandLine.Contains('--type=')
            }
    )
    if ($roots.Count -eq 1) {
        return $roots[0]
    }
    return $null
}

function Test-CompleteInjectionResult {
    param([Parameter(Mandatory)][object]$Injection)
    return (
        [string]$Injection.classification -eq 'APPLIED' -and
        [bool]$Injection.theme_applied -and
        [bool]$Injection.style_verified -and
        [bool]$Injection.background_verified -and
        [bool]$Injection.video_loop_verified -and
        [bool]$Injection.video_muted_verified -and
        [bool]$Injection.video_playback_verified
    )
}

function Invoke-ThemeLaunch {
    $resolvedNode = Resolve-NodeExecutable
    $raw = & $powershellPath `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $launcherPath `
        -NodePath $resolvedNode `
        -Port $Port
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$raw)) {
        throw 'THEME_LAUNCHER_FAILED'
    }
    $launch = $raw | ConvertFrom-Json
    $resultPath = [string]$launch.injection_result
    if ([string]::IsNullOrWhiteSpace($resultPath)) {
        throw 'INJECTION_RESULT_PATH_MISSING'
    }
    Write-ManagerState -Status 'injecting' -Detail 'Codex detected; applying Neon Tides.' -InjectionResult $resultPath
    $deadline = [DateTimeOffset]::Now.AddSeconds(145)
    while (-not (Test-Path -LiteralPath $resultPath) -and [DateTimeOffset]::Now -lt $deadline) {
        if (Test-Path -LiteralPath $disabledPath) {
            return $false
        }
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-Path -LiteralPath $resultPath)) {
        throw 'INJECTION_RESULT_TIMEOUT'
    }
    $injection = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if (Test-CompleteInjectionResult -Injection $injection) {
        Write-ManagerState -Status 'active' -Detail 'Neon Tides is active and verified.' -InjectionResult $resultPath
        return $true
    }
    throw 'INJECTION_NOT_APPLIED'
}

function Test-ThemeHealth {
    $resolvedNode = Resolve-NodeExecutable
    $resultPath = Join-Path $themeDirectory "health-result-$PID.json"
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        Remove-Item -LiteralPath $resultPath -Force
    }
    & $resolvedNode $injectorPath "http://127.0.0.1:$Port" $cssPath $backgroundPath $resultPath 12 verify
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        return $false
    }
    try {
        $health = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        return (
            [string]$health.classification -eq 'HEALTHY' -and
            [bool]$health.theme_applied -and
            [bool]$health.style_verified -and
            [bool]$health.background_verified -and
            [bool]$health.video_loop_verified -and
            [bool]$health.video_muted_verified -and
            [bool]$health.video_playback_verified
        )
    }
    catch { return $false }
}

function Invoke-ThemeRepair {
    $resolvedNode = Resolve-NodeExecutable
    $stamp = (Get-Date -Format 'yyyyMMddTHHmmssfff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $resultPath = Join-Path $themeDirectory "repair-result-$stamp.json"
    & $powershellPath `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $workerPath `
        -NodePath $resolvedNode `
        -InjectorPath $injectorPath `
        -CssPath $cssPath `
        -BackgroundPath $backgroundPath `
        -OutputPath $resultPath `
        -Port $Port `
        -WaitSeconds 75
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        return $false
    }
    try {
        $injection = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if (Test-CompleteInjectionResult -Injection $injection) {
            $script:LastInjectionResult = $resultPath
            return $true
        }
    }
    catch { }
    return $false
}

function Remove-OldRuntimeArtifacts {
    foreach ($pattern in @(
        'health-result-*.json',
        'injection-result-*.json',
        'launch-ready-*.json',
        'launch-result-*.json',
        'repair-result-*.json',
        'runtime-launch-*.json',
        'watchdog-ready-*.json'
    )) {
        $items = @(Get-ChildItem -LiteralPath $themeDirectory -Filter $pattern -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
        foreach ($item in @($items | Select-Object -Skip 8)) {
            try { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop } catch { }
        }
    }
}

try {
    foreach ($required in @(
        $launcherPath,
        $workerPath,
        $injectorPath,
        $cssPath,
        $backgroundPath,
        $powershellPath
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "REQUIRED_FILE_MISSING:$(Split-Path -Leaf $required)"
        }
    }
    [void](Resolve-NodeExecutable)
    Remove-OldRuntimeArtifacts
    Write-ManagerState -Status 'watching' -Detail 'Waiting for Codex.'

    $normalSeenAt = $null
    $retryAfter = [DateTimeOffset]::MinValue
    $nextHealthCheck = [DateTimeOffset]::MinValue
    while (-not (Test-Path -LiteralPath $disabledPath)) {
        $root = Get-CodexRootProcess
        if (-not $root) {
            $normalSeenAt = $null
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        $commandLine = [string]$root.CommandLine
        $debugMode = $commandLine.Contains("--remote-debugging-port=$Port") -and
            $commandLine.Contains('--remote-debugging-address=127.0.0.1')
        if ($debugMode) {
            $normalSeenAt = $null
            if ([DateTimeOffset]::Now -ge $nextHealthCheck) {
                try {
                    if (Test-ThemeHealth) {
                        Write-ManagerState -Status 'active' -Detail 'Neon Tides is active and verified.'
                    }
                    else {
                        Write-ManagerState -Status 'repairing' -Detail 'Theme state was missing; reinjecting in place.'
                        if (Invoke-ThemeRepair) {
                            Write-ManagerState -Status 'active' -Detail 'Neon Tides was repaired and verified.' -InjectionResult $script:LastInjectionResult
                        }
                        else {
                            Write-ManagerState -Status 'degraded' -Detail 'Theme repair failed; retrying later.'
                        }
                    }
                }
                catch {
                    Write-ManagerState -Status 'degraded' -Detail 'Theme health check failed; retrying later.'
                }
                $nextHealthCheck = [DateTimeOffset]::Now.AddSeconds($HealthSeconds)
                Remove-OldRuntimeArtifacts
            }
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        if ([DateTimeOffset]::Now -lt $retryAfter) {
            Start-Sleep -Seconds $PollSeconds
            continue
        }
        if (-not $normalSeenAt) {
            $normalSeenAt = [DateTimeOffset]::Now
            Start-Sleep -Seconds $PollSeconds
            continue
        }
        if (([DateTimeOffset]::Now - $normalSeenAt).TotalSeconds -lt 5) {
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        try {
            [void](Invoke-ThemeLaunch)
            $retryAfter = [DateTimeOffset]::Now.AddSeconds(20)
            $nextHealthCheck = [DateTimeOffset]::Now.AddSeconds($HealthSeconds)
            Remove-OldRuntimeArtifacts
        }
        catch {
            Write-ManagerState -Status 'backoff' -Detail 'Injection failed; automatic retry delayed.'
            $retryAfter = [DateTimeOffset]::Now.AddMinutes(5)
        }
        $normalSeenAt = $null
        Start-Sleep -Seconds $PollSeconds
    }
    Write-ManagerState -Status 'disabled' -Detail 'Manager disabled by marker.'
}
catch {
    try { Write-ManagerState -Status 'error' -Detail $_.Exception.GetType().Name } catch { }
}
finally {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}

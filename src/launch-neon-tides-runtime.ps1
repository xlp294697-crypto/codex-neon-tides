[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodePath,
    [ValidateRange(1024, 65535)][int]$Port = 9229
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$themeDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$workDirectory = Split-Path -Parent $themeDirectory
$probeScript = Join-Path $themeDirectory 'neon-tides-compat-probe.ps1'
if (-not (Test-Path -LiteralPath $probeScript -PathType Leaf)) {
    $probeScript = Join-Path $workDirectory 'neon-tides-compat-probe.ps1'
}
$workerScript = Join-Path $themeDirectory 'run-neon-injector-worker.ps1'
$injectorScript = Join-Path $themeDirectory 'inject-neon-tides.mjs'
$cssPath = Join-Path $themeDirectory 'neon-tides.css'
$backgroundPath = Join-Path $themeDirectory 'background.mp4'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

foreach ($required in @(
    $NodePath,
    $probeScript,
    $workerScript,
    $injectorScript,
    $cssPath,
    $backgroundPath,
    $powershellPath
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "REQUIRED_FILE_MISSING:$(Split-Path -Leaf $required)"
    }
}

function Start-DetachedPowerShell {
    param([Parameter(Mandatory)][string]$Arguments)
    $commandLine = '"' + $powershellPath + '" ' + $Arguments
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
    }
    if ([int]$created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) {
        throw "WMI_CREATE_FAILED:$($created.ReturnValue)"
    }
    return [int]$created.ProcessId
}

$stamp = (Get-Date -Format 'yyyyMMddTHHmmssfff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$injectionResult = Join-Path $themeDirectory "injection-result-$stamp.json"
$launchResult = Join-Path $themeDirectory "launch-result-$stamp.json"
$launchReady = Join-Path $themeDirectory "launch-ready-$stamp.json"
$watchdogReady = Join-Path $themeDirectory "watchdog-ready-$stamp.json"
$orchestrationResult = Join-Path $themeDirectory "runtime-launch-$stamp.json"

$watchdogArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle Hidden',
    '-ExecutionPolicy Bypass',
    "-File `"$probeScript`"",
    '-Mode Watchdog',
    "-ResultPath `"$injectionResult`"",
    "-ReadyPath `"$watchdogReady`"",
    "-Port $Port",
    '-WatchdogDelaySeconds 170'
) -join ' '
$watchdogPid = Start-DetachedPowerShell -Arguments $watchdogArguments

$readyDeadline = [DateTimeOffset]::Now.AddSeconds(12)
while (-not (Test-Path -LiteralPath $watchdogReady) -and [DateTimeOffset]::Now -lt $readyDeadline) {
    Start-Sleep -Milliseconds 150
}
if (-not (Test-Path -LiteralPath $watchdogReady)) {
    throw 'WATCHDOG_NOT_READY'
}

$launcherArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle Hidden',
    '-ExecutionPolicy Bypass',
    "-File `"$probeScript`"",
    '-Mode Launch',
    "-ResultPath `"$launchResult`"",
    "-ReadyPath `"$launchReady`"",
    "-Port $Port",
    '-InitialDelaySeconds 12',
    '-ProbeTimeoutSeconds 60'
) -join ' '
$launcherPid = Start-DetachedPowerShell -Arguments $launcherArguments

$launchDeadline = [DateTimeOffset]::Now.AddSeconds(105)
while (-not (Test-Path -LiteralPath $launchResult) -and [DateTimeOffset]::Now -lt $launchDeadline) {
    Start-Sleep -Milliseconds 200
}
if (-not (Test-Path -LiteralPath $launchResult)) {
    throw 'CDP_LAUNCH_RESULT_TIMEOUT'
}
$launchVerification = Get-Content -LiteralPath $launchResult -Raw | ConvertFrom-Json
if (
    [string]$launchVerification.classification -ne 'CDP_LAUNCH_READY' -or
    -not [bool]$launchVerification.raw_debug_address_seen -or
    -not [bool]$launchVerification.raw_debug_port_seen -or
    -not [bool]$launchVerification.loopback_listener_seen -or
    -not [bool]$launchVerification.listener_owned_by_package -or
    -not [bool]$launchVerification.cdp_version_valid -or
    -not [bool]$launchVerification.keep_debug_running
) {
    throw 'CDP_LAUNCH_NOT_VERIFIED'
}

$workerArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle Hidden',
    '-ExecutionPolicy Bypass',
    "-File `"$workerScript`"",
    "-NodePath `"$NodePath`"",
    "-InjectorPath `"$injectorScript`"",
    "-CssPath `"$cssPath`"",
    "-BackgroundPath `"$backgroundPath`"",
    "-OutputPath `"$injectionResult`"",
    "-Port $Port",
    '-WaitSeconds 75'
) -join ' '
$injectorPid = Start-DetachedPowerShell -Arguments $workerArguments

$state = [ordered]@{
    schema = 1
    theme = 'Neon Tides'
    launched = $true
    stamp = $stamp
    port = $Port
    watchdog_pid = $watchdogPid
    injector_pid = $injectorPid
    launcher_pid = $launcherPid
    injection_result = $injectionResult
    launch_result = $launchResult
    created_at = [DateTimeOffset]::Now.ToString('o')
}
$temporary = "$orchestrationResult.tmp.$PID"
[IO.File]::WriteAllText(
    $temporary,
    ($state | ConvertTo-Json -Depth 5 -Compress),
    [Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath $temporary -Destination $orchestrationResult -Force
$state | ConvertTo-Json -Depth 5 -Compress

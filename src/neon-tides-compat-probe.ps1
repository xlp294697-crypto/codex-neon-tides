[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Preflight', 'Probe', 'Watchdog', 'Launch', 'Restore')]
    [string]$Mode,

    [Parameter(Mandatory)]
    [string]$ResultPath,

    [string]$ReadyPath,

    [ValidateRange(1024, 65535)]
    [int]$Port = 9229,

    [ValidateRange(0, 30)]
    [int]$InitialDelaySeconds = 8,

    [ValidateRange(10, 90)]
    [int]$ProbeTimeoutSeconds = 45,

    [ValidateRange(30, 180)]
    [int]$WatchdogDelaySeconds = 100
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:TaskStage = 'initialize'
$script:TaskTouchedApp = $false
$script:TaskRestoreAttempted = $false
$script:TaskRestoreOk = $false
$script:TaskPackageContext = $null
$script:TaskKeepAppRunning = $false

function Write-AtomicJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        throw 'RESULT_PARENT_MISSING'
    }

    $temporary = "$Path.tmp.$PID"
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-ReadyMarker {
    if ([string]::IsNullOrWhiteSpace($ReadyPath)) {
        return
    }

    $marker = [ordered]@{
        ready = $true
        pid = $PID
        mode = $Mode
    }
    Write-AtomicJson -Path $ReadyPath -Value $marker
}

function Test-PathInsideRoot {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Root
    )

    try {
        $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        $normalizedCandidate = [IO.Path]::GetFullPath($Candidate)
        return $normalizedCandidate.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}

function Get-PackageContext {
    $packages = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop)
    if ($packages.Count -ne 1) {
        throw 'PACKAGE_COUNT_INVALID'
    }

    $package = $packages[0]
    if ([string]$package.Status -ne 'Ok') {
        throw 'PACKAGE_STATUS_INVALID'
    }
    if ([string]$package.SignatureKind -ne 'Store') {
        throw 'PACKAGE_SIGNATURE_KIND_INVALID'
    }
    if ([bool]$package.IsDevelopmentMode) {
        throw 'PACKAGE_DEVELOPMENT_MODE_UNEXPECTED'
    }

    $manifest = Get-AppxPackageManifest -Package $package -ErrorAction Stop
    $applications = @($manifest.Package.Applications.Application)
    if ($applications.Count -lt 1) {
        throw 'MANIFEST_APPLICATION_MISSING'
    }

    $application = $applications | Where-Object { [string]$_.Id -eq 'App' } | Select-Object -First 1
    if (-not $application) {
        throw 'MANIFEST_APP_ID_MISSING'
    }

    $root = [IO.Path]::GetFullPath([string]$package.InstallLocation).TrimEnd('\')
    $executableRelative = [string]$application.Executable
    $executable = [IO.Path]::GetFullPath((Join-Path $root $executableRelative))
    if (-not (Test-PathInsideRoot -Candidate $executable -Root $root)) {
        throw 'EXECUTABLE_OUTSIDE_PACKAGE'
    }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw 'EXECUTABLE_MISSING'
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $executable
    if ([string]$signature.Status -ne 'Valid') {
        throw 'EXECUTABLE_SIGNATURE_INVALID'
    }

    $family = [string]$package.PackageFamilyName
    $appId = [string]$application.Id
    $aumid = "$family!$appId"

    if ($family -ne 'OpenAI.Codex_2p2nqsd0c76g0' -or $aumid -ne 'OpenAI.Codex_2p2nqsd0c76g0!App') {
        throw 'PACKAGE_IDENTITY_UNEXPECTED'
    }

    [pscustomobject]@{
        Package = $package
        Name = [string]$package.Name
        Version = [string]$package.Version
        Root = $root
        Executable = $executable
        Aumid = $aumid
    }
}

function Get-PackageProcesses {
    param([Parameter(Mandatory)][object]$Context)

    $items = @()
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $path = [string]$process.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($path)) {
            continue
        }
        if (Test-PathInsideRoot -Candidate $path -Root $Context.Root) {
            $items += $process
        }
    }
    return $items
}

function Get-DebugFlagState {
    param([Parameter(Mandatory)][object]$Context)

    $rawAddress = $false
    $rawPort = $false
    $encoded = $false
    foreach ($process in @(Get-PackageProcesses -Context $Context)) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine.Contains('--remote-debugging-address=127.0.0.1')) {
            $rawAddress = $true
        }
        if ($commandLine.Contains("--remote-debugging-port=$Port")) {
            $rawPort = $true
        }
        if ($commandLine.Contains("remote-debugging-port%3D$Port") -or $commandLine.Contains("remote-debugging-port%3d$Port")) {
            $encoded = $true
        }
    }

    [pscustomobject]@{
        RawAddress = $rawAddress
        RawPort = $rawPort
        EncodedPort = $encoded
    }
}

function Get-PortState {
    param([Parameter(Mandatory)][object]$Context)

    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    $allLoopback = $true
    $allOwnedByPackage = $true
    $hasListener = $listeners.Count -gt 0

    foreach ($listener in $listeners) {
        if ([string]$listener.LocalAddress -notin @('127.0.0.1', '::1')) {
            $allLoopback = $false
        }

        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $owner -or [string]::IsNullOrWhiteSpace([string]$owner.ExecutablePath) -or -not (Test-PathInsideRoot -Candidate ([string]$owner.ExecutablePath) -Root $Context.Root)) {
            $allOwnedByPackage = $false
        }
    }

    [pscustomobject]@{
        HasListener = $hasListener
        AllLoopback = $allLoopback
        AllOwnedByPackage = $allOwnedByPackage
        ListenerCount = $listeners.Count
    }
}

function Stop-PackageProcessesSafely {
    param([Parameter(Mandatory)][object]$Context)

    $expectedExecutable = [IO.Path]::GetFullPath([string]$Context.Executable)
    foreach ($item in @(Get-PackageProcesses -Context $Context)) {
        $itemExecutable = [string]$item.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($itemExecutable)) {
            continue
        }
        if (-not ([IO.Path]::GetFullPath($itemExecutable)).Equals($expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $commandLine = [string]$item.CommandLine
        if ($commandLine.Contains('--type=')) {
            continue
        }
        try {
            $live = Get-Process -Id ([int]$item.ProcessId) -ErrorAction Stop
            if ($live.MainWindowHandle -ne 0) {
                [void]$live.CloseMainWindow()
            }
        }
        catch {
        }
    }

    for ($i = 0; $i -lt 40; $i++) {
        if (@(Get-PackageProcesses -Context $Context).Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    foreach ($item in @(Get-PackageProcesses -Context $Context)) {
        $pidToStop = [int]$item.ProcessId
        $recheck = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop" -ErrorAction SilentlyContinue
        if (-not $recheck) {
            continue
        }
        $path = [string]$recheck.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($path)) {
            continue
        }
        if (-not (Test-PathInsideRoot -Candidate $path -Root $Context.Root)) {
            continue
        }
        try {
            Stop-Process -Id $pidToStop -Force -ErrorAction Stop
        }
        catch {
        }
    }

    for ($i = 0; $i -lt 20; $i++) {
        if (@(Get-PackageProcesses -Context $Context).Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return (@(Get-PackageProcesses -Context $Context).Count -eq 0)
}

function Initialize-ActivationManager {
    if ('CodexNeonProbe.Launcher' -as [type]) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexNeonProbe
{
    [Flags]
    public enum ActivateOptions : uint
    {
        None = 0,
        DesignMode = 1,
        NoErrorUI = 2,
        NoSplashScreen = 4
    }

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager
    {
    }

    public static class Launcher
    {
        public static uint Activate(string appUserModelId, string arguments)
        {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            int hr = manager.ActivateApplication(
                appUserModelId,
                arguments ?? "",
                ActivateOptions.None,
                out processId);
            if (hr < 0)
                Marshal.ThrowExceptionForHR(hr);
            return processId;
        }
    }
}
'@
}

function Start-CodexViaAumid {
    param(
        [Parameter(Mandatory)][object]$Context,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Arguments
    )

    Initialize-ActivationManager
    return [uint32][CodexNeonProbe.Launcher]::Activate($Context.Aumid, $Arguments)
}

function Test-CdpVersion {
    param([Parameter(Mandatory)][object]$Context)

    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -Method Get -TimeoutSec 2
        $browser = [string]$version.Browser
        $protocol = [string]$version.'Protocol-Version'
        $socketText = [string]$version.webSocketDebuggerUrl
        if ([string]::IsNullOrWhiteSpace($browser) -or [string]::IsNullOrWhiteSpace($protocol) -or [string]::IsNullOrWhiteSpace($socketText)) {
            return [pscustomobject]@{ Valid = $false; BrowserPresent = -not [string]::IsNullOrWhiteSpace($browser); ProtocolPresent = -not [string]::IsNullOrWhiteSpace($protocol) }
        }

        $socket = [Uri]$socketText
        $hostOk = [string]$socket.Host -in @('127.0.0.1', 'localhost', '::1')
        $schemeOk = [string]$socket.Scheme -eq 'ws'
        $portOk = [int]$socket.Port -eq $Port
        $pathOk = [string]$socket.AbsolutePath -match '^/devtools/(browser|page)/[^/?#]+$'
        $authOk = [string]::IsNullOrWhiteSpace([string]$socket.UserInfo)
        $queryOk = [string]::IsNullOrWhiteSpace([string]$socket.Query) -and [string]::IsNullOrWhiteSpace([string]$socket.Fragment)

        [pscustomobject]@{
            Valid = ($hostOk -and $schemeOk -and $portOk -and $pathOk -and $authOk -and $queryOk)
            BrowserPresent = $true
            ProtocolPresent = $true
        }
    }
    catch {
        [pscustomobject]@{ Valid = $false; BrowserPresent = $false; ProtocolPresent = $false }
    }
}

function Test-CodexTargetAndDom {
    try {
        $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -Method Get -TimeoutSec 2)
        $managerCandidates = @()
        $fallbackCandidates = @()
        foreach ($entry in $targets) {
            $socketProperty = $entry.PSObject.Properties['webSocketDebuggerUrl']
            if (-not $socketProperty -or [string]::IsNullOrWhiteSpace([string]$socketProperty.Value)) {
                continue
            }
            try {
                $candidateSocket = [Uri]([string]$socketProperty.Value)
            }
            catch {
                continue
            }
            if ([string]$candidateSocket.Scheme -ne 'ws' -or [string]$candidateSocket.Host -notin @('127.0.0.1', 'localhost', '::1') -or [int]$candidateSocket.Port -ne $Port) {
                continue
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$candidateSocket.Query) -or -not [string]::IsNullOrWhiteSpace([string]$candidateSocket.Fragment) -or -not [string]::IsNullOrWhiteSpace([string]$candidateSocket.UserInfo)) {
                continue
            }
            if ([string]$candidateSocket.AbsolutePath -notmatch '^/devtools/(browser|page)/[^/?#]+$') {
                continue
            }

            $typeProperty = $entry.PSObject.Properties['type']
            $urlProperty = $entry.PSObject.Properties['url']
            $titleProperty = $entry.PSObject.Properties['title']
            $targetType = if ($typeProperty) { [string]$typeProperty.Value } else { '' }
            $targetUrl = if ($urlProperty) { [string]$urlProperty.Value } else { '' }
            $targetTitle = if ($titleProperty) { [string]$titleProperty.Value } else { '' }
            $managerMatch = $targetType -eq 'page' -and
            (
                $targetUrl.StartsWith('app:///') -or
                $targetUrl.Contains('codex') -or
                $targetTitle.Contains('Codex') -or
                $targetTitle.Contains('codex')
            )
            $candidate = [pscustomobject]@{
                Socket = $candidateSocket
                ManagerMatch = $managerMatch
            }
            if ($managerMatch) {
                $managerCandidates += $candidate
            }
            else {
                $fallbackCandidates += $candidate
            }
        }

        $orderedCandidates = @($managerCandidates) + @($fallbackCandidates)
        $anyProbeCompleted = $false
        foreach ($candidate in $orderedCandidates) {
            $client = [Net.WebSockets.ClientWebSocket]::new()
            $cancellation = [Threading.CancellationTokenSource]::new(3000)
            try {
                $client.ConnectAsync($candidate.Socket, $cancellation.Token).GetAwaiter().GetResult()
                $expression = "!!document.querySelector('.main-surface, .browser-main-surface, main.main-surface') && !!document.querySelector('.app-shell-left-panel, aside.app-shell-left-panel') && (!!document.querySelector('.composer-surface-chrome') || !!document.querySelector('[role=main]'))"
                $request = [ordered]@{
                    id = 1
                    method = 'Runtime.evaluate'
                    params = [ordered]@{
                        expression = $expression
                        returnByValue = $true
                    }
                } | ConvertTo-Json -Depth 6 -Compress
                $bytes = [Text.Encoding]::UTF8.GetBytes($request)
                $client.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancellation.Token).GetAwaiter().GetResult()

                while (-not $cancellation.IsCancellationRequested) {
                    $buffer = New-Object byte[] 65536
                    $stream = [IO.MemoryStream]::new()
                    do {
                        $received = $client.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cancellation.Token).GetAwaiter().GetResult()
                        if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                            break
                        }
                        $stream.Write($buffer, 0, $received.Count)
                    } while (-not $received.EndOfMessage)

                    if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                        break
                    }
                    $message = ([Text.Encoding]::UTF8.GetString($stream.ToArray())) | ConvertFrom-Json
                    $idProperty = $message.PSObject.Properties['id']
                    if (-not $idProperty -or [int]$idProperty.Value -ne 1) {
                        continue
                    }
                    $outerResult = $message.PSObject.Properties['result']
                    $innerResult = if ($outerResult) { $outerResult.Value.PSObject.Properties['result'] } else { $null }
                    $valueProperty = if ($innerResult) { $innerResult.Value.PSObject.Properties['value'] } else { $null }
                    if ($valueProperty) {
                        $anyProbeCompleted = $true
                        $passed = [bool]$valueProperty.Value
                        if ($passed) {
                            return [pscustomobject]@{
                                TargetFound = $true
                                ManagerTargetFound = $managerCandidates.Count -gt 0
                                FallbackUsed = -not [bool]$candidate.ManagerMatch
                                CandidateCount = $orderedCandidates.Count
                                DomProbePassed = $true
                                ProbeCompleted = $true
                            }
                        }
                        break
                    }
                }
            }
            catch {
            }
            finally {
                try { $client.Abort() } catch { }
                $cancellation.Dispose()
                $client.Dispose()
            }
        }

        return [pscustomobject]@{
            TargetFound = $orderedCandidates.Count -gt 0
            ManagerTargetFound = $managerCandidates.Count -gt 0
            FallbackUsed = $false
            CandidateCount = $orderedCandidates.Count
            DomProbePassed = $false
            ProbeCompleted = $anyProbeCompleted
        }
    }
    catch {
        return [pscustomobject]@{
            TargetFound = $false
            ManagerTargetFound = $false
            FallbackUsed = $false
            CandidateCount = 0
            DomProbePassed = $false
            ProbeCompleted = $false
        }
    }
}

function Start-NormalCodex {
    param([Parameter(Mandatory)][object]$Context)

    $started = $false
    try {
        [void](Start-CodexViaAumid -Context $Context -Arguments '')
        $started = $true
    }
    catch {
    }

    if (-not $started) {
        try {
            Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList "shell:AppsFolder\$($Context.Aumid)" -WindowStyle Hidden
            $started = $true
        }
        catch {
        }
    }

    if (-not $started) {
        try {
            Start-Process -FilePath $Context.Executable -WindowStyle Hidden
            $started = $true
        }
        catch {
        }
    }

    return $started
}

function Test-NormalRestored {
    param([Parameter(Mandatory)][object]$Context)

    $processes = @(Get-PackageProcesses -Context $Context)
    $rootPresent = $false
    $expectedExecutable = [IO.Path]::GetFullPath([string]$Context.Executable)
    foreach ($process in $processes) {
        $processExecutable = [string]$process.ExecutablePath
        if (
            -not [string]::IsNullOrWhiteSpace($processExecutable) -and
            ([IO.Path]::GetFullPath($processExecutable)).Equals($expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            -not ([string]$process.CommandLine).Contains('--type=')
        ) {
            $rootPresent = $true
            break
        }
    }
    $flags = Get-DebugFlagState -Context $Context
    $portState = Get-PortState -Context $Context
    return ($rootPresent -and -not $flags.RawAddress -and -not $flags.RawPort -and -not ($portState.HasListener -and $portState.AllOwnedByPackage))
}

function Invoke-Watchdog {
    Write-ReadyMarker
    for ($i = 0; $i -lt $WatchdogDelaySeconds; $i++) {
        Start-Sleep -Seconds 1
    }

    if (Test-Path -LiteralPath $ResultPath) {
        try {
            $existing = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
            if ([bool]$existing.restore_ok) {
                return
            }
        }
        catch {
        }
    }

    $context = Get-PackageContext
    $flags = Get-DebugFlagState -Context $context
    $portState = Get-PortState -Context $context
    $processCount = @(Get-PackageProcesses -Context $context).Count
    $normalAlready = Test-NormalRestored -Context $context
    $needsRecovery = -not $normalAlready

    $restoreOk = $false
    if ($needsRecovery) {
        if ($processCount -gt 0 -and ($flags.RawAddress -or $flags.RawPort -or ($portState.HasListener -and $portState.AllOwnedByPackage))) {
            [void](Stop-PackageProcessesSafely -Context $context)
        }
        [void](Start-NormalCodex -Context $context)
        for ($i = 0; $i -lt 60; $i++) {
            if (Test-NormalRestored -Context $context) {
                $restoreOk = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
    }
    else {
        $restoreOk = Test-NormalRestored -Context $context
    }

    $watchdogResult = [ordered]@{
        schema = 1
        theme = 'Neon Tides'
        package = $context.Name
        version = $context.Version
        classification = 'WATCHDOG_RECOVERY'
        watchdog_used = $true
        restore_attempted = $needsRecovery
        restore_ok = $restoreOk
        finished_at = [DateTimeOffset]::Now.ToString('o')
    }
    Write-AtomicJson -Path $ResultPath -Value $watchdogResult
}

if ($Mode -eq 'Watchdog') {
    try {
        Invoke-Watchdog
    }
    catch {
        $fallback = [ordered]@{
            schema = 1
            theme = 'Neon Tides'
            classification = 'WATCHDOG_ERROR'
            watchdog_used = $true
            restore_attempted = $true
            restore_ok = $false
            error_stage = $script:TaskStage
            error_type = $_.Exception.GetType().Name
            finished_at = [DateTimeOffset]::Now.ToString('o')
        }
        try { Write-AtomicJson -Path $ResultPath -Value $fallback } catch { }
    }
    exit
}

if ($Mode -eq 'Restore') {
    $restoreResult = [ordered]@{
        schema = 1
        theme = 'Neon Tides'
        classification = 'RESTORE_NORMAL'
        restore_attempted = $false
        restore_ok = $false
        error_type = $null
        finished_at = $null
    }
    try {
        $context = Get-PackageContext
        Write-ReadyMarker
        if (-not (Test-NormalRestored -Context $context)) {
            $restoreResult.restore_attempted = $true
            [void](Stop-PackageProcessesSafely -Context $context)
            [void](Start-NormalCodex -Context $context)
        }
        for ($i = 0; $i -lt 80; $i++) {
            if (Test-NormalRestored -Context $context) {
                $restoreResult.restore_ok = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
    }
    catch {
        $restoreResult.error_type = $_.Exception.GetType().Name
    }
    finally {
        $restoreResult.finished_at = [DateTimeOffset]::Now.ToString('o')
        try { Write-AtomicJson -Path $ResultPath -Value $restoreResult } catch { }
    }
    exit
}

$result = [ordered]@{
    schema = 1
    theme = 'Neon Tides'
    package = $null
    version = $null
    aumid_verified = $false
    started_at = [DateTimeOffset]::Now.ToString('o')
    finished_at = $null
    probe_timeout_seconds = $ProbeTimeoutSeconds
    classification = 'NOT_RUN'
    activation_succeeded = $false
    activation_pid_returned = $false
    raw_debug_address_seen = $false
    raw_debug_port_seen = $false
    encoded_debug_port_seen = $false
    loopback_listener_seen = $false
    listener_owned_by_package = $false
    cdp_version_valid = $false
    page_target_found = $false
    manager_target_found = $false
    fallback_target_used = $false
    local_target_candidate_count = 0
    dom_probe_completed = $false
    dom_probe_passed = $false
    app_touched = $false
    restore_attempted = $false
    restore_ok = $false
    watchdog_used = $false
    keep_debug_running = $false
    error_stage = $null
    error_type = $null
    error_id = $null
}

try {
    $script:TaskStage = 'package_preflight'
    $context = Get-PackageContext
    $script:TaskPackageContext = $context
    $result.package = $context.Name
    $result.version = $context.Version
    $result.aumid_verified = $true

    $script:TaskStage = 'port_preflight'
    $initialPort = Get-PortState -Context $context
    if ($initialPort.HasListener) {
        $result.classification = 'ABORT_PORT_IN_USE'
        $script:TaskRestoreOk = Test-NormalRestored -Context $context
        return
    }

    Write-ReadyMarker

    if ($Mode -eq 'Preflight') {
        Initialize-ActivationManager
        $result.classification = 'PREFLIGHT_OK'
        $script:TaskRestoreOk = Test-NormalRestored -Context $context
        return
    }

    for ($i = 0; $i -lt $InitialDelaySeconds; $i++) {
        Start-Sleep -Seconds 1
    }

    $script:TaskStage = 'stop_normal_app'
    $script:TaskTouchedApp = $true
    $result.app_touched = $true
    if (-not (Stop-PackageProcessesSafely -Context $context)) {
        throw 'PACKAGE_STOP_TIMEOUT'
    }

    $script:TaskStage = 'activate_cdp'
    $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
    $activationPid = Start-CodexViaAumid -Context $context -Arguments $arguments
    $result.activation_succeeded = $true
    $result.activation_pid_returned = $activationPid -gt 0

    $deadline = [DateTimeOffset]::Now.AddSeconds($ProbeTimeoutSeconds)
    $versionValid = $false
    $unsafeBind = $false
    $ownerMismatch = $false
    while ([DateTimeOffset]::Now -lt $deadline) {
        $script:TaskStage = 'observe_cdp'
        $flags = Get-DebugFlagState -Context $context
        $result.raw_debug_address_seen = $result.raw_debug_address_seen -or $flags.RawAddress
        $result.raw_debug_port_seen = $result.raw_debug_port_seen -or $flags.RawPort
        $result.encoded_debug_port_seen = $result.encoded_debug_port_seen -or $flags.EncodedPort

        $portState = Get-PortState -Context $context
        if ($portState.HasListener) {
            if (-not $portState.AllLoopback) {
                $unsafeBind = $true
                break
            }
            if (-not $portState.AllOwnedByPackage) {
                $ownerMismatch = $true
                break
            }
            $result.loopback_listener_seen = $true
            $result.listener_owned_by_package = $true
            $versionState = Test-CdpVersion -Context $context
            if ($versionState.Valid) {
                $versionValid = $true
                $result.cdp_version_valid = $true
                break
            }
        }
        Start-Sleep -Milliseconds 500
    }

    if ($unsafeBind) {
        $result.classification = 'UNSAFE_BIND'
    }
    elseif ($ownerMismatch) {
        $result.classification = 'PORT_OWNER_MISMATCH'
    }
    elseif ($versionValid -and $Mode -eq 'Launch') {
        $result.classification = 'CDP_LAUNCH_READY'
        $result.keep_debug_running = $true
        $script:TaskKeepAppRunning = $true
    }
    elseif ($versionValid) {
        $script:TaskStage = 'probe_target_dom'
        while ([DateTimeOffset]::Now -lt $deadline -and -not $result.dom_probe_passed) {
            $targetState = Test-CodexTargetAndDom
            $result.page_target_found = $result.page_target_found -or $targetState.TargetFound
            $result.manager_target_found = $result.manager_target_found -or $targetState.ManagerTargetFound
            $result.fallback_target_used = $result.fallback_target_used -or $targetState.FallbackUsed
            $result.local_target_candidate_count = [Math]::Max([int]$result.local_target_candidate_count, [int]$targetState.CandidateCount)
            $result.dom_probe_completed = $result.dom_probe_completed -or $targetState.ProbeCompleted
            $result.dom_probe_passed = $result.dom_probe_passed -or $targetState.DomProbePassed
            if (-not $result.dom_probe_passed) {
                Start-Sleep -Milliseconds 500
            }
        }
        if (-not $result.page_target_found) {
            $result.classification = 'FAIL_TARGET'
        }
        elseif ($result.dom_probe_completed -and $result.dom_probe_passed) {
            $result.classification = 'PASS_FULL'
        }
        else {
            $result.classification = 'PASS_TRANSPORT_ONLY'
        }
    }
    elseif ($result.raw_debug_port_seen -or $result.raw_debug_address_seen) {
        $result.classification = 'FAIL_CDP_BIND'
    }
    elseif ($result.encoded_debug_port_seen) {
        $result.classification = 'FAIL_ARGUMENTS_IGNORED'
    }
    elseif (@(Get-PackageProcesses -Context $context).Count -eq 0) {
        $result.classification = 'APP_DID_NOT_START'
    }
    else {
        $result.classification = 'FAIL_ARGUMENTS_IGNORED'
    }
}
catch {
    if ($result.classification -eq 'NOT_RUN') {
        if ($script:TaskStage -eq 'activate_cdp') {
            $result.classification = 'ACTIVATION_FAILED'
        }
        else {
            $result.classification = 'PROBE_ERROR'
        }
    }
    $result.error_stage = $script:TaskStage
    $result.error_type = $_.Exception.GetType().Name
    $result.error_id = [string]$_.FullyQualifiedErrorId
}
finally {
    if ($script:TaskTouchedApp -and $script:TaskPackageContext -and -not $script:TaskKeepAppRunning) {
        $script:TaskRestoreAttempted = $true
        $result.restore_attempted = $true
        $script:TaskStage = 'restore_normal_app'
        try {
            [void](Stop-PackageProcessesSafely -Context $script:TaskPackageContext)
            [void](Start-NormalCodex -Context $script:TaskPackageContext)
            for ($i = 0; $i -lt 60; $i++) {
                if (Test-NormalRestored -Context $script:TaskPackageContext) {
                    $script:TaskRestoreOk = $true
                    break
                }
                Start-Sleep -Milliseconds 250
            }
        }
        catch {
            $script:TaskRestoreOk = $false
            if (-not $result.error_type) {
                $result.error_stage = 'restore_normal_app'
                $result.error_type = $_.Exception.GetType().Name
                $result.error_id = [string]$_.FullyQualifiedErrorId
            }
        }
    }

    $result.restore_attempted = $script:TaskRestoreAttempted
    $result.restore_ok = $script:TaskRestoreOk
    $result.app_touched = $script:TaskTouchedApp
    $result.finished_at = [DateTimeOffset]::Now.ToString('o')
    try { Write-AtomicJson -Path $ResultPath -Value $result } catch { }
}

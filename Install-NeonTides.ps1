[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [Alias('BackgroundPath', 'Video')]
    [string]$BackgroundVideo,

    [ValidateScript({ $_ -eq 0 -or ($_ -ge 1024 -and $_ -le 65535) })]
    [int]$Port = 0,

    [string]$NodePath = '',

    [string]$InstallRoot = '',

    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$releaseVersion = '1.0.0'
$sourceDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'src'))
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'NeonTidesForCodex'
}
$installDirectory = [IO.Path]::GetFullPath($InstallRoot)
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startupLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Neon Tides for Codex.lnk'

function Resolve-BackgroundVideo {
    $item = Get-Item -LiteralPath $BackgroundVideo -ErrorAction Stop
    if (-not $item.PSIsContainer -and $item.Length -ge 1KB -and $item.Length -le 64MB) {
        $stream = [IO.File]::OpenRead($item.FullName)
        try {
            $header = [byte[]]::new(12)
            $read = $stream.Read($header, 0, $header.Length)
        }
        finally {
            $stream.Dispose()
        }
        if ($read -eq 12 -and [Text.Encoding]::ASCII.GetString($header, 4, 4) -eq 'ftyp') {
            return $item
        }
    }
    throw 'BACKGROUND_MUST_BE_MP4_BETWEEN_1KB_AND_64MB'
}

function Resolve-CompatibleNode {
    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($NodePath) -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        $candidates.Add([IO.Path]::GetFullPath($NodePath))
    }
    $portable = Join-Path $PSScriptRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $portable -PathType Leaf) {
        $candidates.Add([IO.Path]::GetFullPath($portable))
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
        try {
            $item = Get-Item -LiteralPath $candidate
            $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
            $versionText = (& $candidate --version 2>$null | Select-Object -First 1)
            if (
                [string]$signature.Status -eq 'Valid' -and
                [string]$signature.SignerCertificate.Subject -like '*O=OpenJS Foundation*' -and
                [string]$item.VersionInfo.ProductName -eq 'Node.js' -and
                $versionText -match '^v(?<major>\d+)\.' -and
                [int]$Matches.major -ge 22
            ) {
                return [pscustomobject]@{
                    path = $candidate
                    version = $versionText
                }
            }
        }
        catch { }
    }
    throw 'TRUSTED_NODE_22_OR_NEWER_NOT_FOUND'
}

function Get-FreeLoopbackPort {
    if ($Port -ne 0) {
        $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($existing) {
            throw "PORT_ALREADY_IN_USE:$Port"
        }
        return $Port
    }

    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $candidate = Get-Random -Minimum 49152 -Maximum 65535
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        try {
            $listener.Start()
            return $candidate
        }
        catch { }
        finally {
            try { $listener.Stop() } catch { }
        }
    }
    throw 'NO_FREE_LOOPBACK_PORT_FOUND'
}

function Stop-ExistingManager {
    param([Parameter(Mandatory)][string]$ManagerPath)

    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        if (
            [int]$process.ProcessId -ne $PID -and
            -not [string]::IsNullOrWhiteSpace($commandLine) -and
            $commandLine.IndexOf($ManagerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        ) {
            try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch { }
        }
    }
}

function Start-DetachedManager {
    param(
        [Parameter(Mandatory)][string]$ManagerPath,
        [Parameter(Mandatory)][int]$DebugPort,
        [Parameter(Mandatory)][string]$NodeExecutable
    )

    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
        $ManagerPath + '" -Port ' + $DebugPort + ' -NodePath "' + $NodeExecutable + '"'
    $commandLine = '"' + $powershellPath + '" ' + $arguments
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
    }
    if ([int]$created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) {
        throw "MANAGER_START_FAILED:$($created.ReturnValue)"
    }
    return [int]$created.ProcessId
}

$video = Resolve-BackgroundVideo
$node = Resolve-CompatibleNode
$selectedPort = Get-FreeLoopbackPort

$requiredFiles = @(
    'neon-tides.css',
    'inject-neon-tides.mjs',
    'run-neon-injector-worker.ps1',
    'launch-neon-tides-runtime.ps1',
    'neon-tides-manager.ps1',
    'neon-tides-compat-probe.ps1'
)
foreach ($name in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory $name) -PathType Leaf)) {
        throw "RELEASE_FILE_MISSING:$name"
    }
}
if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
    throw 'WINDOWS_POWERSHELL_NOT_FOUND'
}
if (-not (Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)) {
    throw 'MICROSOFT_STORE_CODEX_NOT_FOUND'
}

if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $installDirectory)
}
$managerPath = Join-Path $installDirectory 'neon-tides-manager.ps1'
Stop-ExistingManager -ManagerPath $managerPath

foreach ($name in $requiredFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $name) -Destination (Join-Path $installDirectory $name) -Force
}
Copy-Item -LiteralPath $video.FullName -Destination (Join-Path $installDirectory 'background.mp4') -Force

$disabledMarker = Join-Path $installDirectory 'disabled.flag'
if (Test-Path -LiteralPath $disabledMarker -PathType Leaf) {
    Remove-Item -LiteralPath $disabledMarker -Force
}

$installId = [Guid]::NewGuid().ToString('D')
$manifest = [ordered]@{
    schema = 1
    product = 'Neon Tides for Codex'
    version = $releaseVersion
    install_id = $installId
    install_root = $installDirectory
    port = $selectedPort
    background_file = 'background.mp4'
    background_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $video.FullName).Hash.ToLowerInvariant()
    node_version_at_install = $node.version
    installed_at = [DateTimeOffset]::Now.ToString('o')
}
$manifestPath = Join-Path $installDirectory 'install-manifest.json'
$manifestTemporary = "$manifestPath.tmp.$PID"
[IO.File]::WriteAllText(
    $manifestTemporary,
    ($manifest | ConvertTo-Json -Depth 5 -Compress),
    [Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath $manifestTemporary -Destination $manifestPath -Force

$shell = New-Object -ComObject WScript.Shell
$startupDirectory = Split-Path -Parent $startupLink
if (-not (Test-Path -LiteralPath $startupDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $startupDirectory -Force)
}
$shortcut = $shell.CreateShortcut($startupLink)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    $managerPath + '" -Port ' + $selectedPort + ' -NodePath "' + $node.path + '"'
$shortcut.WorkingDirectory = $installDirectory
$shortcut.Description = "Neon Tides for Codex ($installId)"
$shortcut.WindowStyle = 7
$shortcut.Save()

$managerPid = $null
if (-not $NoStart) {
    $managerPid = Start-DetachedManager -ManagerPath $managerPath -DebugPort $selectedPort -NodeExecutable $node.path
}

$verification = foreach ($name in $requiredFiles + @('background.mp4', 'install-manifest.json')) {
    $path = Join-Path $installDirectory $name
    [pscustomobject]@{
        name = $name
        exists = Test-Path -LiteralPath $path -PathType Leaf
        sha256 = if (Test-Path -LiteralPath $path -PathType Leaf) {
            (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
        }
        else { $null }
    }
}

[pscustomobject]@{
    schema = 1
    product = 'Neon Tides for Codex'
    version = $releaseVersion
    installed = $true
    install_root = $installDirectory
    startup_link = $startupLink
    startup_link_exists = Test-Path -LiteralPath $startupLink -PathType Leaf
    port = $selectedPort
    node_version = $node.version
    manager_started = -not $NoStart
    manager_pid = $managerPid
    restart_codex_to_apply = $true
    files = $verification
} | ConvertTo-Json -Depth 6

[CmdletBinding()]
param(
  [string]$TaskName = 'JiuyueSportsWebsite',
  [string]$RunAsUser,
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请右键 PowerShell 选择“以管理员身份运行”，再执行此脚本。'
}

function Resolve-NodeExecutable([string]$RequestedPath) {
  $candidates = [Collections.Generic.List[string]]::new()
  if ($RequestedPath) {
    $candidates.Add($RequestedPath)
  } else {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if ($nodeCommand) { $candidates.Add($nodeCommand.Source) }
    $candidates.Add("$env:ProgramFiles\nodejs\node.exe")
    if (${env:ProgramFiles(x86)}) { $candidates.Add("${env:ProgramFiles(x86)}\nodejs\node.exe") }
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $resolved = (Resolve-Path -LiteralPath $candidate).ProviderPath
    $versionText = & $resolved -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0) { continue }
    $major = 0
    if ([int]::TryParse(($versionText | Out-String).Trim(), [ref]$major) -and $major -ge 20) {
      return $resolved
    }
  }

  if ($RequestedPath) { throw "指定的 Node.js 不存在、无法执行或低于 20：$RequestedPath" }
  throw '未找到可由计划任务使用的 Node.js 20 或更高版本。请安装系统级 Node.js LTS，或使用 -NodePath 指定稳定的 node.exe 绝对路径。'
}

function Invoke-PrivateAcl([string]$Path, [string]$RunAsSid, [string]$Mode, [switch]$Recurse) {
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) { throw '未找到 Windows ACL 工具 icacls.exe。' }
  $arguments = @($Path, '/inheritance:r', '/grant:r', "*${RunAsSid}:$Mode", '*S-1-5-18:(F)', '*S-1-5-32-544:(F)')
  if ($Recurse) { $arguments += @('/T', '/C') }
  & $icacls @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "无法为路径设置私有 ACL：$Path" }
}

$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ($projectRoot.StartsWith('\\')) {
  throw 'S4U 计划任务不能依赖网络共享。请把程序放在服务器本地磁盘。'
}
$startScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Start-Windows.ps1'))
$environmentFile = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) { throw '缺少 .env，请先运行 Initialize-Config.ps1。' }
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw "启动脚本不存在：$startScript" }

$resolvedNode = Resolve-NodeExecutable $NodePath
if ($resolvedNode.StartsWith('\\')) { throw 'Node.js 必须安装在服务器本地磁盘。' }

if (-not $RunAsUser) { $RunAsUser = $identity.Name }
try {
  $account = [Security.Principal.NTAccount]::new($RunAsUser)
  $runAsSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
} catch {
  throw "无法解析计划任务账户：$RunAsUser"
}
if ($runAsSid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) {
  throw '请使用普通本地或域用户账户；不得使用 SYSTEM、LOCAL SERVICE 或 NETWORK SERVICE。'
}

$dataDirectory = Join-Path $projectRoot 'data'
$backupDirectory = Join-Path $projectRoot 'backups'
[IO.Directory]::CreateDirectory($dataDirectory) | Out-Null
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
Invoke-PrivateAcl -Path $environmentFile -RunAsSid $runAsSid -Mode '(R)'
Invoke-PrivateAcl -Path $dataDirectory -RunAsSid $runAsSid -Mode '(OI)(CI)(M)' -Recurse
Invoke-PrivateAcl -Path $backupDirectory -RunAsSid $runAsSid -Mode '(OI)(CI)(M)' -Recurse

$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $projectRoot '/grant' "*${runAsSid}:(OI)(CI)(RX)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法授予计划任务账户读取程序目录的权限：$projectRoot" }
$nodeDirectory = Split-Path -Parent $resolvedNode
& $icacls $nodeDirectory '/grant' "*${runAsSid}:(OI)(CI)(RX)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法授予计划任务账户读取 Node.js 的权限：$nodeDirectory" }

$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw '未找到系统 PowerShell。' }
$actionArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$startScript`" -NodePath `"$resolvedNode`""
$action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $actionArguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description '氿悦体育独立站生产服务（低权限 S4U）' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "已安装并启动 Windows 开机任务：$TaskName"
Write-Host "运行账户：$RunAsUser（S4U、Limited，不保存密码）"
Write-Host "固定 Node.js：$resolvedNode"

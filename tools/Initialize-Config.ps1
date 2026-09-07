[CmdletBinding()]
param(
  [string]$NodePath,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $projectRoot '.env'

if ((Test-Path -LiteralPath $environmentFile) -and -not $Force) {
  throw ".env 已存在。若确需重新生成并使现有后台会话失效，请使用 -Force。"
}

if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}
if (-not $NodePath) {
  $nodeCandidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $NodePath = $nodeCandidates | Select-Object -First 1
}
if ($NodePath -and (Test-Path -LiteralPath $NodePath)) {
  $nodeMajor = [int]((& $NodePath -p "process.versions.node.split('.')[0]").Trim())
  if ($nodeMajor -lt 20) { $NodePath = $null }
}
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$useDockerGenerator = -not $NodePath -or -not (Test-Path -LiteralPath $NodePath)
if ($useDockerGenerator -and -not $dockerCommand) {
  throw '未找到 Node.js 或 Docker。请安装其中之一；原生 Windows 运行网站需要 Node.js 20 或更高版本。'
}

function ConvertFrom-SecureText([Security.SecureString]$SecureText) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureText)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$securePassword = Read-Host '设置后台管理员密码（16-250位，至少三类字符，不会显示）' -AsSecureString
$secureConfirmation = Read-Host '再次输入后台管理员密码' -AsSecureString
$plainPassword = ConvertFrom-SecureText $securePassword
$plainConfirmation = ConvertFrom-SecureText $secureConfirmation
try {
  if ($plainPassword -cne $plainConfirmation) { throw '两次输入的密码不一致。' }
  if ($useDockerGenerator) {
    $mount = "${projectRoot}:/app:ro"
    $generatedText = $plainPassword | & $dockerCommand.Source run --rm -i -v $mount -w /app node:24-alpine3.24 node tools/generate-secrets.mjs --json
  } else {
    $generator = Join-Path $PSScriptRoot 'generate-secrets.mjs'
    $generatedText = $plainPassword | & $NodePath $generator --json
  }
  if ($LASTEXITCODE -ne 0) { throw '安全配置生成失败。' }
  $generated = $generatedText | ConvertFrom-Json
} finally {
  $plainPassword = $null
  $plainConfirmation = $null
}

$settings = @(
  'NODE_ENV=production',
  'REPORT_TIME_ZONE=Asia/Shanghai',
  'SITE_DOMAIN=replace.example.com',
  'ICP_NUMBER=',
  'HOST=127.0.0.1',
  'PORT=3002',
  'APP_BIND_IP=127.0.0.1',
  'DATA_PATH=./data/site-data.json',
  'MAX_BODY_BYTES=65536',
  'EVENT_RETENTION_DAYS=180',
  'MAX_EVENT_RECORDS=25000',
  'MAX_INQUIRY_RECORDS=10000',
  'BACKUP_RETENTION_DAYS=90',
  'SESSION_HOURS=8',
  'TRUST_PROXY=true',
  'COOKIE_SECURE=true',
  'ENABLE_HSTS=false',
  "ADMIN_PASSWORD_HASH=$($generated.ADMIN_PASSWORD_HASH)",
  "SESSION_SECRET=$($generated.SESSION_SECRET)"
)
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllLines($environmentFile, $settings, $utf8NoBom)
$dataDirectory = Join-Path $projectRoot 'data'
$backupDirectory = Join-Path $projectRoot 'backups'
[IO.Directory]::CreateDirectory($dataDirectory) | Out-Null
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& $icacls $environmentFile '/inheritance:r' '/grant:r' "*${currentSid}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法收紧 .env 的 Windows ACL。请把程序放在支持 ACL 的本地磁盘。' }
foreach ($privateDirectory in @($dataDirectory, $backupDirectory)) {
  & $icacls $privateDirectory '/inheritance:r' '/grant:r' "*${currentSid}:(OI)(CI)(F)" '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '/T' '/C' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "无法收紧目录 ACL：$privateDirectory" }
}
Write-Host "安全配置已写入：$environmentFile"
Write-Host '已限制 .env、data 和 backups 的 Windows ACL；不要发送、截图或放入公开仓库。'

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [string]$ComposeFile,
  [string]$HashFile,
  [switch]$SkipHashCheck,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Set-PrivateFileAcl([string]$Path) {
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & $icacls $Path '/inheritance:r' '/grant:r' "*${sid}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "无法收紧安全副本 ACL：$Path" }
}

function Assert-BackupHash([string]$DataFile, [string]$SidecarFile) {
  if (-not (Test-Path -LiteralPath $SidecarFile -PathType Leaf)) {
    throw "缺少 SHA-256 校验文件：$SidecarFile。只有在明确接受风险时才能使用 -SkipHashCheck。"
  }
  $hashText = Get-Content -LiteralPath $SidecarFile -Raw -Encoding UTF8
  $match = [regex]::Match($hashText, '(?im)^\s*([a-f0-9]{64})(?:\s+|$)')
  if (-not $match.Success) { throw "SHA-256 校验文件格式无效：$SidecarFile" }
  $expected = $match.Groups[1].Value.ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $DataFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $expected) { throw "SHA-256 不一致，拒绝恢复。期望 $expected，实际 $actual。" }
  Write-Host "SHA-256 校验通过：$actual"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ComposeFile) { $ComposeFile = Join-Path $projectRoot 'compose.yaml' }
$composeFull = [IO.Path]::GetFullPath($ComposeFile)
$backupFull = [IO.Path]::GetFullPath($BackupFile)
if (-not (Test-Path -LiteralPath $composeFull -PathType Leaf)) { throw "Compose 文件不存在：$composeFull" }
if (-not (Test-Path -LiteralPath $backupFull -PathType Leaf)) { throw "备份文件不存在：$backupFull" }
$docker = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue
if (-not $docker) { throw '未找到 Docker。' }

if (-not $SkipHashCheck) {
  if (-not $HashFile) { $HashFile = "$backupFull.sha256.txt" }
  Assert-BackupHash -DataFile $backupFull -SidecarFile ([IO.Path]::GetFullPath($HashFile))
} else {
  Write-Warning '已显式跳过 SHA-256 校验。'
}
$parsed = Get-Content -LiteralPath $backupFull -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $parsed.events -or $null -eq $parsed.inquiries) { throw '备份文件缺少 events 或 inquiries 数据结构。' }
if (-not $Force) {
  $answer = Read-Host '恢复会替换 Docker 数据卷。输入 RESTORE 继续'
  if ($answer -cne 'RESTORE') { throw '已取消恢复。' }
}

$containerId = (& $docker.Source compose -f $composeFull ps -a -q app | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $containerId) { throw '未找到 app 容器。请先至少执行一次 docker compose up -d。' }

$safetyDirectory = Join-Path $projectRoot 'backups'
[IO.Directory]::CreateDirectory($safetyDirectory) | Out-Null
$safetyCopy = Join-Path $safetyDirectory ("before-restore-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
& $docker.Source compose -f $composeFull cp 'app:/app/data/site-data.json' $safetyCopy
if ($LASTEXITCODE -ne 0) { throw '无法在恢复前创建当前 Docker 数据的安全副本。' }
$safetyHash = (Get-FileHash -LiteralPath $safetyCopy -Algorithm SHA256).Hash.ToLowerInvariant()
$safetyHashFile = "$safetyCopy.sha256.txt"
[IO.File]::WriteAllText($safetyHashFile, "$safetyHash  $([IO.Path]::GetFileName($safetyCopy))`n", [Text.UTF8Encoding]::new($false))
Set-PrivateFileAcl $safetyCopy
Set-PrivateFileAcl $safetyHashFile
Write-Host "当前 Docker 数据安全副本：$safetyCopy"

$temporaryName = ".restore-$([Guid]::NewGuid().ToString('N')).json"
$containerTemporary = "app:/app/data/$temporaryName"
$appStopped = $false
$restored = $false
try {
  $appStopped = $true
  & $docker.Source compose -f $composeFull stop app
  if ($LASTEXITCODE -ne 0) { throw '停止 app 容器失败。' }
  & $docker.Source compose -f $composeFull cp $backupFull $containerTemporary
  if ($LASTEXITCODE -ne 0) { throw '把备份复制到 Docker 数据卷失败。' }
  $moveCommand = "chown node:node '/app/data/$temporaryName' && chmod 600 '/app/data/$temporaryName' && mv -f '/app/data/$temporaryName' /app/data/site-data.json"
  & $docker.Source compose -f $composeFull run --rm --no-deps --user '0:0' --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --entrypoint sh app -c $moveCommand
  if ($LASTEXITCODE -ne 0) { throw '在 Docker 数据卷中替换数据失败。' }
  $restored = $true
} finally {
  if ($appStopped) {
    & $docker.Source compose -f $composeFull start app | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'app 容器没有成功重新启动，请立即检查 docker compose logs app。' }
  }
}
if (-not $restored) { throw 'Docker 恢复未完成；原数据安全副本已经保留。' }

$healthy = $false
for ($attempt = 1; $attempt -le 30; $attempt += 1) {
  & $docker.Source compose -f $composeFull exec -T app node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>$null
  if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $healthy) { throw '数据已替换，但 app 未在 60 秒内恢复健康。请检查日志，并使用安全副本回滚。' }
Write-Host 'Docker 数据恢复完成，app 健康检查通过。'

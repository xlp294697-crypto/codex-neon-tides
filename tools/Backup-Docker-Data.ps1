[CmdletBinding()]
param(
  [string]$ComposeFile,
  [string]$DestinationDirectory,
  [ValidateRange(1, 3650)][int]$RetentionDays = 90
)

$ErrorActionPreference = 'Stop'

function Set-PrivateFileAcl([string]$Path) {
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & $icacls $Path '/inheritance:r' '/grant:r' "*${sid}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "无法收紧备份文件 ACL：$Path。请只使用支持 Windows ACL 的本地加密磁盘。" }
}

function Remove-ExpiredBackups([string]$Directory, [int]$Days) {
  $root = [IO.Path]::GetPathRoot($Directory)
  if ($Directory.TrimEnd('\') -eq $root.TrimEnd('\')) { throw '拒绝在磁盘根目录执行备份轮换。' }
  $cutoff = [DateTime]::UtcNow.AddDays(-$Days)
  $pattern = '^(?:site-data(?:-docker)?|before-restore)-\d{8}-\d{6}(?:-\d+)?\.json(?:\.sha256\.txt)?$'
  $expired = @(Get-ChildItem -LiteralPath $Directory -File -ErrorAction Stop | Where-Object {
    $_.Name -match $pattern -and $_.LastWriteTimeUtc -lt $cutoff
  })
  foreach ($item in $expired) { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop }
  return $expired.Count
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ComposeFile) { $ComposeFile = Join-Path $projectRoot 'compose.yaml' }
$composeFull = [IO.Path]::GetFullPath($ComposeFile)
if (-not (Test-Path -LiteralPath $composeFull -PathType Leaf)) { throw "Compose 文件不存在：$composeFull" }
$docker = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue
if (-not $docker) { throw '未找到 Docker。' }
if (-not $DestinationDirectory) { $DestinationDirectory = Join-Path $projectRoot 'backups' }
$destination = [IO.Path]::GetFullPath($DestinationDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null

$backupFile = Join-Path $destination ("site-data-docker-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
& $docker.Source compose -f $composeFull cp 'app:/app/data/site-data.json' $backupFile
if ($LASTEXITCODE -ne 0) { throw 'Docker 数据复制失败。请确认 app 容器已经创建。' }
try {
  $parsed = Get-Content -LiteralPath $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  if ($null -eq $parsed.events -or $null -eq $parsed.inquiries) { throw '备份缺少 events 或 inquiries 数据结构。' }
} catch {
  Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
  throw "备份校验失败：$($_.Exception.Message)"
}

$hash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash.ToLowerInvariant()
$hashFile = "$backupFile.sha256.txt"
[IO.File]::WriteAllText($hashFile, "$hash  $([IO.Path]::GetFileName($backupFile))`n", [Text.UTF8Encoding]::new($false))
Set-PrivateFileAcl $backupFile
Set-PrivateFileAcl $hashFile
$removed = Remove-ExpiredBackups -Directory $destination -Days $RetentionDays

Write-Host "Docker 数据备份完成：$backupFile"
Write-Host "SHA-256：$hash"
Write-Host "轮换策略：保留 $RetentionDays 天，本次清理 $removed 个过期文件。"

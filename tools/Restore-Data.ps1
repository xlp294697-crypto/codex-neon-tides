[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BackupFile,
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
$dataDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot 'data'))
$targetFile = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'site-data.json'))
$backupFull = [IO.Path]::GetFullPath($BackupFile)
if (-not (Test-Path -LiteralPath $backupFull -PathType Leaf)) { throw "备份文件不存在：$backupFull" }

if (-not $SkipHashCheck) {
  if (-not $HashFile) { $HashFile = "$backupFull.sha256.txt" }
  Assert-BackupHash -DataFile $backupFull -SidecarFile ([IO.Path]::GetFullPath($HashFile))
} else {
  Write-Warning '已显式跳过 SHA-256 校验。'
}

$parsed = Get-Content -LiteralPath $backupFull -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $parsed.events -or $null -eq $parsed.inquiries) { throw '备份文件缺少 events 或 inquiries 数据结构。' }
if (-not $Force) {
  $answer = Read-Host '恢复会替换当前数据。请先停止网站服务，输入 RESTORE 继续'
  if ($answer -cne 'RESTORE') { throw '已取消恢复。' }
}

[IO.Directory]::CreateDirectory($dataDirectory) | Out-Null
$safetyDirectory = Join-Path $projectRoot 'backups'
[IO.Directory]::CreateDirectory($safetyDirectory) | Out-Null
if (Test-Path -LiteralPath $targetFile -PathType Leaf) {
  $safetyCopy = Join-Path $safetyDirectory ("before-restore-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  Copy-Item -LiteralPath $targetFile -Destination $safetyCopy -ErrorAction Stop
  $safetyHash = (Get-FileHash -LiteralPath $safetyCopy -Algorithm SHA256).Hash.ToLowerInvariant()
  $safetyHashFile = "$safetyCopy.sha256.txt"
  [IO.File]::WriteAllText($safetyHashFile, "$safetyHash  $([IO.Path]::GetFileName($safetyCopy))`n", [Text.UTF8Encoding]::new($false))
  Set-PrivateFileAcl $safetyCopy
  Set-PrivateFileAcl $safetyHashFile
  Write-Host "当前数据安全副本：$safetyCopy"
}

$temporary = Join-Path $dataDirectory (".restore-{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
try {
  Copy-Item -LiteralPath $backupFull -Destination $temporary -ErrorAction Stop
  Move-Item -LiteralPath $temporary -Destination $targetFile -Force -ErrorAction Stop
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Write-Host "数据已恢复：$targetFile"

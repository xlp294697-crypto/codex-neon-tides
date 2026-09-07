[CmdletBinding()]
param([string]$NodePath)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$environmentFile = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $environmentFile)) {
  throw '缺少 .env。请先运行 tools\Initialize-Config.ps1。'
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
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
  throw '未找到 Node.js 20 或更高版本。请安装 Node.js LTS，或通过 -NodePath 指定 node.exe。'
}
$nodeMajor = [int]((& $NodePath -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { throw "Node.js 版本过低（当前主版本 $nodeMajor），需要 20 或更高版本。" }

foreach ($rawLine in Get-Content -LiteralPath $environmentFile -Encoding UTF8) {
  $line = $rawLine.Trim()
  if (-not $line -or $line.StartsWith('#')) { continue }
  $separator = $line.IndexOf('=')
  if ($separator -lt 1) { throw ".env 中存在无效配置行。" }
  $name = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1)
  if ($name -notmatch '^[A-Z][A-Z0-9_]*$') { throw ".env 中存在无效配置名：$name" }
  [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

Set-Location -LiteralPath $projectRoot
& $NodePath (Join-Path $projectRoot 'server.mjs')
exit $LASTEXITCODE

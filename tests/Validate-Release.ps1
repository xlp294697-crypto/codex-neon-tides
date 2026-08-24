[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$failures = [Collections.Generic.List[string]]::new()

$requiredFiles = @(
    '.gitattributes',
    '.gitignore',
    'CHANGELOG.md',
    'Get-NeonTidesStatus.ps1',
    'Install-NeonTides.ps1',
    'LICENSE',
    'NOTICE.md',
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'Uninstall-NeonTides.ps1',
    'tests\Invoke-InstallSmokeTest.ps1',
    'src\inject-neon-tides.mjs',
    'src\launch-neon-tides-runtime.ps1',
    'src\neon-tides-compat-probe.ps1',
    'src\neon-tides-manager.ps1',
    'src\neon-tides.css',
    'src\run-neon-injector-worker.ps1'
)
foreach ($relative in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $relative) -PathType Leaf)) {
        $failures.Add("missing:$relative")
    }
}

$forbiddenExtensions = @('.mp4', '.mov', '.mkv', '.webm', '.webp', '.png', '.jpg', '.jpeg', '.lnk')
foreach ($item in @(Get-ChildItem -LiteralPath $repositoryRoot -File -Recurse -Force | Where-Object {
    $_.FullName -notmatch '\\.git\\' -and $_.Extension.ToLowerInvariant() -in $forbiddenExtensions
})) {
    $failures.Add("forbidden-binary:$($item.FullName.Substring($repositoryRoot.Length + 1))")
}

$textFiles = @(Get-ChildItem -LiteralPath $repositoryRoot -File -Recurse -Force | Where-Object {
    $_.FullName -notmatch '\\.git\\' -and $_.Extension.ToLowerInvariant() -in @('.ps1', '.mjs', '.css', '.md', '.yml', '.yaml', '.txt')
})
$forbiddenPatterns = @(
    'C:\\Users\\',
    ('LEN' + 'OVO'),
    ('hao' + 'wallpaper'),
    ('哲风' + '壁纸'),
    'BEGIN [A-Z ]+PRIVATE KEY',
    'ghp_[A-Za-z0-9]+',
    'github_pat_[A-Za-z0-9_]+'
)
foreach ($item in $textFiles) {
    $content = Get-Content -LiteralPath $item.FullName -Raw
    foreach ($pattern in $forbiddenPatterns) {
        if ($content -match $pattern) {
            $failures.Add("forbidden-text:$($item.FullName.Substring($repositoryRoot.Length + 1)):$pattern")
        }
    }
}

foreach ($script in @(Get-ChildItem -LiteralPath $repositoryRoot -Filter '*.ps1' -File -Recurse)) {
    try {
        [void][ScriptBlock]::Create((Get-Content -LiteralPath $script.FullName -Raw))
    }
    catch {
        $failures.Add("powershell-parse:$($script.FullName.Substring($repositoryRoot.Length + 1))")
    }
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    $runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes'
    $candidate = Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\dependencies\\node\\bin\\node\.exe$' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($candidate) { $node = $candidate }
}
if (-not $node) {
    $failures.Add('node-not-found-for-syntax-check')
}
else {
    $nodePath = if ($node.PSObject.Properties.Name -contains 'Source' -and $node.Source) {
        [string]$node.Source
    }
    else { [string]$node.FullName }
    & $nodePath --check (Join-Path $repositoryRoot 'src\inject-neon-tides.mjs')
    if ($LASTEXITCODE -ne 0) {
        $failures.Add('node-parse:src\inject-neon-tides.mjs')
    }
}

$css = Get-Content -LiteralPath (Join-Path $repositoryRoot 'src\neon-tides.css') -Raw
if ($css -notmatch '--codex-theme-id:\s*"neon-tides"') {
    $failures.Add('css-theme-marker-missing')
}
$manager = Get-Content -LiteralPath (Join-Path $repositoryRoot 'src\neon-tides-manager.ps1') -Raw
foreach ($requiredMarker in @('Test-ThemeHealth', 'Invoke-ThemeRepair', 'video_playback_verified')) {
    if ($manager -notmatch [regex]::Escape($requiredMarker)) {
        $failures.Add("manager-marker-missing:$requiredMarker")
    }
}

$result = [ordered]@{
    schema = 1
    repository = $repositoryRoot
    passed = $failures.Count -eq 0
    checked_files = $textFiles.Count
    failures = @($failures)
}
$result | ConvertTo-Json -Depth 5
if ($failures.Count -gt 0) { exit 1 }

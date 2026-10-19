<#
.SYNOPSIS
  组 3 收尾：restore 日常路径验证（源码保留 + 共享根无差异）。

.DESCRIPTION
  在 DeepSeek Harness 完全退出后，从外部 PowerShell / pwsh 运行：
    pwsh -NoProfile -ExecutionPolicy Bypass -File <GUARDIAN_ROOT>\scripts\group3-daily-restore-check.ps1

  注意：使用默认 restore（不带 --no-restart），因此 restore 成功后会重新启动 DSH。

  行为：
    0) 断言无 DeepSeek 进程，有则 ABORT（exit 2，不 kill）
    1) 在 <YOUR_LINK_PLUGIN> 新建 group3-daily-check-<ts>.txt（时间戳内容）
    2) node bin/guardian.mjs restore group3-base（默认参数），记录退出码
    3) 检查测试文件是否仍存在 → SOURCE_SAFETY
    4) 对比 restore 前后 profiles\node_modules 顶层条目 → SHARED_DIFF
    5) 清理测试文件与本次新增的 pre-restore-* 快照；不删 group3-base/manual-baseline/snap-a/snap-b
    6) RESULT 块 + logs\group3-daily-check-<ts>.log
  退出码：0 PASS / 2 ABORT / 3 FAIL
#>

[CmdletBinding()]
param(
  [string]$GuardianRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$SourceRoot = '',
  [string]$SharedRoot = '',
  [string]$BaselineDir = (Join-Path $GuardianRoot 'manual-baseline')
)

$ErrorActionPreference = 'Stop'
# --- 本地配置推导：优先 config.local.json（本机私有，不入库），回退 config.json（占位符模板）---
$__cfgPath = Join-Path $GuardianRoot 'config.local.json'
if (-not (Test-Path -LiteralPath $__cfgPath)) { $__cfgPath = Join-Path $GuardianRoot 'config.json' }
if (Test-Path -LiteralPath $__cfgPath) {
  $__cfg = Get-Content -LiteralPath $__cfgPath -Raw | ConvertFrom-Json
  if (-not $SourceRoot -and $__cfg.trackedSourcePaths) { $SourceRoot = @($__cfg.trackedSourcePaths)[0] }
  if (-not $SharedRoot -and $__cfg.sharedDependencyRoots) { $SharedRoot = @($__cfg.sharedDependencyRoots)[0] }
}
$ProgressPreference = 'SilentlyContinue'

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $GuardianRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("group3-daily-check-$ts.log")
$GuardianBin = Join-Path $GuardianRoot 'bin\guardian.mjs'
$Backups = Join-Path $GuardianRoot 'backups'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$BaseSnap = 'group3-base'

$script:Results = [ordered]@{}
$script:Failures = New-Object System.Collections.Generic.List[string]

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
  [IO.File]::AppendAllText($LogPath, ($line + "`r`n"), $Utf8)
  Write-Host $line
}

function Add-Failure {
  param([string]$Item, [string]$Detail)
  $script:Failures.Add(("{0} :: {1}" -f $Item, $Detail)) | Out-Null
  Write-Log ("FAIL {0} :: {1}" -f $Item, $Detail) 'FAIL'
}

function Add-Pass {
  param([string]$Item, [string]$Detail = '')
  Write-Log ("PASS {0} {1}" -f $Item, $Detail)
}

function Write-ResultBlock {
  param([string]$Overall)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('RESULT_BEGIN')
  foreach ($key in $script:Results.Keys) { $lines.Add(('{0}={1}' -f $key, $script:Results[$key])) }
  $lines.Add(('failures={0}' -f $script:Failures.Count))
  foreach ($item in $script:Failures) { $lines.Add(('failure={0}' -f $item)) }
  $lines.Add(('overall={0}' -f $Overall))
  $lines.Add('RESULT_END')
  $block = $lines -join "`r`n"
  [IO.File]::AppendAllText($LogPath, ($block + "`r`n"), $Utf8)
  Write-Host ''
  Write-Host $block
}

function Get-SharedEntries {
  return @(Get-ChildItem -LiteralPath $SharedRoot -Force -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -ExpandProperty Name)
}

# ---------------------------------------------------------------- 0. gate
Write-Log ("guardian root : {0}" -f $GuardianRoot)
Write-Log ("log file      : {0}" -f $LogPath)
Write-Log ("host / time   : {0} / {1}" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'))

$dsProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
if ($dsProcs.Count -gt 0) {
  Write-Log ("检测到 {0} 个 DeepSeek 进程；按规则不 kill，脚本中止。" -f $dsProcs.Count) 'FAIL'
  $script:Results['gate_processes'] = $dsProcs.Count
  Write-ResultBlock 'ABORT'
  exit 2
}
$script:Results['gate_processes'] = 0
Add-Pass 'client-stopped' 'Get-Process 无 DeepSeek 进程'

$baseMetaPath = Join-Path $Backups "$BaseSnap\meta.json"
if (-not (Test-Path -LiteralPath $baseMetaPath)) {
  Add-Failure 'base-snapshot' ("缺失: " + $baseMetaPath)
  Write-ResultBlock 'FAIL'
  exit 3
}
if (-not (Test-Path -LiteralPath $SourceRoot)) { Add-Failure 'source-root' ("缺失: " + $SourceRoot) }
if (-not (Test-Path -LiteralPath $SharedRoot)) { Add-Failure 'shared-root' ("缺失: " + $SharedRoot) }

# ---------------------------------------------------------------- 1. source test file
$testName = "group3-daily-check-$ts.txt"
$testFile = Join-Path $SourceRoot $testName
[IO.File]::WriteAllText($testFile, ("group3 daily restore check @ " + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + "`r`n"), $Utf8)
Write-Log ("created source test file: {0}" -f $testFile)
$script:Results['source_test_file'] = $testName

$sharedBefore = Get-SharedEntries
Write-Log ("shared before: {0} entries" -f $sharedBefore.Count)
$script:Results['shared_before_count'] = $sharedBefore.Count

$preBefore = @(Get-ChildItem -LiteralPath $Backups -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'pre-restore-*' } | Select-Object -ExpandProperty Name)

# ---------------------------------------------------------------- 2. daily restore
Write-Log '执行默认 restore（注意：restore 成功后会重启 DSH）'
$sw = [Diagnostics.Stopwatch]::StartNew()
$output = & node $GuardianBin restore $BaseSnap 2>&1 | Out-String
$restoreExit = $LASTEXITCODE
$sw.Stop()
Write-Log ("[cmd] node guardian restore {0} -> exit={1} ({2}s)" -f $BaseSnap, $restoreExit, [int]$sw.Elapsed.TotalSeconds)
foreach ($line in ($output -split "`r?`n")) {
  if ($line.Trim().Length -gt 0) { [IO.File]::AppendAllText($LogPath, ("  | " + $line + "`r`n"), $Utf8) }
}
$script:Results['restore_exit'] = $restoreExit
if ($restoreExit -eq 0) { Add-Pass 'restore-exit' 'exit=0' } else { Add-Failure 'restore-exit' ("exit=" + $restoreExit) }

# ---------------------------------------------------------------- 3. source safety
$srcExists = Test-Path -LiteralPath $testFile
if ($srcExists) { Add-Pass 'source-safety' ($testName + ' 仍存在') }
else { Add-Failure 'source-safety' ($testName + ' 被 restore 删除') }
$script:Results['SOURCE_SAFETY'] = if ($srcExists) { 'PASS' } else { 'FAIL' }

# ---------------------------------------------------------------- 4. shared diff
$sharedAfter = Get-SharedEntries
Write-Log ("shared after: {0} entries" -f $sharedAfter.Count)
$removed = @($sharedBefore | Where-Object { $sharedAfter -notcontains $_ })
$added = @($sharedAfter | Where-Object { $sharedBefore -notcontains $_ })
$script:Results['shared_after_count'] = $sharedAfter.Count
if ($removed.Count -eq 0 -and $added.Count -eq 0) {
  $script:Results['SHARED_DIFF'] = 'none'
  Add-Pass 'shared-diff' 'none'
} else {
  $script:Results['SHARED_DIFF'] = ("removed=[" + ($removed -join ',') + "];added=[" + ($added -join ',') + "]")
  Add-Failure 'shared-diff' $script:Results['SHARED_DIFF']
}

# ---------------------------------------------------------------- 5. cleanup
if (Test-Path -LiteralPath $testFile) { Remove-Item -LiteralPath $testFile -Force; Write-Log ("cleaned source test file: {0}" -f $testFile) }
$preAfter = @(Get-ChildItem -LiteralPath $Backups -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'pre-restore-*' } | Select-Object -ExpandProperty Name)
$newPre = @($preAfter | Where-Object { $preBefore -notcontains $_ })
foreach ($name in $newPre) { Remove-Item -LiteralPath (Join-Path $Backups $name) -Recurse -Force; Write-Log ("cleaned pre-restore snapshot: {0}" -f $name) }
$script:Results['cleaned_pre_restore'] = $newPre.Count

$keep = @('group3-base', 'snap-a', 'snap-b')
foreach ($name in $keep) {
  $ok = Test-Path -LiteralPath (Join-Path $Backups "$name\meta.json")
  $script:Results[('kept_' + ($name -replace '-', '_'))] = $ok
  if ($ok) { Add-Pass ('kept-' + $name) '' } else { Add-Failure ('kept-' + $name) '快照被误删' }
}
$baselineKept = Test-Path -LiteralPath $BaselineDir
$script:Results['kept_manual_baseline'] = $baselineKept
if ($baselineKept) { Add-Pass 'kept-manual-baseline' $BaselineDir } else { Add-Failure 'kept-manual-baseline' 'manual-baseline 缺失' }

$script:Results['log_path'] = $LogPath
if ($script:Failures.Count -eq 0) {
  Write-Log '组 3 日常 restore 验证 PASS' 'INFO'
  Write-ResultBlock 'PASS'
  exit 0
}
Write-Log '组 3 日常 restore 验证 FAIL' 'FAIL'
Write-ResultBlock 'FAIL'
exit 3

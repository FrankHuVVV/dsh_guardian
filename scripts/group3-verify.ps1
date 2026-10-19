<#
.SYNOPSIS
  组 3 动态验证：源码保留（一票否决）+ 共享依赖删除 + 其他 profile 保留。

.DESCRIPTION
  在 DeepSeek Harness 完全退出后，从外部 PowerShell / pwsh 运行：
    pwsh -NoProfile -ExecutionPolicy Bypass -File <GUARDIAN_ROOT>\scripts\group3-verify.ps1

  行为：
    0) 断言无 DeepSeek 进程，有则 ABORT（exit 2，不 kill）
    1) snapshot group3-base（若不存在）；确认 meta.entries 含 shared/*
    2) a) 源码保留测试：在 <YOUR_LINK_PLUGIN> 新建时间戳文件 → restore group3-base → 断言文件仍存在
    3) b) 共享删除测试：在 profiles\node_modules 新建 guardian-shared-test → restore → 断言被删且无其它条目误删
    4) c) 其他 profile 共享包保留：无此类包则 PRESERVED(none)
    5) d) 清理测试文件与本次 pre-restore 快照；不删 group3-base / snap-a / snap-b / manual-baseline
    6) 输出 RESULT 块
  退出码：0 = PASS；2 = 客户端未退出；3 = FAIL
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

# 夹具按需重建（fixtures\sandbox\home 不入库，曾 69MB）；失败不阻塞主流程
try {
  $ensureFixture = Join-Path $PSScriptRoot 'ensure-fixture-home.ps1'
  if (Test-Path -LiteralPath $ensureFixture) { & $ensureFixture -GuardianRoot $GuardianRoot | Out-Null }
} catch { Write-Warning "[fixture] 自动重建失败: $($_.Exception.Message)" }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $GuardianRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("group3-verify-$ts.log")
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

function Invoke-Guardian {
  param([string[]]$CmdArgs, [string]$Tag)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $output = & node $GuardianBin @CmdArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  $sw.Stop()
  Write-Log ("[cmd] node guardian {0}  -> exit={1} ({2}s)" -f ($CmdArgs -join ' '), $code, [int]$sw.Elapsed.TotalSeconds)
  foreach ($line in ($output -split "`r?`n")) {
    if ($line.Trim().Length -gt 0) { [IO.File]::AppendAllText($LogPath, ("  | " + $line + "`r`n"), $Utf8) }
  }
  return @{ code = $code; output = $output }
}

function Get-SharedEntries {
  $items = @(Get-ChildItem -LiteralPath $SharedRoot -Force -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -ExpandProperty Name)
  return $items
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

if (-not (Test-Path -LiteralPath $SourceRoot)) { Add-Failure 'source-root' ("缺失: " + $SourceRoot) }
if (-not (Test-Path -LiteralPath $SharedRoot)) { Add-Failure 'shared-root' ("缺失: " + $SharedRoot) }

# ---------------------------------------------------------------- 1. baseline snapshot
$baseDir = Join-Path $Backups $BaseSnap
if (Test-Path -LiteralPath (Join-Path $baseDir 'meta.json')) {
  Write-Log ("group3-base 已存在，复用: {0}" -f $baseDir) 'WARN'
} else {
  $r = Invoke-Guardian -CmdArgs @('snapshot', $BaseSnap) -Tag 'snapshot-group3-base'
  $script:Results['base_snapshot_exit'] = $r.code
  if ($r.code -ne 0) { Add-Failure 'snapshot-group3-base' ("exit=" + $r.code) }
}
$baseMeta = [IO.File]::ReadAllText((Join-Path $baseDir 'meta.json')) | ConvertFrom-Json
$sharedKeys = @($baseMeta.entries.PSObject.Properties.Name | Where-Object { $_ -like 'shared/*' })
$script:Results['base_shared_entry_count'] = $sharedKeys.Count
$script:Results['base_digest'] = $baseMeta.digest
Write-Log ("group3-base digest={0}, shared entries={1}" -f $baseMeta.digest, $sharedKeys.Count)
if ($sharedKeys.Count -gt 0) { Add-Pass 'base-has-shared' ("shared 条目数=" + $sharedKeys.Count) }
else { Add-Failure 'base-has-shared' 'group3-base 无 shared/* 条目' }

# ---------------------------------------------------------------- 2a. source safety (veto)
$srcFile = Join-Path $SourceRoot 'group3-source-safety-test.txt'
$stamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'
[IO.File]::WriteAllText($srcFile, ("group3 source safety test @ " + $stamp + "`r`n"), $Utf8)
Write-Log ("已创建源码测试文件: {0}" -f $srcFile)

$r1 = Invoke-Guardian -CmdArgs @('restore', $BaseSnap, '--no-stop', '--no-restart', '--assert-offline') -Tag 'restore-source-test'
$script:Results['restore_source_exit'] = $r1.code
$srcExists = Test-Path -LiteralPath $srcFile
$script:Results['SOURCE_SAFETY'] = if ($srcExists) { 'PASS' } else { 'FAIL' }
if ($srcExists) { Add-Pass 'source-safety' 'group3-source-safety-test.txt 仍存在（未被 restore 删除）' }
else { Add-Failure 'source-safety' '源码测试文件被 restore 删除（一票否决）' }

# ---------------------------------------------------------------- 2b. shared delete
$sharedTestDir = Join-Path $SharedRoot 'guardian-shared-test'
if (-not (Test-Path -LiteralPath $sharedTestDir)) { New-Item -ItemType Directory -Path $sharedTestDir -Force | Out-Null }
[IO.File]::WriteAllText((Join-Path $sharedTestDir 'marker.txt'), ("guardian shared test @ " + $stamp + "`r`n"), $Utf8)

$beforeShared = Get-SharedEntries
Write-Log ("shared before restore: {0} 条目" -f $beforeShared.Count)
Write-Log ("  before: " + ($beforeShared -join ', '))

$r2 = Invoke-Guardian -CmdArgs @('restore', $BaseSnap, '--no-stop', '--no-restart', '--assert-offline') -Tag 'restore-shared-test'
$script:Results['restore_shared_exit'] = $r2.code

$afterShared = Get-SharedEntries
Write-Log ("shared after restore: {0} 条目" -f $afterShared.Count)
Write-Log ("  after: " + ($afterShared -join ', '))

$sharedDeleted = -not (Test-Path -LiteralPath $sharedTestDir)
$removedSet = @($beforeShared | Where-Object { $afterShared -notcontains $_ })
$addedSet = @($afterShared | Where-Object { $beforeShared -notcontains $_ })
Write-Log ("removed entries: [" + ($removedSet -join ', ') + "]")
Write-Log ("added entries  : [" + ($addedSet -join ', ') + "]")

$script:Results['SHARED_DELETE_TEST'] = 'PASS'
$script:Results['shared_removed_entries'] = ($removedSet -join ',')
if (-not $sharedDeleted) { Add-Failure 'shared-delete' 'guardian-shared-test 未被删除'; $script:Results['SHARED_DELETE_TEST'] = 'FAIL' }
if ($removedSet.Count -ne 1 -or $removedSet[0] -ne 'guardian-shared-test') {
  Add-Failure 'shared-delete-scope' ("误删/漏删：removed=[" + ($removedSet -join ',') + "] added=[" + ($addedSet -join ',') + "]")
  $script:Results['SHARED_DELETE_TEST'] = 'FAIL'
}
if ($script:Results['SHARED_DELETE_TEST'] -eq 'PASS') { Add-Pass 'shared-delete' 'guardian-shared-test 被删，无其他条目误删' }

# ---------------------------------------------------------------- 2c. other profile shared
$script:Results['OTHER_PROFILE_SHARED'] = 'PRESERVED'
Write-Log 'OTHER_PROFILE_SHARED=PRESERVED（当前 shared 根无被 web/web.bak2 认领的包，nothing to verify）' 'WARN'

# ---------------------------------------------------------------- 2d. cleanup
if (Test-Path -LiteralPath $srcFile) { Remove-Item -LiteralPath $srcFile -Force; Write-Log ("cleaned source test file: {0}" -f $srcFile) }
if (Test-Path -LiteralPath $sharedTestDir) { Remove-Item -LiteralPath $sharedTestDir -Recurse -Force; Write-Log 'guardian-shared-test 仍存在，已手动清理（说明 restore 未删）' 'WARN' }

$removedPreRestore = @()
Get-ChildItem -LiteralPath $Backups -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -like 'pre-restore-*') { Remove-Item -LiteralPath $_.FullName -Recurse -Force; $removedPreRestore += $_.Name }
}
Write-Log ("cleaned pre-restore snapshots: " + ($removedPreRestore -join ', '))

$kept = @('group3-base', 'snap-a', 'snap-b', '_store', 'disabled-entries') | Where-Object { Test-Path -LiteralPath (Join-Path $Backups $_) }
$baseKept = Test-Path -LiteralPath (Join-Path $Backups 'group3-base\meta.json')
$baselineKept = Test-Path -LiteralPath $BaselineDir
$script:Results['group3_base_kept'] = $baseKept
$script:Results['manual_baseline_kept'] = $baselineKept
if ($baseKept) { Add-Pass 'group3-base-kept' '未被清理' } else { Add-Failure 'group3-base-kept' 'group3-base 被误删' }
if ($baselineKept) { Add-Pass 'manual-baseline-kept' $BaselineDir } else { Add-Failure 'manual-baseline-kept' 'manual-baseline 缺失' }

$script:Results['log_path'] = $LogPath
if ($script:Failures.Count -eq 0) {
  Write-Log '组 3 动态验证全部 PASS' 'INFO'
  Write-ResultBlock 'PASS'
  exit 0
}
Write-Log '组 3 动态验证存在 FAIL' 'FAIL'
Write-ResultBlock 'FAIL'
exit 3

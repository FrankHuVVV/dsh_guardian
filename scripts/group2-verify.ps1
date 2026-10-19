<#
.SYNOPSIS
  组 2 动态验证：snapshot 停客户端 + health 实算。

.DESCRIPTION
  在 DeepSeek Harness 完全退出后，从外部 PowerShell / pwsh 运行：
    pwsh -NoProfile -ExecutionPolicy Bypass -File D:\dsh_plugin\dsh_guardian\scripts\group2-verify.ps1

  行为：
    0) 断言无 DeepSeek 进程，有则 ABORT 退出码 2（不 kill）
    1) snapshot test-refuse，读 meta.json 的 health 全文并逐字段断言
    2) snapshot test-normal，同上
    3) C5：无可安全使用的 plugin-add 用例 → 标记 deferred-to-group3/4（不伪造）
    4) 清理 test-refuse / test-normal 快照目录，保留 manual-baseline
    5) 输出 RESULT 块与日志路径
  退出码：0 = 全部 PASS；2 = 客户端未退出；3 = 存在 FAIL
  注意：本脚本不重启客户端；跑完后 DSH 仍处于关闭状态，需要你手动启动。
#>

[CmdletBinding()]
param(
  [string]$GuardianRoot = 'D:\dsh_plugin\dsh_guardian',
  [string]$BaselineDir = 'D:\dsh_plugin\dsh_guardian\manual-baseline-20261018-152408'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 夹具按需重建（fixtures\sandbox\home 不入库，曾 69MB）；失败不阻塞主流程
try {
  $ensureFixture = Join-Path $PSScriptRoot 'ensure-fixture-home.ps1'
  if (Test-Path -LiteralPath $ensureFixture) { & $ensureFixture -GuardianRoot $GuardianRoot | Out-Null }
} catch { Write-Warning "[fixture] 自动重建失败: $($_.Exception.Message)" }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $GuardianRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("group2-verify-$ts.log")
$GuardianBin = Join-Path $GuardianRoot 'bin\guardian.mjs'
$Backups = Join-Path $GuardianRoot 'backups'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

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

function Invoke-SnapshotCase {
  param([string]$Label, [string]$Prefix)

  $dir = Join-Path $Backups $Label
  if (Test-Path -LiteralPath $dir) {
    Write-Log ("预清理已存在的测试快照目录: {0}" -f $dir) 'WARN'
    Remove-Item -LiteralPath $dir -Recurse -Force
  }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $output = & node $GuardianBin snapshot $Label 2>&1 | Out-String
  $code = $LASTEXITCODE
  $sw.Stop()
  Write-Log ("snapshot {0}: exit={1}, wall={2}s" -f $Label, $code, [int]$sw.Elapsed.TotalSeconds)
  foreach ($line in ($output -split "`r?`n")) {
    if ($line.Trim().Length -gt 0) { [IO.File]::AppendAllText($LogPath, ("  | " + $line + "`r`n"), $Utf8) }
  }

  if ($code -ne 0) { Add-Failure ("snapshot-{0}-exit" -f $Label) ("exit=$code") }
  else { Add-Pass ("snapshot-{0}-exit" -f $Label) 'exit=0' }

  $metaPath = Join-Path $dir 'meta.json'
  if (-not (Test-Path -LiteralPath $metaPath)) {
    Add-Failure ("snapshot-{0}-meta" -f $Label) 'meta.json 未生成（拒绝或失败）'
    $script:Results["${Prefix}_exit"] = $code
    return
  }

  $meta = [IO.File]::ReadAllText($metaPath) | ConvertFrom-Json
  $health = $meta.health
  $healthText = $health | ConvertTo-Json -Depth 5 -Compress
  Write-Log ("health({0}) = {1}" -f $Label, $healthText)

  $portText = 'null'
  if ($null -ne $health.port) { $portText = [string]$health.port }
  $settled = 0
  if ($null -ne $health.settledMs) { $settled = [int64]$health.settledMs }

  $script:Results["${Prefix}_exit"] = $code
  $script:Results["${Prefix}_preflight"] = [string]$health.preflight
  $script:Results["${Prefix}_port"] = $portText
  $script:Results["${Prefix}_settled_ms"] = $settled
  $script:Results["${Prefix}_restart"] = [string]$health.restart
  $script:Results["${Prefix}_health_json"] = $healthText

  if ([string]$health.preflight -eq 'ok') { Add-Pass ("{0}-preflight" -f $Prefix) 'ok' }
  else { Add-Failure ("{0}-preflight" -f $Prefix) ("preflight=" + [string]$health.preflight) }

  if ($null -eq $health.port) { Add-Pass ("{0}-port" -f $Prefix) 'null (released)' }
  else { Add-Failure ("{0}-port" -f $Prefix) ("port=" + [string]$health.port) }

  if ($settled -gt 0) { Add-Pass ("{0}-settledMs" -f $Prefix) ("settledMs=" + $settled) }
  else { Add-Failure ("{0}-settledMs" -f $Prefix) 'settledMs 未实算（<=0）' }

  if ([string]$health.restart -eq 'not-implemented-in-group2') { Add-Pass ("{0}-restart" -f $Prefix) 'not-implemented-in-group2' }
  else { Add-Failure ("{0}-restart" -f $Prefix) ("restart=" + [string]$health.restart) }
}

# ---------------------------------------------------------------- 0. header + gate
Write-Log ("guardian root : {0}" -f $GuardianRoot)
Write-Log ("log file      : {0}" -f $LogPath)
Write-Log ("host / time   : {0} / {1}" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'))

if (-not (Test-Path -LiteralPath $GuardianBin)) {
  Add-Failure 'required-path' $GuardianBin
  Write-ResultBlock 'FAIL'
  exit 3
}

$dsProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
if ($dsProcs.Count -gt 0) {
  Write-Log ("检测到 {0} 个 DeepSeek 进程；按规则不 kill，脚本中止。" -f $dsProcs.Count) 'FAIL'
  foreach ($p in $dsProcs) { Write-Log ("  pid={0} start={1}" -f $p.Id, $p.StartTime) 'FAIL' }
  $script:Results['gate_processes'] = $dsProcs.Count
  Write-ResultBlock 'ABORT'
  exit 2
}
$script:Results['gate_processes'] = 0
Add-Pass 'client-stopped' 'Get-Process 无 DeepSeek 进程'

$preflightNow = & node $GuardianBin preflight 2>&1
$preflightCode = $LASTEXITCODE
Write-Log ("preflight before snapshots: exit={0}" -f $preflightCode)
$script:Results['preflight_before_exit'] = $preflightCode
if ($preflightCode -ne 0) { Add-Failure 'preflight-before' ("exit=$preflightCode") } else { Add-Pass 'preflight-before' 'exit=0' }

# ---------------------------------------------------------------- 1/2. snapshot cases
Invoke-SnapshotCase -Label 'test-refuse' -Prefix 'refuse'
Invoke-SnapshotCase -Label 'test-normal' -Prefix 'normal'

# ---------------------------------------------------------------- 3. C5
$script:Results['c5'] = 'deferred-to-group3/4'
Write-Log 'C5=deferred-to-group3/4（可用的 plugin-add 失败用例必然进入 restore 回滚，属组 3 禁止范围，本组不伪造）' 'WARN'

# ---------------------------------------------------------------- 4. cleanup
foreach ($label in @('test-refuse', 'test-normal')) {
  $dir = Join-Path $Backups $label
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force
    Write-Log ("removed snapshot dir: {0}" -f $dir)
  }
  $still = Test-Path -LiteralPath $dir
  $script:Results[("removed_{0}" -f ($label -replace '-', '_'))] = (-not $still)
  if ($still) { Add-Failure ("cleanup-{0}" -f $label) '目录仍存在' } else { Add-Pass ("cleanup-{0}" -f $label) 'removed' }
}

$baselineKept = Test-Path -LiteralPath $BaselineDir
$script:Results['baseline_kept'] = $baselineKept
if ($baselineKept) { Add-Pass 'baseline-kept' $BaselineDir } else { Add-Failure 'baseline-kept' ('缺失: ' + $BaselineDir) }

Write-Log '说明：guardian 无 prune 命令，_store 中仅供 test-* 引用的 blob 不会回收（已知 P1，组 4 处理）' 'WARN'

$storeCount = 0
if (Test-Path -LiteralPath (Join-Path $Backups '_store')) {
  $storeCount = @(Get-ChildItem -LiteralPath (Join-Path $Backups '_store') -Recurse -File -ErrorAction SilentlyContinue).Count
}
$script:Results['store_blobs'] = $storeCount
Write-Log ("store blobs after cleanup: {0}" -f $storeCount)

$script:Results['log_path'] = $LogPath
if ($script:Failures.Count -eq 0) {
  Write-Log '组 2 动态验证全部 PASS' 'INFO'
  Write-ResultBlock 'PASS'
  exit 0
}
Write-Log '组 2 动态验证存在 FAIL' 'FAIL'
Write-ResultBlock 'FAIL'
exit 3

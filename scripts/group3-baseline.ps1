<#
.SYNOPSIS
  组 3 收尾：建 post-group3-config 基线 + 写 SAFE-MODE.md（含三处自校验）。

.DESCRIPTION
  在 DeepSeek Harness 完全退出后，从外部 PowerShell / pwsh 运行：
    pwsh -NoProfile -ExecutionPolicy Bypass -File D:\dsh_plugin\dsh_guardian\scripts\group3-baseline.ps1

  流程：patch sha 前置校验 → snapshot → 自校验1(meta) → digest 对比 → 写 SAFE-MODE →
        自校验2(读回) → 自校验3(list/历史快照) → RESULT。
  不调用 restore，不删除任何快照；任一处自校验不过则 overall=FAIL 且不保留新 SAFE-MODE.md。
#>

[CmdletBinding()]
param(
  [string]$GuardianRoot = 'D:\dsh_plugin\dsh_guardian',
  [string]$ProfileDir = 'C:\Users\28256\.dsh\profiles\desktop',
  [string]$ExpectedPatchSha = 'ac13b1739e768a996f27c03d12376d0d30e19192732a6d690157ff09e068ef7d',
  [string]$ManualBaseline = 'D:\dsh_plugin\dsh_guardian\manual-baseline-20261018-152408'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $GuardianRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("group3-baseline-$ts.log")
$GuardianBin = Join-Path $GuardianRoot 'bin\guardian.mjs'
$Backups = Join-Path $GuardianRoot 'backups'
$SafeModePath = Join-Path $GuardianRoot 'SAFE-MODE.md'
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$SnapLabel = "post-group3-config-$ts"
$SnapDir = Join-Path $Backups $SnapLabel
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$script:R = [ordered]@{}
$script:F = New-Object System.Collections.Generic.List[string]

function Log {
  param([string]$m, [string]$lvl = 'INFO')
  $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $lvl, $m
  [IO.File]::AppendAllText($LogPath, ($line + "`r`n"), $Utf8)
  Write-Host $line
}

function Fail2 {
  param([string]$i, [string]$d)
  $script:F.Add(("{0} :: {1}" -f $i, $d)) | Out-Null
  Log ("FAIL {0} :: {1}" -f $i, $d) 'FAIL'
}

function Pass2 {
  param([string]$i, [string]$d = '')
  Log ("PASS {0} {1}" -f $i, $d)
}

function Result {
  param([string]$overall)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('RESULT_BEGIN')
  foreach ($k in $script:R.Keys) { $lines.Add(('{0}={1}' -f $k, $script:R[$k])) }
  $lines.Add(('failures={0}' -f $script:F.Count))
  foreach ($f in $script:F) { $lines.Add(('failure={0}' -f $f)) }
  $lines.Add(('overall={0}' -f $overall))
  $lines.Add('RESULT_END')
  $block = $lines -join "`r`n"
  [IO.File]::AppendAllText($LogPath, ($block + "`r`n"), $Utf8)
  Write-Host ''
  Write-Host $block
}

# ---------------------------------------------------------------- 1) patch sha 前置校验
Log ("guardian root : {0}" -f $GuardianRoot)
Log ("log file      : {0}" -f $LogPath)
$patchSha = (Get-FileHash -LiteralPath $PatchPath -Algorithm SHA256).Hash.ToLower()
$script:R['PREFLIGHT_PATCH_SHA'] = $patchSha
Log ("live patch sha256 = {0}" -f $patchSha)
if ($patchSha -ne $ExpectedPatchSha) {
  Fail2 'preflight-patch-sha' ("expected=" + $ExpectedPatchSha + " actual=" + $patchSha)
  Result 'ABORT'
  exit 2
}
Pass2 'preflight-patch-sha' 'ac13b173… 匹配'

# ---------------------------------------------------------------- 0) process gate
$dsProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
if ($dsProcs.Count -gt 0) {
  Log ("检测到 {0} 个 DeepSeek 进程；按规则不 kill，脚本中止。" -f $dsProcs.Count) 'FAIL'
  $script:R['GATE_PROCESSES'] = $dsProcs.Count
  Result 'ABORT'
  exit 2
}
$script:R['GATE_PROCESSES'] = 0
Pass2 'client-stopped' 'Get-Process 无 DeepSeek 进程'

# ---------------------------------------------------------------- 3) snapshot
$sw = [Diagnostics.Stopwatch]::StartNew()
$snapOut = & node $GuardianBin snapshot $SnapLabel 2>&1 | Out-String
$snapExit = $LASTEXITCODE
$sw.Stop()
Log ("[cmd] snapshot {0} -> exit={1} ({2}s)" -f $SnapLabel, $snapExit, [int]$sw.Elapsed.TotalSeconds)
foreach ($l in ($snapOut -split "`r?`n")) { if ($l.Trim().Length -gt 0) { [IO.File]::AppendAllText($LogPath, ("  | " + $l + "`r`n"), $Utf8) } }
$script:R['snapshot_exit'] = $snapExit

$metaPath = Join-Path $SnapDir 'meta.json'
$metaOk = $false
$digest = ''
$entriesTotal = 0
$sharedCount = 0
$hPreflight = ''
$hRestart = ''

if ($snapExit -eq 0 -and (Test-Path -LiteralPath $metaPath)) {
  $meta = [IO.File]::ReadAllText($metaPath) | ConvertFrom-Json
  $digest = [string]$meta.digest
  $names = @($meta.entries.PSObject.Properties.Name)
  $entriesTotal = $names.Count
  $sharedCount = @($names | Where-Object { $_ -like 'shared/*' }).Count
  $hPreflight = [string]$meta.health.preflight
  $hRestart = [string]$meta.health.restart
  $metaOk = ($digest.Length -eq 64) -and ($entriesTotal -gt 0) -and ($sharedCount -gt 0) -and ($hPreflight -eq 'ok') -and ($hRestart -eq 'not-implemented-in-group2')
  Log ("digest={0} entries={1} shared={2} health.preflight={3} health.restart={4}" -f $digest, $entriesTotal, $sharedCount, $hPreflight, $hRestart)
  $healthText = $meta.health | ConvertTo-Json -Depth 6 -Compress
  Log ("meta health full: " + $healthText)
}
$script:R['SNAPSHOT_META_OK'] = $metaOk
$script:R['SNAPSHOT_DIGEST'] = $digest
$script:R['SNAPSHOT_ENTRIES_TOTAL'] = $entriesTotal
$script:R['SNAPSHOT_SHARED_COUNT'] = $sharedCount
$script:R['SNAPSHOT_HEALTH_PREFLIGHT'] = $hPreflight
$script:R['SNAPSHOT_HEALTH_RESTART'] = $hRestart

if (-not $metaOk) {
  Fail2 'selfcheck1-meta' 'snapshot meta 校验未通过（见 SNAPSHOT_* 字段）'
}

# ---------------------------------------------------------------- 5) digest compare
$currentDigest = ''
$invJson = Join-Path $LogDir ("current-inventory-post-$ts.json")
$invOut = & node $GuardianBin runtime-inventory --json-out $invJson 2>&1 | Out-String
$invExit = $LASTEXITCODE
if ($invExit -eq 0 -and (Test-Path -LiteralPath $invJson)) {
  $inv = [IO.File]::ReadAllText($invJson) | ConvertFrom-Json
  $currentDigest = [string]$inv.digest
}
$script:R['CURRENT_DIGEST'] = $currentDigest
$digestMatch = ($currentDigest -ne '' -and $currentDigest -eq $digest)
$script:R['DIGEST_MATCH'] = $digestMatch
Log ("current digest={0} snapshot digest={1} DIGEST_MATCH={2}" -f $currentDigest, $digest, $digestMatch)
Log '说明：runtime-inventory 不支持 --diff，仅报 digest 值，不阻塞' 'WARN'

# ---------------------------------------------------------------- 6) write SAFE-MODE.md
$written = $false
$prevContent = $null
if ((Test-Path -LiteralPath $SafeModePath)) { $prevContent = [IO.File]::ReadAllText($SafeModePath) }

$lines = @()
$lines += '# 当前真机使用限制（组 3 完成后，配置基线已更新）'
$lines += ''
$lines += '## 允许'
$lines += '- doctor / preflight / runtime-inventory / drift / status / list / ps'
$lines += '- restore：仅限单线程手工执行，不得与 guard / plugin-* 并发'
$lines += '- snapshot：可信（组 2 已接入 stopClientAndVerify）'
$lines += ''
$lines += '## 禁止'
$lines += '- repair（依赖 recover 对 txid:null 的处理，P0-6 未修）'
$lines += '- plugin-add / plugin-link / plugin-insert / plugin-remove（事务内并发与崩溃续跑未修，P0-5/P0-6）'
$lines += '- guard 与 restore 同时运行（P0-5：锁在命令分发之后）'
$lines += ''
$lines += '## 恢复点'
$lines += ('- {0}（digest {1}）：当前可信基线，含 agent-default-model=deepseek-flash' -f $SnapLabel, $digest)
$lines += '- group3-base（digest 3583051a…）：历史快照，含 agent-default-model=deepseek-v4-pro；restore 会覆盖当前模型设置，仅在你确实想回退到 v4-pro 时使用'
$lines += '- manual-baseline-20261018-152408：手工恢复点，不含 shared 根'
$lines += '- snap-a / snap-b：历史快照'
$lines += ''
$lines += '## 重要警告'
$lines += 'restore 会用快照的 patch 覆盖 live patch，包括 agent-default-model 等配置项。'
$lines += '在跑 restore 前，先对比 group3-base 与当前 patch 的 config 差异，确认不会意外回退你通过 UI 做的设置变更。'
$lines += ''
$lines += '## 解锁条件'
$lines += '- 组 4 完成（P0-5 锁提升、P0-6 recover 处理 txid:null、旧 stopClient 替换）'

if ($metaOk) {
  $lines | Set-Content -LiteralPath $SafeModePath -Encoding utf8
  $written = $true
  Log ("SAFE-MODE.md written ({0} lines)" -f $lines.Count)
} else {
  Log '自校验1 未通过：不写 SAFE-MODE.md' 'WARN'
}
$script:R['SAFE_MODE_WRITTEN'] = $written

# ---------------------------------------------------------------- 7) 自校验2
$safeSha = ''
$safeLines = 0
$placeholderReplaced = $false
if ($written) {
  $readBack = @(Get-Content -LiteralPath $SafeModePath)
  $safeLines = $readBack.Count
  $joined = $readBack -join "`n"
  $hasPh1 = $joined.Contains('<实际 digest>')
  $hasPh2 = $joined.Contains('$ts')
  $hasPh3 = $joined.Contains('<ts>')
  $hasTs = $joined.Contains($SnapLabel)
  $hasDigest = ($digest -ne '' -and $joined.Contains($digest))
  $placeholderReplaced = (-not $hasPh1) -and (-not $hasPh2) -and (-not $hasPh3) -and $hasTs -and $hasDigest
  $safeSha = (Get-FileHash -LiteralPath $SafeModePath -Algorithm SHA256).Hash.ToLower()
  $script:R['SAFE_MODE_SHA256'] = $safeSha
  $script:R['SAFE_MODE_LINES'] = $safeLines
  $script:R['PLACEHOLDER_REPLACED'] = $placeholderReplaced
  Log ("SAFE-MODE.md lines={0} sha256={1} placeholders=[digest:{2} ts:{3} tsTag:{4}] hasActualTs={5} hasDigest={6}" -f $safeLines, $safeSha, $hasPh1, $hasPh2, $hasPh3, $hasTs, $hasDigest)
  $selfcheck2 = (-not $hasPh1) -and (-not $hasPh2) -and (-not $hasPh3) -and $hasTs -and $hasDigest -and ($safeLines -eq 24)
  if ($selfcheck2) { Pass2 'selfcheck2-safe-mode' '读回一致、无占位符、24 行' }
  else {
    Fail2 'selfcheck2-safe-mode' ("lines=" + $safeLines + " placeholderReplaced=" + $placeholderReplaced + " hasTs=" + $hasTs + " hasDigest=" + $hasDigest)
    if ($null -ne $prevContent) { [IO.File]::WriteAllText($SafeModePath, $prevContent, $Utf8); Log '已回滚 SAFE-MODE.md 到写前内容' 'WARN' }
    else { Remove-Item -LiteralPath $SafeModePath -Force; Log '已删除校验失败的 SAFE-MODE.md' 'WARN' }
    $script:R['SAFE_MODE_WRITTEN'] = $false
  }
} else {
  $script:R['SAFE_MODE_SHA256'] = ''
  $script:R['SAFE_MODE_LINES'] = 0
  $script:R['PLACEHOLDER_REPLACED'] = $false
}

# ---------------------------------------------------------------- 8) 自校验3
$listOut = & node $GuardianBin list 2>&1 | Out-String
$postInList = $listOut.Contains($SnapLabel)
$group3InList = $listOut.Contains('group3-base')
$group3Dir = Test-Path -LiteralPath (Join-Path $Backups 'group3-base\meta.json')
$manualDir = Test-Path -LiteralPath $ManualBaseline
$snapA = Test-Path -LiteralPath (Join-Path $Backups 'snap-a\meta.json')
$snapB = Test-Path -LiteralPath (Join-Path $Backups 'snap-b\meta.json')
$historicalIntact = $group3InList -and $group3Dir -and $manualDir -and $snapA -and $snapB
$script:R['POST_BASELINE_IN_LIST'] = $postInList
$script:R['HISTORICAL_SNAPSHOTS_INTACT'] = $historicalIntact
Log ("list checks: postInList={0} group3-base={1}/{2} manual={3} snap-a={4} snap-b={5}" -f $postInList, $group3InList, $group3Dir, $manualDir, $snapA, $snapB)
if ($postInList -and $historicalIntact) { Pass2 'selfcheck3-list' '新基线在 list，历史快照完整' }
else { Fail2 'selfcheck3-list' ("postInList=" + $postInList + " historicalIntact=" + $historicalIntact) }

# ---------------------------------------------------------------- 9) RESULT
$script:R['log_path'] = $LogPath
if ($script:F.Count -eq 0) {
  Log '组 3 基线重建全部 PASS' 'INFO'
  Result 'PASS'
  Write-Host ''
  Write-Host '请重开 DSH，把 RESULT 块贴回。'
  exit 0
}
Log '组 3 基线重建存在 FAIL' 'FAIL'
Result 'FAIL'
Write-Host ''
Write-Host '请重开 DSH，把 RESULT 块贴回。'
exit 3

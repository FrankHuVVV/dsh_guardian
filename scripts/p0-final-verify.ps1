<#
.SYNOPSIS
  P0 修复后收尾验证：guard 写 LKG + plugin-add 事务。

.DESCRIPTION
  在 DeepSeek Harness 完全退出后，从外部 PowerShell / pwsh 运行：
    pwsh -NoProfile -ExecutionPolicy Bypass -File D:\dsh_plugin\dsh_guardian\scripts\p0-final-verify.ps1

  流程：
    0) 断言无 DeepSeek 进程（有则 ABORT/exit 2，不 kill）
    a) guard --detach → exit；等 5s → status.instance.healthy；list 里是否有 lkg=true
    b) plugin-add <本地 file 插件路径> → exit；transactions 取最近一条事务状态
    c) restart → exit；确认 activeOperation=null，客户端由 restart 启动
  退出码：0 PASS / 2 ABORT / 3 FAIL
#>

[CmdletBinding()]
param(
  [string]$GuardianRoot = 'D:\dsh_plugin\dsh_guardian',
  [string]$PluginPath = 'C:\Users\28256\.dsh\plugins\dsh-infinite-gen-2'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $GuardianRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("p0-final-verify-$ts.log")
$GuardianBin = Join-Path $GuardianRoot 'bin\guardian.mjs'
$StatePath = Join-Path $GuardianRoot 'state.json'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$script:R = [ordered]@{}
$script:F = New-Object System.Collections.Generic.List[string]

function Log {
  param([string]$m, [string]$lvl = 'INFO')
  $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $lvl, $m
  [IO.File]::AppendAllText($LogPath, ($line + "`r`n"), $Utf8)
  Write-Host $line
}

function Fail2 { param([string]$i, [string]$d) $script:F.Add(("{0} :: {1}" -f $i, $d)) | Out-Null; Log ("FAIL {0} :: {1}" -f $i, $d) 'FAIL' }
function Pass2 { param([string]$i, [string]$d = '') Log ("PASS {0} {1}" -f $i, $d) }

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

function Invoke-Guardian {
  param([string[]]$CmdArgs)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & node $GuardianBin @CmdArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  $sw.Stop()
  Log ("[cmd] node guardian {0} -> exit={1} ({2}s)" -f ($CmdArgs -join ' '), $code, [int]$sw.Elapsed.TotalSeconds)
  foreach ($l in ($out -split "`r?`n")) { if ($l.Trim().Length -gt 0) { [IO.File]::AppendAllText($LogPath, ("  | " + $l + "`r`n"), $Utf8) } }
  return @{ code = $code; output = $out }
}

# ---------------------------------------------------------------- 0. gate
Log ("guardian root : {0}" -f $GuardianRoot)
Log ("plugin path   : {0}" -f $PluginPath)
Log ("log file      : {0}" -f $LogPath)

$dsProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
if ($dsProcs.Count -gt 0) {
  Log ("检测到 {0} 个 DeepSeek 进程；按规则不 kill，脚本中止。" -f $dsProcs.Count) 'FAIL'
  $script:R['GATE_PROCESSES'] = $dsProcs.Count
  Result 'ABORT'
  exit 2
}
$script:R['GATE_PROCESSES'] = 0
Pass2 'client-stopped' 'Get-Process 无 DeepSeek 进程'

if (-not (Test-Path -LiteralPath $PluginPath)) { Fail2 'plugin-path' ("缺失: " + $PluginPath) }

# ---------------------------------------------------------------- a) guard
$r1 = Invoke-Guardian @('guard', '--detach')
$script:R['guard_exit'] = $r1.code
if ($r1.code -eq 0) { Pass2 'guard-exit' 'exit=0' } else { Fail2 'guard-exit' ("exit=" + $r1.code) }

Start-Sleep -Seconds 5

$r2 = Invoke-Guardian @('status')
$healthy = $false
try {
  $status = $r2.output | ConvertFrom-Json
  $healthy = [bool]$status.instance.healthy
} catch {
  Log 'status 输出解析失败' 'WARN'
}
$script:R['instance_healthy'] = $healthy
if ($healthy) { Pass2 'instance-healthy' 'true' } else { Fail2 'instance-healthy' 'false' }

$r3 = Invoke-Guardian @('list')
$lkgCreated = $false
$lkgLabels = @()
$lkgRecord = ''
try {
  $list = $r3.output | ConvertFrom-Json
  $lkgLabels = @($list.snapshots | Where-Object { $_.lkg -eq $true } | ForEach-Object { $_.label })
  if ($null -ne $list.lkg) { $lkgRecord = ([string]$list.lkg.label + '|' + [string]$list.lkg.digest) }
  $lkgCreated = ($lkgLabels.Count -gt 0) -or ($lkgRecord -ne '')
} catch {
  Log 'list 输出解析失败' 'WARN'
}
$script:R['lkg_created'] = $lkgCreated
$script:R['lkg_labels'] = ($lkgLabels -join ',')
$script:R['lkg_record'] = $lkgRecord
if ($lkgCreated) { Pass2 'lkg-created' ("labels=[" + ($lkgLabels -join ',') + "] record=" + $lkgRecord) } else { Fail2 'lkg-created' '既无 lkg=true 快照，也无 LKG 记录' }

# ---------------------------------------------------------------- b) plugin-add
$r4 = Invoke-Guardian @('plugin-add', $PluginPath)
$script:R['plugin_add_exit'] = $r4.code
if ($r4.code -eq 0) { Pass2 'plugin-add-exit' 'exit=0' } else { Fail2 'plugin-add-exit' ("exit=" + $r4.code) }

$r5 = Invoke-Guardian @('transactions')
$txState = 'none'
$txid = ''
try {
  $rows = @($r5.output | ConvertFrom-Json)
  $txs = @($rows | Where-Object { $_.kind -eq 'transaction' })
  $last = $txs | Sort-Object { [string]$_.startedAt } | Select-Object -Last 1
  if ($null -ne $last) {
    $txState = [string]$last.state
    $txid = [string]$last.txid
  }
} catch {
  Log 'transactions 输出解析失败' 'WARN'
}
$script:R['transaction_state'] = $txState
$script:R['transaction_txid'] = $txid
if ($txState -eq 'committed') { Pass2 'transaction-committed' $txid } else { Fail2 'transaction-committed' ("state=" + $txState) }

# ---------------------------------------------------------------- c) clean state
$r6 = Invoke-Guardian @('restart')
$script:R['restart_exit'] = $r6.code
if ($r6.code -eq 0) { Pass2 'restart-exit' 'exit=0' } else { Fail2 'restart-exit' ("exit=" + $r6.code) }

$r7 = Invoke-Guardian @('status')
$healthyAfter = $false
$activeAfter = 'unknown'
try {
  $status2 = $r7.output | ConvertFrom-Json
  $healthyAfter = [bool]$status2.instance.healthy
  if ($null -eq $status2.activeOperation) { $activeAfter = 'null' } else { $activeAfter = 'non-null' }
} catch {
  Log 'status(after restart) 输出解析失败' 'WARN'
}
$script:R['instance_healthy_after_restart'] = $healthyAfter
$script:R['active_operation_after_restart'] = $activeAfter
if ($activeAfter -eq 'null') { Pass2 'active-operation-null' 'null' } else { Fail2 'active-operation-null' $activeAfter }

$script:R['log_path'] = $LogPath
if ($script:F.Count -eq 0) {
  Log 'P0 收尾验证全部 PASS' 'INFO'
  Result 'PASS'
  exit 0
}
Log 'P0 收尾验证存在 FAIL' 'FAIL'
Result 'FAIL'
exit 3

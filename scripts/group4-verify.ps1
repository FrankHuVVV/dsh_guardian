<#
.SYNOPSIS
  组 4 动态验证：recover 处理 txid:null + startClient spawn 失败不崩溃。

.DESCRIPTION
  在 DeepSeek Harness 完全退出后，从外部 PowerShell / pwsh 运行：
    pwsh -NoProfile -ExecutionPolicy Bypass -File D:\dsh_plugin\dsh_guardian\scripts\group4-verify.ps1

  流程：
    a) 写 state.activeOperation={op:'restore',txid:null,phase:'installing'} → recover → 断言 activeOperation 变 null
    b) 临时把 config.launch 指向“存在但不可执行”的假 exe（同目录 resources/app.asar 用硬链接指向真实 asar，
       保证 fingerprint/preflight 仍通过），跑 restore → 断言退出码非 0、health.restart=spawn-error、
       无未捕获异常、残留已清理；随后还原 config.json 与删除假目录
    c) 确认 live activeOperation 为 null
  退出码：0 PASS / 2 ABORT / 3 FAIL
#>

[CmdletBinding()]
param(
  [string]$GuardianRoot = 'D:\dsh_plugin\dsh_guardian',
  [string]$TargetSnap = 'post-group3-config-20261018-162012',
  [string]$RealAsar = 'C:\Users\28256\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $GuardianRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("group4-verify-$ts.log")
$GuardianBin = Join-Path $GuardianRoot 'bin\guardian.mjs'
$Backups = Join-Path $GuardianRoot 'backups'
$StatePath = Join-Path $GuardianRoot 'state.json'
$ConfigPath = Join-Path $GuardianRoot 'config.json'
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

function Read-JsonFile { param([string]$p) return [IO.File]::ReadAllText($p) | ConvertFrom-Json }
function Write-JsonFile { param([string]$p, $obj) [IO.File]::WriteAllText($p, ($obj | ConvertTo-Json -Depth 12), $Utf8) }

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
Log ("log file      : {0}" -f $LogPath)
Log ("host / time   : {0} / {1}" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'))

$dsProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
if ($dsProcs.Count -gt 0) {
  Log ("检测到 {0} 个 DeepSeek 进程；按规则不 kill，脚本中止。" -f $dsProcs.Count) 'FAIL'
  $script:R['GATE_PROCESSES'] = $dsProcs.Count
  Result 'ABORT'
  exit 2
}
$script:R['GATE_PROCESSES'] = 0
Pass2 'client-stopped' 'Get-Process 无 DeepSeek 进程'

# ---------------------------------------------------------------- a) recover txid:null
$state = Read-JsonFile $StatePath
$state.activeOperation = [pscustomobject]@{ op = 'restore'; txid = $null; phase = 'installing'; pid = $PID; startedAt = (Get-Date -Format 'o') }
Write-JsonFile $StatePath $state
Log '已写入 activeOperation={op:restore, txid:null, phase:installing}'

$logDir = Join-Path $GuardianRoot 'logs'
$logBefore = @(Get-ChildItem -LiteralPath $logDir -Filter 'guardian-*.log' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })

$r1 = Invoke-Guardian @('recover')
$script:R['recover_exit'] = $r1.code
$stateAfter = Read-JsonFile $StatePath
$cleared = ($null -eq $stateAfter.activeOperation)
$script:R['recover_txid_null_cleared'] = $cleared
if ($cleared) { Pass2 'recover-txid-null-cleared' 'activeOperation=null' } else { Fail2 'recover-txid-null-cleared' 'activeOperation 仍非 null' }

$logText = ''
foreach ($name in $logBefore) { $logText += [IO.File]::ReadAllText((Join-Path $logDir $name)) }
$phaseLogged = $logText.Contains('cleared-manual-intervention-needed')
$script:R['recover_phase_logged'] = $phaseLogged
if ($phaseLogged) { Pass2 'recover-phase-logged' 'cleared-manual-intervention-needed' } else { Fail2 'recover-phase-logged' '日志未见 cleared-manual-intervention-needed' }

# ---------------------------------------------------------------- b) spawn failure
$configBackup = Join-Path $LogDir ("config.backup-$ts.json")
Copy-Item -LiteralPath $ConfigPath -Destination $configBackup -Force
Log ("config.json 备份: {0}" -f $configBackup)

$fakeDir = Join-Path $env:TEMP ("guardian-fake-$ts")
$fakeRes = Join-Path $fakeDir 'resources'
$fakeExe = Join-Path $fakeDir 'guardian.exe'
$linkMade = $false
try {
  New-Item -ItemType Directory -Path $fakeRes -Force | Out-Null
  Set-Content -LiteralPath $fakeExe -Value 'not-an-executable' -Encoding ascii
  New-Item -ItemType HardLink -Path (Join-Path $fakeRes 'app.asar') -Target $RealAsar | Out-Null
  $linkMade = $true
  Log ("fake launch dir: {0} (app.asar hardlink -> {1})" -f $fakeDir, $RealAsar)
} catch {
  Fail2 'fake-launch-setup' $_.Exception.Message
}

$preBefore = @(Get-ChildItem -LiteralPath $Backups -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'pre-restore-*' } | Select-Object -ExpandProperty Name)

if ($linkMade) {
  $config = Read-JsonFile $ConfigPath
  $config.launch = @($fakeExe)
  Write-JsonFile $ConfigPath $config
  Log 'config.launch 已临时指向假 exe'

  $r2 = Invoke-Guardian @('restore', $TargetSnap)
  $script:R['restore_exit'] = $r2.code
  $crash = $r2.output.Contains('Uncaught') -or $r2.output.Contains('throw new Error') -or $r2.output.Contains('node:internal')
  $script:R['crash_detected'] = $crash
  if ($crash) { Fail2 'no-crash' 'restore 输出疑似未捕获异常' } else { Pass2 'no-crash' '无未捕获异常' }

  $healthRestart = ''
  $m = [regex]::Match($r2.output, '"restart"\s*:\s*"([^"]+)"')
  if ($m.Success) { $healthRestart = $m.Groups[1].Value }
  $script:R['health_restart'] = $healthRestart
  $handled = ($r2.code -ne 0) -and (($healthRestart -eq 'spawn-error') -or ($healthRestart -eq 'timeout')) -and (-not $crash)
  $script:R['startclient_error_handled'] = $handled
  if ($handled) { Pass2 'startclient-error-handled' ("exit=" + $r2.code + " restart=" + $healthRestart) }
  else { Fail2 'startclient-error-handled' ("exit=" + $r2.code + " restart=" + $healthRestart + " crash=" + $crash) }

  Copy-Item -LiteralPath $configBackup -Destination $ConfigPath -Force
  Log 'config.json 已还原'
} 
if (Test-Path -LiteralPath $fakeDir) { Remove-Item -LiteralPath $fakeDir -Recurse -Force; Log ("removed fake dir: {0}" -f $fakeDir) }

$preAfter = @(Get-ChildItem -LiteralPath $Backups -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'pre-restore-*' } | Select-Object -ExpandProperty Name)
$newPre = @($preAfter | Where-Object { $preBefore -notcontains $_ })
foreach ($name in $newPre) { Remove-Item -LiteralPath (Join-Path $Backups $name) -Recurse -Force; Log ("cleaned pre-restore: {0}" -f $name) }

# ---------------------------------------------------------------- c) clean state
$stateFinal = Read-JsonFile $StatePath
if ($null -ne $stateFinal.activeOperation) {
  Log 'activeOperation 仍非 null，再执行一次 recover' 'WARN'
  $r3 = Invoke-Guardian @('recover')
  $stateFinal = Read-JsonFile $StatePath
}
$script:R['final_activeOperation'] = if ($null -eq $stateFinal.activeOperation) { 'null' } else { 'non-null' }
if ($null -eq $stateFinal.activeOperation) { Pass2 'final-state-clean' 'activeOperation=null' } else { Fail2 'final-state-clean' 'activeOperation 非 null' }

$intact = (Test-Path (Join-Path $Backups 'snap-a\meta.json')) -and (Test-Path (Join-Path $Backups 'snap-b\meta.json')) -and (Test-Path (Join-Path $Backups 'group3-base\meta.json')) -and (Test-Path (Join-Path $Backups "$TargetSnap\meta.json"))
$script:R['snapshots_intact'] = $intact
if ($intact) { Pass2 'snapshots-intact' '4 个快照完好' } else { Fail2 'snapshots-intact' '快照缺失' }

$script:R['log_path'] = $LogPath
if ($script:F.Count -eq 0) { Log '组 4 动态验证全部 PASS' 'INFO'; Result 'PASS'; Write-Host ''; Write-Host '请重开 DSH，把 RESULT 块贴回。'; exit 0 }
Log '组 4 动态验证存在 FAIL' 'FAIL'
Result 'FAIL'
Write-Host ''
Write-Host '请重开 DSH，把 RESULT 块贴回。'
exit 3

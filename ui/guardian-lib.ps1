# guardian-lib.ps1 — DSH Guardian UI 公共函数
# 被 guardian-tray.ps1 / guardian-console.ps1 / guardian-start-backend.ps1 / guardian-setup.ps1 点源引用。

$__guardianUiDir = $PSScriptRoot
$__guardianRoot  = Split-Path -Parent $__guardianUiDir

$GuardianPaths = [pscustomobject]@{
  UiDir         = $__guardianUiDir
  Root          = $__guardianRoot
  Port          = 3081
  Url           = 'http://127.0.0.1:3081/'
  LogDir        = Join-Path $__guardianRoot 'logs'
  TrayPidFile   = Join-Path $__guardianRoot 'logs\tray.pid'
  TrayStateFile = Join-Path $__guardianRoot 'logs\tray.state.json'
  Icon          = Join-Path $__guardianUiDir 'guardian.ico'
  Server        = Join-Path $__guardianUiDir 'server.mjs'
  ConsoleScript = Join-Path $__guardianUiDir 'guardian-console.ps1'
  TrayVbs       = Join-Path $__guardianUiDir 'guardian-tray.vbs'
  StartVbs      = Join-Path $__guardianUiDir 'guardian-start.vbs'
  GuardianBin   = Join-Path $__guardianRoot 'bin\guardian.mjs'
  LockFile      = Join-Path $__guardianRoot '.guardian.lock'
  StateFile     = Join-Path $__guardianRoot 'state.json'
  PruneLog      = Join-Path $__guardianRoot 'logs\prune-task.log'
  PruneMarker   = Join-Path $__guardianRoot 'logs\.prune-last'
}

function Get-GuardianNodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

function Get-BackendPid {
  try {
    $conn = Get-NetTCPConnection -LocalPort $GuardianPaths.Port -State Listen -ErrorAction Stop |
      Select-Object -First 1
  } catch {
    return $null
  }
  if (-not $conn) { return $null }
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') { return [int]$proc.Id }
  return $null
}

function Get-GuardianHealth {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-WebRequest -Uri ($GuardianPaths.Url + 'api/status') -UseBasicParsing -TimeoutSec 2
    $sw.Stop()
    $data = $null
    try { $data = $resp.Content | ConvertFrom-Json } catch { $data = $null }
    return [pscustomobject]@{
      Ok    = ($resp.StatusCode -eq 200 -and $null -ne $data -and $data.ok)
      Data  = $data
      Ms    = [int]$sw.ElapsedMilliseconds
      Error = $null
    }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{
      Ok    = $false
      Data  = $null
      Ms    = [int]$sw.ElapsedMilliseconds
      Error = $_.Exception.Message
    }
  }
}

function Start-GuardianBackend {
  $existing = Get-BackendPid
  if ($existing) { return $existing }

  $node = Get-GuardianNodeExe
  if (-not $node) { throw '未找到 node.exe：请确认已安装 Node.js 并加入 PATH。' }

  New-Item -ItemType Directory -Force -Path $GuardianPaths.LogDir | Out-Null
  $outLog = Join-Path $GuardianPaths.LogDir 'ui-server.log'
  $errLog = Join-Path $GuardianPaths.LogDir 'ui-server.err.log'

  try {
    Start-Process -FilePath $node `
      -ArgumentList ('"' + $GuardianPaths.Server + '"') `
      -WorkingDirectory $GuardianPaths.Root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog | Out-Null
  } catch {
    # 日志文件被占用等异常时退化为无重定向启动，避免整体失败
    Start-Process -FilePath $node `
      -ArgumentList ('"' + $GuardianPaths.Server + '"') `
      -WorkingDirectory $GuardianPaths.Root `
      -WindowStyle Hidden | Out-Null
  }

  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 250
    $started = Get-BackendPid
    if ($started) { return $started }
  }
  return $null
}

function Stop-GuardianBackend {
  $bp = Get-BackendPid
  if (-not $bp) { return }
  Stop-Process -Id $bp -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-BackendPid)) { return }
    Start-Sleep -Milliseconds 150
  }
}

function Get-GuardianTrayPid {
  try {
    if (-not (Test-Path -LiteralPath $GuardianPaths.TrayPidFile)) { return $null }
    $raw = (Get-Content -LiteralPath $GuardianPaths.TrayPidFile -Raw -ErrorAction Stop).Trim()
    $n = 0
    if (-not [int]::TryParse($raw, [ref]$n)) { return $null }
    $proc = Get-Process -Id $n -ErrorAction SilentlyContinue
    if ($proc -and ($proc.ProcessName -like 'powershell*' -or $proc.ProcessName -eq 'pwsh')) { return $n }
  } catch { }
  return $null
}

function Start-GuardianTray {
  $existing = Get-GuardianTrayPid
  if ($existing) { return $existing }
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  Start-Process -FilePath $wscript -ArgumentList ('"' + $GuardianPaths.TrayVbs + '"') -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    $tp = Get-GuardianTrayPid
    if ($tp) { return $tp }
  }
  return $null
}

function Start-GuardianBackendDetached {
  # 通过 wscript 隐藏进程启动，脱离当前控制台，关闭控制台窗口不会影响后端
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  Start-Process -FilePath $wscript -ArgumentList ('"' + $GuardianPaths.StartVbs + '"') -WindowStyle Hidden | Out-Null
}

function Get-GuardianStartupShortcut {
  $startup = [Environment]::GetFolderPath('Startup')
  if (-not $startup) {
    $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  }
  return (Join-Path $startup 'DSH Guardian.lnk')
}

function Test-GuardianStartup {
  return (Test-Path -LiteralPath (Get-GuardianStartupShortcut))
}

function Set-GuardianStartup([bool]$Enabled) {
  $lnk = Get-GuardianStartupShortcut
  if (-not $Enabled) {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
    return
  }
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $wscript
  $sc.Arguments = '"' + $GuardianPaths.TrayVbs + '"'
  $sc.WorkingDirectory = $GuardianPaths.Root
  $sc.IconLocation = $GuardianPaths.Icon + ',0'
  $sc.Description = 'DSH Guardian 后端：登录时自动启动并常驻托盘'
  $sc.WindowStyle = 7
  $sc.Save()
}

function Format-GuardianBytes($bytes) {
  $v = [double]$bytes
  if ($v -le 0) { return '—' }
  $units = @('B', 'KB', 'MB', 'GB')
  $i = 0
  while ($v -ge 1024 -and $i -lt ($units.Length - 1)) {
    $v = $v / 1024
    $i++
  }
  if ($i -eq 0) { return ('{0:N0} {1}' -f $v, $units[$i]) }
  return ('{0:N1} {1}' -f $v, $units[$i])
}

function Format-GuardianShortDigest($digest) {
  if (-not $digest) { return '—' }
  $s = [string]$digest
  if ($s.Length -le 14) { return $s }
  return $s.Substring(0, 8) + '...' + $s.Substring($s.Length - 4)
}

# ---------------------------------------------------------------- 常驻维护：每日 03:00 prune

# 每日自动 prune 的窗口（03:00 起 10 分钟内尝试；托盘 5 秒一轮，撞车可下一轮重试）
$script:PruneWindowHour = 3
$script:PruneWindowMinutes = 10

function Write-PruneLog {
  param([string]$Message, [string]$Level = 'INFO')
  try {
    New-Item -ItemType Directory -Force -Path $GuardianPaths.LogDir | Out-Null
    $line = '[{0}] [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::AppendAllText($GuardianPaths.PruneLog, ($line + "`r`n"), $enc)
  } catch { }
}

function Get-PruneMarkerDate {
  try {
    if (-not (Test-Path -LiteralPath $GuardianPaths.PruneMarker)) { return $null }
    return ((Get-Content -LiteralPath $GuardianPaths.PruneMarker -Raw -ErrorAction Stop).Trim())
  } catch { return $null }
}

# 今天是否还没在窗口内跑过
function Test-PruneDue {
  $now = Get-Date
  if ($now.Hour -ne $script:PruneWindowHour) { return $false }
  if ($now.Minute -gt $script:PruneWindowMinutes) { return $false }
  if ((Get-PruneMarkerDate) -eq $now.ToString('yyyy-MM-dd')) { return $false }
  return $true
}

# 有正在进行的操作就跳过：显式锁 → activeOperation → 其它「会改环境」的 guardian 进程
# 注意：status / ps / list / drift / preflight / runtime-inventory / transactions 是只读命令，
# 不取锁也不改环境（UI 每 5 秒会拉一次 status），不能因为它们把 prune 饿死。
$script:GuardianReadOnlyCommands = @(
  'status', 'ps', 'list', 'drift', 'preflight', 'runtime-inventory', 'transactions'
)

function Get-GuardianInvocationCommand {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $null }
  $index = $CommandLine.IndexOf('guardian.mjs', [StringComparison]::OrdinalIgnoreCase)
  if ($index -lt 0) { return $null }
  $after = $CommandLine.Substring($index + 'guardian.mjs'.Length).Trim().Trim('"').Trim()
  $tokens = @($after -split '\s+' | Where-Object { $_ -ne '' })
  for ($i = 0; $i -lt $tokens.Count; $i++) {
    $t = $tokens[$i].Trim('"')
    if ($t -eq '--root') { $i++; continue }   # --root <path> 的值不是命令名
    if ($t.StartsWith('--')) { continue }
    return $t
  }
  return 'status'   # 未写命令时 guardian 默认执行 status
}

function Test-GuardianBusy {
  if (Test-Path -LiteralPath $GuardianPaths.LockFile) { return 'lock-held' }
  try {
    if (Test-Path -LiteralPath $GuardianPaths.StateFile) {
      $st = Get-Content -LiteralPath $GuardianPaths.StateFile -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($st -and $st.activeOperation) {
        $op = $st.activeOperation.op
        $phase = $st.activeOperation.phase
        return ('activeOperation:' + [string]$op + '/' + [string]$phase)
      }
    }
  } catch { }
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    $busy = @()
    foreach ($p in $procs) {
      $cmd = Get-GuardianInvocationCommand -CommandLine $p.CommandLine
      if (-not $cmd) { continue }
      if ($cmd -eq 'prune') { continue }                                  # 另一个 prune 不算冲突
      if ($script:GuardianReadOnlyCommands -contains $cmd) { continue }    # 只读命令不算冲突
      $busy += ('{0}:{1}' -f $p.ProcessId, $cmd)
    }
    if ($busy.Count -gt 0) { return ('guardian-running:' + ($busy -join ',')) }
  } catch { }
  return $null
}

# 静默执行 prune --vacuum：无弹窗；成功/跳过/失败都只写 logs\prune-task.log
function Invoke-GuardianPrune {
  param([switch]$Manual)

  if (-not $Manual -and -not (Test-PruneDue)) { return $null }

  $busy = Test-GuardianBusy
  if ($busy) {
    Write-PruneLog ("SKIP 用户操作进行中（{0}），本轮不清理，等下一轮" -f $busy) 'SKIP'
    return [pscustomobject]@{ status = 'skipped'; reason = $busy }
  }

  $node = Get-GuardianNodeExe
  if (-not $node -or -not (Test-Path -LiteralPath $GuardianPaths.GuardianBin)) {
    Write-PruneLog 'FAIL 找不到 node.exe 或 bin\guardian.mjs，跳过本次维护' 'ERROR'
    return [pscustomobject]@{ status = 'failed'; reason = 'node-or-guardian-missing' }
  }

  $mode = 'scheduled'
  if ($Manual) { $mode = 'manual' }
  Write-PruneLog ("START prune --vacuum（root={0}, mode={1}）" -f $GuardianPaths.Root, $mode) 'INFO'

  $raw = $null
  $code = 1
  try {
    $raw = & $node $GuardianPaths.GuardianBin 'prune' '--vacuum' 2>&1
    $code = $LASTEXITCODE
  } catch {
    Write-PruneLog ('FAIL prune 抛异常：' + $_.Exception.Message) 'ERROR'
    return [pscustomobject]@{ status = 'failed'; reason = 'exception' }
  }

  $text = ($raw | Out-String).Trim()
  if ($code -eq 0) {
    $freed = 'n/a'; $deleted = 'n/a'; $blobs = 'n/a'; $shards = 'n/a'; $kept = 'n/a'
    try {
      $j = $text | ConvertFrom-Json
      $freed = [double]$j.freed.totalMb
      $deleted = @($j.deleted).Count
      $blobs = $j.store.blobsDeleted
      $shards = $j.vacuum.emptyShardsRemoved
      $kept = @($j.kept).Count
    } catch { }
    Write-PruneLog ("OK exit=0 kept={0} deleted={1} blobsDeleted={2} emptyShardsRemoved={3} freedMb={4}" -f $kept, $deleted, $blobs, $shards, $freed) 'INFO'
    if (-not $Manual) {
      try { Set-Content -LiteralPath $GuardianPaths.PruneMarker -Value ((Get-Date).ToString('yyyy-MM-dd')) -Encoding ASCII } catch { }
    }
    return [pscustomobject]@{ status = 'ok'; deleted = $deleted; freedMb = $freed }
  }

  $snippet = $text.Replace("`r`n", ' | ').Replace("`n", ' | ')
  if ($snippet.Length -gt 800) { $snippet = $snippet.Substring(0, 800) + '…' }
  Write-PruneLog ("FAIL exit={0}：{1}" -f $code, $snippet) 'ERROR'
  return [pscustomobject]@{ status = 'failed'; reason = ('exit-' + $code) }
}

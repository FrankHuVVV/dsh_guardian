# guardian-tray.ps1 — DSH Guardian 托盘宿主（无窗口）
# 职责：启动/守护后端、托盘图标、右键菜单（打开界面 / 状态窗口 / 退出后端 / 开机自启）。
# 由 guardian-tray.vbs 以隐藏窗口方式拉起；不依赖第三方组件。

param(
  [switch]$NoWatchdog,
  [switch]$SelfTest,
  [switch]$SelfTestMenu
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'guardian-lib.ps1')

# ---------- 单实例 ----------
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\DshGuardianTrayHost', [ref]$created)
if (-not $created) {
  Write-Host 'DSH Guardian 托盘已在运行。'
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

New-Item -ItemType Directory -Force -Path $GuardianPaths.LogDir | Out-Null
Set-Content -LiteralPath $GuardianPaths.TrayPidFile -Value $PID -Encoding ASCII

$script:AllowRestart = (-not $NoWatchdog)
$script:LastStartAttempt = [datetime]::MinValue
$script:Notify = $null
$script:Timer = $null
$script:MenuHeader = $null
$script:MenuRestart = $null
$script:MenuStop = $null
$script:MenuStartup = $null

# ---------- 状态刷新 ----------
function Update-Tray {
  $bp = Get-BackendPid
  $health = Get-GuardianHealth

  if (-not $bp -and $script:AllowRestart) {
    if (((Get-Date) - $script:LastStartAttempt).TotalSeconds -ge 10) {
      $script:LastStartAttempt = Get-Date
      try { $null = Start-GuardianBackend } catch { }
      $bp = Get-BackendPid
      $health = Get-GuardianHealth
    }
  }

  $safeText = '—'
  $driftText = '—'
  $lkgText = '—'
  if ($health.Ok -and $health.Data) {
    $d = $health.Data
    if ($d.status) {
      if ($d.status.safe) { $safeText = 'ON' } else { $safeText = 'OFF' }
      if ($d.status.drift -and $d.status.drift.detected) { $driftText = 'DETECTED' } else { $driftText = 'clean' }
    }
    if ($d.lkg -and $d.lkg.label) { $lkgText = [string]$d.lkg.label }
  }

  if ($health.Ok -and $bp) {
    $tip = "Guardian 运行中 · PID $bp · safe $safeText · drift $driftText"
  } elseif ($bp) {
    $tip = "Guardian 无响应 · PID $bp"
  } else {
    $tip = 'Guardian 后端未运行'
  }
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }

  if ($script:Notify) {
    $script:Notify.Text = $tip
    if ($script:MenuHeader) {
      if ($bp) {
        $script:MenuHeader.Text = "DSH Guardian · 端口 $($GuardianPaths.Port) · PID $bp"
      } else {
        $script:MenuHeader.Text = "DSH Guardian · 端口 $($GuardianPaths.Port) · 未运行"
      }
    }
    if ($script:MenuStop) { $script:MenuStop.Enabled = [bool]$bp }
  }

  try {
    $state = [pscustomobject]@{
      trayPid      = $PID
      backendPid   = $bp
      healthy      = [bool]$health.Ok
      port         = $GuardianPaths.Port
      safe         = $safeText
      drift        = $driftText
      lkg          = $lkgText
      allowRestart = $script:AllowRestart
      tooltip      = $tip
      responseMs   = $health.Ms
      updatedAt    = (Get-Date).ToString('o')
    }
    $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $GuardianPaths.TrayStateFile -Encoding UTF8
  } catch { }
}

# ---------- 菜单动作 ----------
function Open-Ui {
  Start-Process $GuardianPaths.Url
}

function Open-StatusWindow {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $ps -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $GuardianPaths.ConsoleScript + '"') -WindowStyle Normal
}

function Open-Logs {
  Start-Process explorer.exe $GuardianPaths.LogDir
}

function Restart-Backend {
  $script:AllowRestart = $true
  Stop-GuardianBackend
  Start-Sleep -Milliseconds 300
  try { $null = Start-GuardianBackend } catch { }
  Update-Tray
  if ($script:Notify) {
    $script:Notify.ShowBalloonTip(2500, 'DSH Guardian', '后端已重启。', [System.Windows.Forms.ToolTipIcon]::Info)
  }
}

function Stop-BackendKeepTray {
  $script:AllowRestart = $false
  Stop-GuardianBackend
  Update-Tray
}

function Toggle-Startup {
  $want = -not (Test-GuardianStartup)
  Set-GuardianStartup $want
  if ($script:MenuStartup) { $script:MenuStartup.Checked = Test-GuardianStartup }
  if ($script:Notify) {
    $msg = '已启用：登录后自动启动'
    if (-not $want) { $msg = '已关闭：登录后不再自动启动' }
    $script:Notify.ShowBalloonTip(2000, 'DSH Guardian 开机自启', $msg, [System.Windows.Forms.ToolTipIcon]::Info)
  }
}

function Exit-All {
  $script:AllowRestart = $false
  try { if ($script:Timer) { $script:Timer.Stop() } } catch { }
  Stop-GuardianBackend
  try {
    if ($script:Notify) {
      $script:Notify.Visible = $false
      $script:Notify.Dispose()
    }
  } catch { }
  Remove-Item -LiteralPath $GuardianPaths.TrayPidFile -Force -ErrorAction SilentlyContinue
  try {
    $stopped = [pscustomobject]@{
      trayPid   = $PID
      stopped   = $true
      updatedAt = (Get-Date).ToString('o')
    }
    $stopped | ConvertTo-Json -Compress | Set-Content -LiteralPath $GuardianPaths.TrayStateFile -Encoding UTF8
  } catch { }
  [System.Windows.Forms.Application]::Exit()
  [Environment]::Exit(0)
}

# ---------- 托盘图标与菜单 ----------
$notify = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path -LiteralPath $GuardianPaths.Icon) {
  try {
    $notify.Icon = New-Object System.Drawing.Icon($GuardianPaths.Icon, 16, 16)
  } catch {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
  }
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = 'DSH Guardian 后端'
$notify.Visible = $true
$script:Notify = $notify

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false

$header = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList 'DSH Guardian'
$header.Enabled = $false
[void]$menu.Items.Add($header)
$script:MenuHeader = $header

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '打开 Guardian UI'
$miOpen.Font = [System.Drawing.Font]::new('Segoe UI', [single]9, [System.Drawing.FontStyle]::Bold)
$miOpen.add_Click({ Open-Ui })
[void]$menu.Items.Add($miOpen)

$miConsole = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '打开状态窗口'
$miConsole.add_Click({ Open-StatusWindow })
[void]$menu.Items.Add($miConsole)

$miLogs = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '打开日志目录'
$miLogs.add_Click({ Open-Logs })
[void]$menu.Items.Add($miLogs)

$miRefresh = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '刷新状态'
$miRefresh.add_Click({ Update-Tray })
[void]$menu.Items.Add($miRefresh)

$miPrune = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '清理无用快照（prune --vacuum）'
$miPrune.add_Click({ try { $null = Invoke-GuardianPrune -Manual } catch { } })
[void]$menu.Items.Add($miPrune)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '重启后端'
$miRestart.add_Click({ Restart-Backend })
[void]$menu.Items.Add($miRestart)
$script:MenuRestart = $miRestart

$miStop = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '停止后端（托盘保留）'
$miStop.add_Click({ Stop-BackendKeepTray })
[void]$menu.Items.Add($miStop)
$script:MenuStop = $miStop

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miStartup = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '开机自启（登录时启动）'
$miStartup.CheckOnClick = $false
$miStartup.Checked = Test-GuardianStartup
$miStartup.add_Click({ Toggle-Startup })
[void]$menu.Items.Add($miStartup)
$script:MenuStartup = $miStartup

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$miExit = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '退出后端并关闭托盘'
$miExit.add_Click({ Exit-All })
[void]$menu.Items.Add($miExit)

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Open-Ui })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  Update-Tray
  # 常驻维护：今天还没成功清理过就补跑一次 prune --vacuum（不绑钟点，几点开机都能补）。
  # 与用户操作冲突时只记一条 DEFER 日志、不消耗重试配额，空闲后的下一轮（5 秒）自动执行。
  try { $null = Invoke-GuardianPrune } catch {
    try { Write-PruneLog ('ERROR tick: ' + $_.Exception.Message) 'ERROR' } catch { }
  }
})
$script:Timer = $timer

if ($SelfTestMenu) {
  $labels = @()
  foreach ($it in $menu.Items) {
    if ($it.GetType().Name -eq 'ToolStripSeparator') { continue }
    $labels += ('[' + $it.Text + ']')
  }
  Write-Host ('MENU_ITEMS=' + ($labels -join ' '))
  $miRefresh.PerformClick()
  Write-Host 'PERFORM_CLICK_OK'
  Write-Host ('tooltipAfterClick=' + $notify.Text)
  $notify.Visible = $false
  $notify.Dispose()
  Remove-Item -LiteralPath $GuardianPaths.TrayPidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

if ($SelfTest) {
  Update-Tray
  Write-Host 'SELFTEST_OK'
  Write-Host ('tooltip=' + $notify.Text)
  Write-Host ('menuItems=' + $menu.Items.Count)
  Write-Host ('backendPid=' + (Get-BackendPid))
  Write-Host ('startup=' + (Test-GuardianStartup))
  Write-Host ('pruneDue=' + (Test-PruneDue))
  Write-Host ('pruneMarker=' + [string](Get-PruneMarkerDate))
  Write-Host ('pruneLog=' + $GuardianPaths.PruneLog)
  $notify.Visible = $false
  $notify.Dispose()
  Remove-Item -LiteralPath $GuardianPaths.TrayPidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

try {
  Update-Tray
  $timer.Start()
  $notify.ShowBalloonTip(3000, 'DSH Guardian', "后端已就绪：$($GuardianPaths.Url)", [System.Windows.Forms.ToolTipIcon]::Info)
  [System.Windows.Forms.Application]::Run()
} catch {
  try {
    $notify.Visible = $false
    $notify.Dispose()
  } catch { }
  throw
} finally {
  try { $timer.Stop() } catch { }
  Remove-Item -LiteralPath $GuardianPaths.TrayPidFile -Force -ErrorAction SilentlyContinue
  try { $notify.Dispose() } catch { }
}

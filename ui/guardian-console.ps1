# guardian-console.ps1 — 双击桌面快捷方式后出现的黑色命令行窗口
# 显示后端基础健康信息；关闭本窗口不影响后端（后端由托盘宿主独立持有）。

param(
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'guardian-lib.ps1')

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $Host.UI.RawUI.WindowTitle = 'DSH Guardian · 后端状态' } catch { }

function Get-DisplayWidth([string]$text) {
  $width = 0
  foreach ($ch in $text.ToCharArray()) {
    $code = [int][char]$ch
    if (($code -ge 0x1100 -and $code -le 0x115F) -or
        ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
        ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
        ($code -ge 0xF900 -and $code -le 0xFAFF) -or
        ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
        ($code -ge 0xFF00 -and $code -le 0xFF60) -or
        ($code -ge 0xFFE0 -and $code -le 0xFFE6)) {
      $width += 2
    } else {
      $width += 1
    }
  }
  return $width
}

function Write-Label([string]$text) {
  $pad = 12 - (Get-DisplayWidth $text)
  if ($pad -lt 1) { $pad = 1 }
  Write-Host ('  ' + $text + (' ' * $pad)) -NoNewline -ForegroundColor DarkGray
}

function Show-Accent([string]$text, [string]$color = 'Gray') {
  Write-Host $text -ForegroundColor $color
}

function Show-Frame {
  param(
    $Health,
    $BackendPid,
    [string]$Note
  )

  $now = Get-Date
  $data = $Health.Data
  $st = $null
  if ($data) { $st = $data.status }

  Write-Host ''
  Write-Host '  ============================================================' -ForegroundColor DarkCyan
  Write-Host '    DSH GUARDIAN  ·  后端状态' -ForegroundColor Cyan
  Write-Host '  ============================================================' -ForegroundColor DarkCyan

  Write-Label '时间'
  Show-Accent $now.ToString('yyyy-MM-dd HH:mm:ss') 'Gray'

  Write-Label '服务'
  if ($Health.Ok -and $BackendPid) {
    Show-Accent ($GuardianPaths.Url + '  [运行中 PID ' + $BackendPid + ']  响应 ' + $Health.Ms + ' ms') 'Green'
  } elseif ($BackendPid) {
    Show-Accent ($GuardianPaths.Url + '  [无响应 PID ' + $BackendPid + ']') 'Yellow'
  } else {
    Show-Accent ($GuardianPaths.Url + '  [未运行]') 'Red'
  }

  Write-Label '实例'
  if ($st -and $st.instance -and $st.instance.rootPid) {
    $inst = $st.instance
    $txt = 'PID ' + $inst.rootPid + ' · 端口 ' + $inst.port + ' · HTTP ' + $inst.httpStatus
    if ($inst.healthy) {
      Show-Accent ($txt + ' · 健康') 'Green'
    } else {
      Show-Accent ($txt + ' · 异常') 'Yellow'
    }
  } else {
    Show-Accent '未运行（无实例）' 'DarkGray'
  }

  Write-Label '安全模式'
  if ($st) {
    if ($st.safe) { Show-Accent 'ON（patch 行已全部禁用）' 'Yellow' }
    else { Show-Accent 'OFF' 'Green' }
  } else {
    Show-Accent '—' 'DarkGray'
  }

  Write-Label '漂移检测'
  if ($st -and $st.drift) {
    if ($st.drift.detected) {
      $cnt = '+{0} ~{1} -{2}' -f @($st.drift.addedPaths).Count, @($st.drift.changedPaths).Count, @($st.drift.removedPaths).Count
      Show-Accent ('有漂移（' + $cnt + '）') 'Red'
    } else {
      Show-Accent '无漂移' 'Green'
    }
  } else {
    Show-Accent '—' 'DarkGray'
  }

  Write-Label '最近良好'
  if ($data -and $data.lkg) {
    $lkgName = [string]$data.lkg.label
    $lkgDigest = Format-GuardianShortDigest $data.lkg.digest
    if ($lkgName -eq 'last-known-good') {
      Show-Accent ($lkgDigest + '  （标签 last-known-good）') 'Gray'
    } else {
      Show-Accent ($lkgName + ' · ' + $lkgDigest) 'Gray'
    }
  } else {
    Show-Accent '（无最近良好快照）' 'DarkGray'
  }

  Write-Label '最新快照'
  if ($data -and $data.latestSnapshot) {
    $snapAt = ''
    try { $snapAt = ([datetime]$data.latestSnapshot.createdAt).ToString('yyyy-MM-dd HH:mm:ss') } catch { $snapAt = [string]$data.latestSnapshot.createdAt }
    Show-Accent ($data.latestSnapshot.label + ' · ' + $snapAt) 'Gray'
  } else {
    Show-Accent '—' 'DarkGray'
  }

  Write-Label '存储'
  if ($data -and $data.store) {
    $txCount = 0
    if ($data.transactions) { $txCount = @($data.transactions).Count }
    Show-Accent ((Format-GuardianBytes $data.store.bytes) + ' · ' + $data.store.blobs + ' 个数据块 · 事务 ' + $txCount) 'Gray'
  } else {
    Show-Accent '—' 'DarkGray'
  }

  Write-Label '未完成'
  if ($st -and $st.activeOperation) {
    $op = $st.activeOperation
    Show-Accent ('存在未完成操作：' + $op.op + ' / ' + $op.phase + ' / ' + $op.txid + '（建议 recover）') 'Red'
  } else {
    Show-Accent '无' 'DarkGray'
  }

  if (-not $Health.Ok -and $Health.Error) {
    Write-Label '错误'
    Show-Accent $Health.Error 'DarkGray'
  }

  Write-Host ''
  Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
  Write-Host ('  日志  ' + (Join-Path $GuardianPaths.LogDir 'ui-server.log')) -ForegroundColor DarkGray
  Write-Host '  提示  关闭本窗口不会停止后端；右键托盘图标可退出后端' -ForegroundColor DarkGray
  if (-not $Once) {
    Write-Host '  按键  Q 退出窗口    O 打开网页    T 重启后端' -ForegroundColor DarkGray
  }
  Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
  if ($Note) {
    Write-Host ('  ' + $Note) -ForegroundColor DarkYellow
  }
}

# ---------- 确保托盘与后端 ----------
$trayPid = $null
try { $trayPid = Get-GuardianTrayPid } catch { }
if (-not $trayPid) {
  $trayPid = Start-GuardianTray
}

$health = Get-GuardianHealth
$deadline = (Get-Date).AddSeconds(15)
while (-not $health.Ok -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $health = Get-GuardianHealth
}
$backendPid = Get-BackendPid

if ($Once) {
  Show-Frame -Health $health -BackendPid $backendPid -Note ''
  exit 0
}

# ---------- 交互循环 ----------
$hadConsole = $true
try { [Console]::CursorVisible = $false } catch { $hadConsole = $false }

$exitNote = ''
try {
  while ($true) {
    $health = Get-GuardianHealth
    $backendPid = Get-BackendPid
    Clear-Host
    $note = ''
    if (-not $health.Ok) {
      if ($backendPid) {
        $note = '后端存在但未响应；托盘会在 5 秒内重试。按 T 立即重启。'
      } else {
        $note = '后端未运行；若托盘已退出，请重新双击桌面快捷方式或按 T 重启。'
      }
    }
    Show-Frame -Health $health -BackendPid $backendPid -Note $note

    $keyPressed = $false
    $key = $null
    try {
      if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        $keyPressed = $true
      }
    } catch { }

    if ($keyPressed) {
      if ($key.Key -eq 'Q') {
        $exitNote = '已关闭状态窗口；后端继续在托盘运行。'
        break
      } elseif ($key.Key -eq 'O') {
        Start-Process $GuardianPaths.Url
      } elseif ($key.Key -eq 'T') {
        if (-not $backendPid) { Start-GuardianBackendDetached }
        else { Start-GuardianBackendDetached }
      }
    }

    Start-Sleep -Milliseconds 1800
  }
} finally {
  if ($hadConsole) {
    try { [Console]::CursorVisible = $true } catch { }
  }
}

if ($exitNote) {
  Write-Host ''
  Write-Host ('  ' + $exitNote) -ForegroundColor DarkCyan
  Write-Host ''
}

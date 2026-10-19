# guardian-setup.ps1 — 一次性安装：生成图标、桌面快捷方式、开机自启，并启动托盘
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ui\guardian-setup.ps1

param(
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'guardian-lib.ps1')

Write-Host ''
Write-Host '=== DSH Guardian 安装 ===' -ForegroundColor Cyan

# 1) 图标
if (-not (Test-Path -LiteralPath $GuardianPaths.Icon)) {
  & (Join-Path $PSScriptRoot 'make-icon.ps1')
} else {
  Write-Host ('图标已存在: ' + $GuardianPaths.Icon) -ForegroundColor DarkGray
}

# 2) 桌面快捷方式
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) {
  throw '无法定位桌面目录。'
}
$lnkPath = Join-Path $desktop 'DSH Guardian.lnk'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath = $psExe
$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $GuardianPaths.ConsoleScript + '"'
$sc.WorkingDirectory = $GuardianPaths.Root
$sc.IconLocation = $GuardianPaths.Icon + ',0'
$sc.Description = '启动 DSH Guardian 后端状态窗口（后端常驻托盘）'
$sc.WindowStyle = 1
$sc.Save()
Write-Host ('桌面快捷方式: ' + $lnkPath) -ForegroundColor Green

# 3) 开机自启（登录时静默启动托盘 + 后端）
Set-GuardianStartup $true
Write-Host ('开机自启: ' + (Get-GuardianStartupShortcut)) -ForegroundColor Green

# 4) 启动托盘（托盘内部会拉起后端）
if (-not $NoStart) {
  $trayPid = Start-GuardianTray
  if (-not $trayPid) {
    Write-Host '托盘启动失败：请检查 ExecutionPolicy 或手动运行 guardian-tray.vbs。' -ForegroundColor Red
  } else {
    Write-Host ('托盘进程: PID ' + $trayPid) -ForegroundColor Green
  }

  $health = Get-GuardianHealth
  $deadline = (Get-Date).AddSeconds(20)
  while (-not $health.Ok -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $health = Get-GuardianHealth
  }
  $bp = Get-BackendPid
  if ($bp) {
    Write-Host ('后端进程: PID ' + $bp + '  ' + $GuardianPaths.Url + '  监听 127.0.0.1:' + $GuardianPaths.Port) -ForegroundColor Green
  } else {
    Write-Host '后端未启动：请查看 logs\ui-server.err.log。' -ForegroundColor Red
  }
  if ($health.Ok) {
    Write-Host ('健康检查: OK（响应 ' + $health.Ms + ' ms）') -ForegroundColor Green
  } else {
    Write-Host '健康检查: 未通过（后端可能仍在启动）。' -ForegroundColor Yellow
  }
}

# 5) 汇总
Write-Host ''
Write-Host '=== 完成 ===' -ForegroundColor Cyan
Write-Host '  双击桌面「DSH Guardian」→ 黑色状态窗口；关闭窗口后端继续运行。' -ForegroundColor Gray
Write-Host '  托盘图标右键 → 打开 Guardian UI / 打开状态窗口 / 重启后端 / 停止后端 / 退出后端 / 开机自启。' -ForegroundColor Gray
Write-Host ('  开机自启项: ' + (Get-GuardianStartupShortcut)) -ForegroundColor DarkGray
Write-Host ''

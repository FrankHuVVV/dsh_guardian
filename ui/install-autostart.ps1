<#
.SYNOPSIS
  注册 / 卸载 DSH Guardian 的静默提权开机自启（Windows 任务计划程序）。

.DESCRIPTION
  DeepSeek Harness.exe 带 RUNASADMIN 标志：后端如果不是管理员权限，拉起客户端会 EACCES。
  Startup 目录里的快捷方式无法提权，所以本脚本改用计划任务：

    任务名 : DSH Guardian AutoStart
    动作   : wscript.exe "<GUARDIAN_ROOT>\ui\guardian-tray.vbs"
    触发器 : 当前用户登录时（AtLogOn）
    主体   : 当前用户，RunLevel = Highest（完整管理员令牌，登录时无 UAC 弹窗）
    条件   : 允许电池模式启动 / 不因切换到电池而停止 / 无执行时长上限 / 忽略重复实例

  注册需要管理员权限；脚本会自动请求提权（UAC 一次）。注册成功后同时删除
  Startup 目录下的旧快捷方式，避免登录时双开。

.PARAMETER Uninstall
  删除计划任务（并清理旧 Startup 快捷方式）。

.PARAMETER Status
  只读：打印任务配置与当前托盘的提权状态，不改任何东西。

.PARAMETER Verify
  只读：检查当前托盘进程（logs\tray.pid）是否以管理员令牌运行。

.PARAMETER NoElevate
  不提权，直接在当前会话执行（未提权时注册会失败，用于调试）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File ui\install-autostart.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ui\install-autostart.ps1 -Status
  powershell -NoProfile -ExecutionPolicy Bypass -File ui\install-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Verify,
  [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'guardian-lib.ps1')

# ---------------------------------------------------------------- 提权

function Request-GuardianElevation {
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($Uninstall) { $argList += '-Uninstall' }
  if ($Status) { $argList += '-Status' }
  if ($Verify) { $argList += '-Verify' }
  Write-Host '[install-autostart] 需要管理员权限，正在请求提权（UAC 一次）...' -ForegroundColor Yellow
  try {
    Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $argList | Out-Null
    exit 0
  } catch {
    Write-Host '[install-autostart] 提权被拒绝或失败。请右键「以管理员身份运行」后重试。' -ForegroundColor Red
    exit 2
  }
}

if (-not $Status -and -not $Verify -and -not (Test-GuardianElevated) -and -not $NoElevate) {
  Request-GuardianElevation
}

# ---------------------------------------------------------------- 进程提权探测（P/Invoke）

function Test-GuardianProcessElevated {
  param([int]$ProcessId)
  if (-not ('Guardian.TokenProbe' -as [type])) {
    Add-Type -Namespace Guardian -Name TokenProbe -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr OpenProcess(uint access, bool inherit, int pid);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
public static extern bool OpenProcessToken(System.IntPtr process, uint access, out System.IntPtr token);
[System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
public static extern bool GetTokenInformation(System.IntPtr token, int cls, out int info, int len, out int ret);
'@
  }
  $PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  $TOKEN_QUERY = 0x0008
  $TokenElevation = 20
  $h = [Guardian.TokenProbe]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, $ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $null }
  try {
    $tok = [IntPtr]::Zero
    if (-not [Guardian.TokenProbe]::OpenProcessToken($h, $TOKEN_QUERY, [ref]$tok)) { return $null }
    try {
      $info = 0
      $ret = 0
      if (-not [Guardian.TokenProbe]::GetTokenInformation($tok, $TokenElevation, [ref]$info, 4, [ref]$ret)) { return $null }
      return ($info -ne 0)
    } finally { [void][Guardian.TokenProbe]::CloseHandle($tok) }
  } finally { [void][Guardian.TokenProbe]::CloseHandle($h) }
}

# ---------------------------------------------------------------- 状态输出

function Write-TaskStatus {
  $task = Get-GuardianAutostartTask
  if (-not $task) {
    Write-Host '[install-autostart] 未注册计划任务：DSH Guardian AutoStart' -ForegroundColor Yellow
    return $false
  }
  $action = @($task.Actions)[0]
  $principal = $task.Principal
  $settings = $task.Settings
  $trigger = @($task.Triggers)[0]
  Write-Host '=== DSH Guardian AutoStart ===' -ForegroundColor Cyan
  Write-Host ('  任务状态    : ' + [string]$task.State)
  Write-Host ('  运行主体    : ' + [string]$principal.UserId)
  Write-Host ('  RunLevel    : ' + [string]$principal.RunLevel)
  Write-Host ('  登录类型    : ' + [string]$principal.LogonType)
  Write-Host ('  动作        : ' + [string]$action.Execute + ' ' + [string]$action.Arguments)
  Write-Host ('  工作目录    : ' + [string]$action.WorkingDirectory)
  Write-Host ('  触发器      : ' + $trigger.CimClass.CimClassName)
  Write-Host ('  允许电池启动: ' + (-not [bool]$settings.DisallowStartIfOnBatteries))
  Write-Host ('  电池时不停止: ' + (-not [bool]$settings.StopIfGoingOnBatteries))
  Write-Host ('  执行时长上限: ' + [string]$settings.ExecutionTimeLimit)
  return $true
}

function Write-TrayElevation {
  $pidFile = $GuardianPaths.TrayPidFile
  if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host '[install-autostart] 没有 logs\tray.pid：托盘当前未运行。' -ForegroundColor Yellow
    return $null
  }
  $trayPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$trayPid)) {
    Write-Host '[install-autostart] tray.pid 内容无效。' -ForegroundColor Red
    return $null
  }
  $proc = Get-Process -Id $trayPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Write-Host ('[install-autostart] tray.pid 指向的进程 {0} 已不存在（托盘未运行）。' -f $trayPid) -ForegroundColor Yellow
    return $null
  }
  $elevated = Test-GuardianProcessElevated -ProcessId $trayPid
  $label = '未知'
  if ($elevated -eq $true) { $label = '是（管理员）' }
  elseif ($elevated -eq $false) { $label = '否（普通权限）' }
  Write-Host ('  托盘 PID    : ' + $trayPid + '  (' + $proc.ProcessName + ')')
  Write-Host ('  管理员令牌  : ' + $label)
  return $elevated
}

# ---------------------------------------------------------------- 主流程

Write-Host ''
if ($Status -or $Verify) {
  if ($Status) { [void](Write-TaskStatus) }
  if ($Verify) { [void](Write-TrayElevation) }
  exit 0
}

if ($Uninstall) {
  $removed = Uninstall-GuardianAutostart
  $lnk = Get-GuardianStartupShortcut
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue }
  Write-Host ('[install-autostart] 已删除计划任务: ' + [bool]$removed) -ForegroundColor Green
  Write-Host '[install-autostart] 开机自启已关闭。' -ForegroundColor Green
  exit 0
}

# 注册（同时清理旧 Startup 快捷方式）
$legacy = Get-GuardianStartupShortcut
if (Test-Path -LiteralPath $legacy) {
  Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue
  Write-Host ('[install-autostart] 已删除旧 Startup 快捷方式: ' + $legacy) -ForegroundColor Green
}

$task = Install-GuardianAutostart
if (-not $task) {
  Write-Host '[install-autostart] 注册失败：Get-ScheduledTask 未返回任务。' -ForegroundColor Red
  exit 3
}

Write-Host '[install-autostart] 计划任务注册成功（登录时静默提权启动托盘）' -ForegroundColor Green
[void](Write-TaskStatus)
Write-Host ''
Write-Host '  下一步（可选）：Start-ScheduledTask -TaskName "DSH Guardian AutoStart"' -ForegroundColor DarkGray
Write-Host '  注意：托盘是单实例的，触发前请先退出正在运行的托盘（托盘菜单 → 退出后端并关闭托盘）。' -ForegroundColor DarkGray
Write-Host ''
exit 0

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

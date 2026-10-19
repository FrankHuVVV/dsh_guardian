# install.ps1 - DSH Guardian v5.1.1 one-click setup wizard (Windows)
# Called by install.bat with administrator rights. Writes only config.local.json and
# starts the existing UI/tray - bin\guardian.mjs and ui\server.mjs are not modified.
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$configPath = Join-Path $Root 'config.json'
$localConfigPath = Join-Path $Root 'config.local.json'
$taskName = 'DSH Guardian AutoStart'
$uiUrl = 'http://127.0.0.1:3081'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-Step([string]$Text) { Write-Host ''; Write-Host ("==> " + $Text) -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host ("    " + $Text) -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host ("    " + $Text) -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host ("    " + $Text) -ForegroundColor Red }

function Set-JsonValue {
  param($Object, [string]$Name, $Value)
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  } else {
    $prop.Value = $Value
  }
}

function Merge-JsonObject {
  param($Target, $Source)
  foreach ($prop in $Source.PSObject.Properties) {
    $targetProp = $Target.PSObject.Properties[$prop.Name]
    if ($null -eq $targetProp) {
      $Target | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
    } elseif ($targetProp.Value -is [System.Management.Automation.PSCustomObject] -and $prop.Value -is [System.Management.Automation.PSCustomObject]) {
      Merge-JsonObject -Target $targetProp.Value -Source $prop.Value
    } else {
      $targetProp.Value = $prop.Value
    }
  }
}

Write-Host ''
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '   DSH Guardian v5.1.1 - One-Click Setup' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------- 1. Node.js
Write-Step 'Checking Node.js'
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Fail 'Node.js was not found on PATH.'
  Write-Fail 'Install Node.js 22 or newer (LTS) from https://nodejs.org/ and run install.bat again.'
  exit 1
}
$nodeExe = $nodeCmd.Source
Write-Ok ("Node.js: " + (& $nodeExe --version))

# ---------------------------------------------------------------- 2. DSH data directory
Write-Step 'DSH data directory'
$defaultHome = Join-Path $env:USERPROFILE '.dsh'
$inputHome = Read-Host ("Enter the DSH data directory [default: " + $defaultHome + "]")
if ([string]::IsNullOrWhiteSpace($inputHome)) { $inputHome = $defaultHome }
$inputHome = $inputHome.Trim().Trim('"').Trim("'")
$inputHome = [Environment]::ExpandEnvironmentVariables($inputHome)
if (-not [System.IO.Path]::IsPathRooted($inputHome)) {
  $inputHome = Join-Path (Get-Location).Path $inputHome
}
$dshHome = [System.IO.Path]::GetFullPath($inputHome)
while ($dshHome.Length -gt 3 -and ($dshHome.EndsWith('\') -or $dshHome.EndsWith('/'))) {
  $dshHome = $dshHome.Substring(0, $dshHome.Length - 1)
}
if (-not (Test-Path -LiteralPath $dshHome -PathType Container)) {
  Write-Warn ("Directory does not exist yet: " + $dshHome)
  Write-Warn 'Make sure this is the folder that contains DSH profiles, mcp and storages.'
}

# ---------------------------------------------------------------- 3. Merge config -> config.local.json
Write-Step 'Writing config.local.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  Write-Fail ("config.json is missing: " + $configPath)
  exit 1
}
try {
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Write-Fail ("config.json is not valid JSON: " + $_.Exception.Message)
  exit 1
}

if (Test-Path -LiteralPath $localConfigPath) {
  try {
    $local = Get-Content -LiteralPath $localConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Merge-JsonObject -Target $config -Source $local
    Write-Ok 'Merged the existing config.local.json (local keys kept).'
  } catch {
    Write-Warn 'Existing config.local.json is unreadable and will be replaced.'
  }
}

$profileName = 'desktop'
if ($config.profile) { $profileName = [string]$config.profile }
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $profileName)
Set-JsonValue -Object $config -Name 'dshHome' -Value $dshHome
Set-JsonValue -Object $config -Name 'profileDir' -Value $profileDir

# UTF-8 without BOM: Node's JSON.parse rejects a leading BOM.
$jsonText = ($config | ConvertTo-Json -Depth 32) + [Environment]::NewLine
[System.IO.File]::WriteAllText($localConfigPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok ("dshHome    : " + $dshHome)
Write-Ok ("profileDir : " + $profileDir)

# ---------------------------------------------------------------- 4. Autostart task (highest privileges)
Write-Step ('Scheduled task: ' + $taskName)
$hasTask = $false
try {
  $hasTask = $null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
} catch {
  $hasTask = $false
}
if ($hasTask) {
  Write-Ok 'Already registered, keeping the existing task.'
} else {
  $autostartScript = Join-Path $Root 'ui\install-autostart.ps1'
  try {
    if (Test-Path -LiteralPath $autostartScript) {
      & $psExe -NoProfile -ExecutionPolicy Bypass -File $autostartScript -NoElevate
      if ($LASTEXITCODE -ne 0) { throw ('install-autostart.ps1 exited with code ' + $LASTEXITCODE) }
    } else {
      # Inline fallback: same task definition used by ui\install-autostart.ps1.
      $trayVbs = Join-Path $Root 'ui\guardian-tray.vbs'
      $wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
      $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      $action = New-ScheduledTaskAction -Execute $wscriptExe -Argument ('"' + $trayVbs + '"') -WorkingDirectory $Root
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
      $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    }
    Write-Ok 'Registered (current user, highest privileges, at logon).'
  } catch {
    Write-Warn ('Autostart registration failed: ' + $_.Exception.Message)
    Write-Warn 'Run install.bat as administrator to retry, or register it later from the tray menu.'
  }
}

# ---------------------------------------------------------------- 5. Start backend + tray
Write-Step 'Starting the UI backend'
$serverScript = Join-Path $Root 'ui\server.mjs'
if (-not (Test-Path -LiteralPath $serverScript)) {
  Write-Fail ("ui\server.mjs is missing: " + $serverScript)
  exit 1
}
Start-Process -FilePath $nodeExe -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $Root -WindowStyle Hidden
Write-Ok ("Backend: " + $uiUrl)
Start-Sleep -Seconds 1

Write-Step 'Starting the tray icon'
$trayVbs = Join-Path $Root 'ui\guardian-tray.vbs'
if (Test-Path -LiteralPath $trayVbs) {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $trayVbs + '"') -WorkingDirectory $Root
  Write-Ok 'Tray started (single instance; harmless if it was already running).'
} else {
  Write-Warn 'ui\guardian-tray.vbs not found, skipped.'
}

Start-Sleep -Seconds 2

# ---------------------------------------------------------------- 6. Open browser
Write-Step 'Opening the console'
Start-Process $uiUrl

Write-Host ''
Write-Host '安装成功 / Installation complete.' -ForegroundColor Green
Write-Host ("  Console : " + $uiUrl)
Write-Host '  Tray    : right-click the guardian icon for status / restart / autostart.'
Write-Host '  Config  : config.local.json (edit only if your paths change).'
Write-Host ''
exit 0

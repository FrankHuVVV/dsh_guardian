# build-release.ps1 - build a clean, self-contained DSH Guardian release zip.
# Only native PowerShell + Compress-Archive; no third-party modules.
[CmdletBinding()]
param(
  [string]$Version = '5.1.1'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $Root 'release-package'
$zipPath = Join-Path $Root ("dsh_guardian-v{0}.zip" -f $Version)

# Files and folders that must ship. Everything else stays out of the zip.
$includeItems = @(
  'bin',
  'ui',
  'scripts',
  'config.json',
  'state.template.json',
  'install.bat',
  'install.ps1',
  'README.md',
  'README_EN.md',
  'LICENSE',
  'AGENTS.md'
)

# Dynamic / sensitive artifacts that must never ship.
$excludeNames = @(
  '.git',
  'backups',
  'logs',
  'sandbox',
  'fixtures',
  'release-package',
  '.guardian.lock',
  'config.local.json',
  'state.json'
)
$excludePatterns = @('*.bak', '*.bak-*', '*.bak.*', '*.log', '*.tmp')

function Test-ExcludedRelativePath {
  param([string]$RelativePath)
  foreach ($part in ($RelativePath -split '[\\/]')) {
    if ($excludeNames -contains $part) { return $true }
    foreach ($pattern in $excludePatterns) {
      if ($part -like $pattern) { return $true }
    }
  }
  return $false
}

function Copy-ReleaseItem {
  param([string]$Relative)
  $source = Join-Path $Root $Relative
  if (-not (Test-Path -LiteralPath $source)) {
    throw ("Required release item is missing: " + $Relative)
  }
  if (Test-Path -LiteralPath $source -PathType Container) {
    Get-ChildItem -LiteralPath $source -Recurse -Force -File | ForEach-Object {
      $relativePath = $_.FullName.Substring($Root.Length).TrimStart([char[]]@('\', '/'))
      if (Test-ExcludedRelativePath $relativePath) { return }
      $destination = Join-Path $stage $relativePath
      $destinationDir = Split-Path -Parent $destination
      if (-not (Test-Path -LiteralPath $destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
      }
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
  } else {
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage $Relative) -Force
  }
}

if ((Split-Path -Parent $stage) -ne $Root -or (Split-Path -Leaf $stage) -ne 'release-package') {
  throw ('Refusing to clean an unexpected staging path: ' + $stage)
}

try {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  foreach ($item in $includeItems) {
    Copy-ReleaseItem -Relative $item
  }

  $stagedFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force)
  $violations = @()
  foreach ($file in $stagedFiles) {
    $relativePath = $file.FullName.Substring($stage.Length).TrimStart([char[]]@('\', '/'))
    if (Test-ExcludedRelativePath $relativePath) { $violations += $relativePath }
  }
  if ($violations.Count -gt 0) {
    throw ('Release package contains excluded files: ' + ($violations -join ', '))
  }

  $required = @(
    'install.bat',
    'install.ps1',
    'config.json',
    'state.template.json',
    'README.md',
    'README_EN.md',
    'LICENSE',
    'AGENTS.md',
    'bin\guardian.mjs',
    'ui\server.mjs',
    'ui\guardian-tray.vbs',
    'scripts\build-release.ps1'
  )
  foreach ($item in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $item))) {
      throw ('Release package is missing: ' + $item)
    }
  }

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force

  # Verify what actually landed in the archive.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $zipViolations = @()
    foreach ($entry in $archive.Entries) {
      if ([string]::IsNullOrEmpty($entry.Name)) { continue }
      if (Test-ExcludedRelativePath $entry.FullName) { $zipViolations += $entry.FullName }
    }
    if ($zipViolations.Count -gt 0) {
      throw ('Zip contains excluded files: ' + ($zipViolations -join ', '))
    }
    $fileCount = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) }).Count
  } finally {
    $archive.Dispose()
  }

  $sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
  Write-Host ''
  Write-Host '=== Release package built ===' -ForegroundColor Green
  Write-Host ("  File  : " + $zipPath)
  Write-Host ("  Size  : " + $sizeMb + " MB")
  Write-Host ("  Files : " + $fileCount)
  Write-Host '  Excluded: .git, backups, logs, sandbox, fixtures, config.local.json, state.json, *.bak'
} finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

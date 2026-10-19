# guardian-start-backend.ps1 — 由 guardian-start.vbs 以隐藏进程调用，只负责拉起后端
$ErrorActionPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'guardian-lib.ps1')

try {
  $null = Start-GuardianBackend
} catch { }

exit 0

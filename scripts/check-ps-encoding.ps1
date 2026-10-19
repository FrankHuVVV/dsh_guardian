<#
.SYNOPSIS
  检查（并可修复）仓库内 .ps1 的 UTF-8 BOM —— powershell.exe 5.1 的硬性要求。

.DESCRIPTION
  Windows PowerShell 5.1 读取「无 BOM 的 UTF-8」脚本时会按 OEM 代码页（中文系统是 936）
  解码：中文注释/字符串变乱码，某些字节还会吃掉引号或反斜杠，导致整脚本语法错误。
  托盘由 ui\guardian-tray.vbs 以 powershell.exe 启动，因此 ui\*.ps1 必须带 BOM。

  任何编辑器或批量改写工具都可能把 BOM 写丢。改完 .ps1 请跑本脚本：

    pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ps-encoding.ps1        # 只检查
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ps-encoding.ps1 -Fix   # 补 BOM

  退出码：0 = 全部合规（或已修复成功）；1 = 存在缺 BOM 的文件（未加 -Fix）。

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ps-encoding.ps1 -Fix
#>
[CmdletBinding()]
param(
  [string]$GuardianRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Fix
)

$ErrorActionPreference = 'Stop'
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

$targets = @()
foreach ($dir in @('ui', 'scripts')) {
  $path = Join-Path $GuardianRoot $dir
  if (Test-Path -LiteralPath $path) {
    $targets += @(Get-ChildItem -LiteralPath $path -Filter '*.ps1' -File -ErrorAction SilentlyContinue)
  }
}

if ($targets.Count -eq 0) {
  Write-Host "[check-ps-encoding] 未找到任何 .ps1（root=$GuardianRoot）"
  exit 0
}

$missing = New-Object System.Collections.Generic.List[string]
$fixedList = New-Object System.Collections.Generic.List[string]

foreach ($file in $targets) {
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
  $nonAscii = 0
  foreach ($ch in $text.ToCharArray()) { if ([int]$ch -gt 127) { $nonAscii++ } }

  if ($hasBom) {
    Write-Verbose ("BOM OK   {0} (非 ASCII {1})" -f $file.Name, $nonAscii)
    continue
  }

  $missing.Add($file.Name) | Out-Null
  if ($Fix) {
    [IO.File]::WriteAllText($file.FullName, $text, $utf8Bom)
    $fixedList.Add($file.Name) | Out-Null
    Write-Host ("[FIX] 已补 BOM: {0}（非 ASCII {1} 字符）" -f $file.Name, $nonAscii)
  } else {
    Write-Host ("[MISS] 缺 BOM: {0}（非 ASCII {1} 字符）—— powershell.exe 5.1 下会乱码/语法错误" -f $file.Name, $nonAscii)
  }
}

Write-Host ("[check-ps-encoding] 扫描 {0} 个 .ps1：合规 {1} 个，缺 BOM {2} 个{3}" -f `
  $targets.Count, ($targets.Count - $missing.Count), $missing.Count,
  ($(if ($Fix) { "，已修复 $($fixedList.Count) 个" } else { '' })))

if ($missing.Count -eq 0) { exit 0 }
if ($Fix -and $fixedList.Count -eq $missing.Count) { exit 0 }
exit 1

<#
.SYNOPSIS
  按需重建 fixtures 夹具目录（fixtures\sandbox\root 与 home），不入库。

.DESCRIPTION
  fixtures\sandbox\root\home 曾达 69MB（其中 64MB 是 live profile 的陈旧副本），
  已于「第 3 步」删除并改为最小骨架 + 按需重建：
    - 默认：ui\sandbox-init.mjs --fixture-only 生成 KB 级骨架（profile/storages/mcp/plugins）
    - 接近生产：node ui\sandbox-init.mjs --fixture-home=copy 从 live ~/.dsh 复制
  group1~4 等验证脚本在运行前调用本脚本，保证夹具存在且体积最小。

.EXAMPLE
  & .\scripts\ensure-fixture-home.ps1 -GuardianRoot D:\dsh_plugin\dsh_guardian
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$GuardianRoot,
  [switch]$CopyFromLive
)

$fixtureHome = Join-Path $GuardianRoot 'fixtures\sandbox\root\home'
$fixtureConfig = Join-Path $GuardianRoot 'fixtures\sandbox\root\config.json'
if ((Test-Path -LiteralPath $fixtureHome) -and (Test-Path -LiteralPath $fixtureConfig)) {
  Write-Verbose "[ensure-fixture-home] 已存在: $fixtureHome"
  return 0
}

$init = Join-Path $GuardianRoot 'ui\sandbox-init.mjs'
if (-not (Test-Path -LiteralPath $init)) {
  Write-Warning "[ensure-fixture-home] 未找到 $init"
  return 1
}

$initArgs = @($init, '--fixture-only')
if ($CopyFromLive) { $initArgs = @($init, '--fixture-home=copy') }
& node @initArgs | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "[ensure-fixture-home] 重建失败，退出码 $LASTEXITCODE"
  return $LASTEXITCODE
}
$bytes = (Get-ChildItem -LiteralPath $fixtureHome -Recurse -Force -ErrorAction SilentlyContinue |
  Measure-Object -Property Length -Sum).Sum
Write-Host ('[ensure-fixture-home] 已重建 {0}（{1:N2} MB）' -f $fixtureHome, ($bytes / 1MB))
return 0

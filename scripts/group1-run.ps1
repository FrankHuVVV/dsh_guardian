<#
.SYNOPSIS
  DSH Guardian 组 1（步骤 3–5）一键执行脚本。

.DESCRIPTION
  在 DeepSeek Harness 完全退出后，从“外部” PowerShell 运行（不要在 DSH 里跑）：

    powershell -NoProfile -ExecutionPolicy Bypass -File D:\dsh_plugin\dsh_guardian\scripts\group1-run.ps1
    pwsh      -NoProfile -ExecutionPolicy Bypass -File D:\dsh_plugin\dsh_guardian\scripts\group1-run.ps1

  行为：
    1) 断言无 DeepSeek 进程；有则中止（绝不 kill，退出码 2）
    2) runtime-inventory → 记录 digest-at-client-stopped
    3) C2 手工全量基线：package.json / pnpm-lock.yaml / cordis.patch.yml / node_modules / mcp / storages
       （node_modules、mcp、storages 用 robocopy /E /XJ，跳过 junction，避免跟随到 D:\Github\novel_assistance）
    4) C3 完整性摘要：总文件数/字节数、node_modules 文件数与 inventory 期望值比对（±50）
    5) D1 校验/写入 SAFE-MODE.md（内容与提示词原文+备注一致）
    6) 输出 RESULT 块（机器可读）与日志路径

  退出码：0 = 全部 PASS；2 = 因客户端未退出而中止；3 = 存在 FAIL
#>

[CmdletBinding()]
param(
  [string]$GuardianRoot = 'D:\dsh_plugin\dsh_guardian'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 夹具按需重建（fixtures\sandbox\home 不入库，曾 69MB）；失败不阻塞主流程
try {
  $ensureFixture = Join-Path $PSScriptRoot 'ensure-fixture-home.ps1'
  if (Test-Path -LiteralPath $ensureFixture) { & $ensureFixture -GuardianRoot $GuardianRoot | Out-Null }
} catch { Write-Warning "[fixture] 自动重建失败: $($_.Exception.Message)" }
$startedAt = Get-Date

$GuardianRoot = [IO.Path]::GetFullPath($GuardianRoot)
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $GuardianRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("group1-run-$ts.log")
$BaseDir = Join-Path $GuardianRoot ("manual-baseline-$ts")
$DshHome = Join-Path $env:USERPROFILE '.dsh'
$ProfileDir = Join-Path $DshHome 'profiles\desktop'
$GuardianBin = Join-Path $GuardianRoot 'bin\guardian.mjs'
$SnapMeta = Join-Path $GuardianRoot 'backups\snap-a\meta.json'
$SafeModePath = Join-Path $GuardianRoot 'SAFE-MODE.md'
$InvJson = Join-Path $LogDir ("group1-inventory-$ts.json")

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Results = [ordered]@{}

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
  [IO.File]::AppendAllText($LogPath, ($line + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host $line
}

function Add-Failure {
  param([string]$Item, [string]$Detail)
  $script:Failures.Add(("{0} :: {1}" -f $Item, $Detail)) | Out-Null
  Write-Log ("FAIL {0} :: {1}" -f $Item, $Detail) 'FAIL'
}

function Add-Pass {
  param([string]$Item, [string]$Detail = '')
  Write-Log ("PASS {0} {1}" -f $Item, $Detail)
}

function Write-ResultBlock {
  param([string]$Overall)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('RESULT_BEGIN')
  foreach ($key in $script:Results.Keys) { $lines.Add(('{0}={1}' -f $key, $script:Results[$key])) }
  $lines.Add(('failures={0}' -f $script:Failures.Count))
  foreach ($f in $script:Failures) { $lines.Add(('failure={0}' -f $f)) }
  $lines.Add(('overall={0}' -f $Overall))
  $lines.Add('RESULT_END')
  $block = ($lines -join "`r`n")
  [IO.File]::AppendAllText($LogPath, ($block + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ''
  Write-Host $block
}

function Normalize-Text {
  param([string]$Text)
  if ($null -eq $Text) { return '' }
  $t = ($Text -replace "`r`n", "`n") -replace "`r", "`n"
  return ($t -replace "`n+$", '')
}

function Copy-Tree {
  param([string]$Source, [string]$Destination, [string]$Label)
  if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }
  $rcArgs = @($Source, $Destination, '/E', '/XJ', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  & robocopy @rcArgs | Out-Null
  $code = $LASTEXITCODE
  Write-Log ("robocopy {0}: exit={1} (source={2})" -f $Label, $code, $Source)
  if ($code -ge 8) { Add-Failure $Label ("robocopy exit $code"); return $false }
  return $true
}

# ---------------------------------------------------------------- 0. header
Write-Log ("guardian root : {0}" -f $GuardianRoot)
Write-Log ("profile dir   : {0}" -f $ProfileDir)
Write-Log ("dsh home      : {0}" -f $DshHome)
Write-Log ("host / time   : {0} / {1}" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'))
Write-Log ("log file      : {0}" -f $LogPath)

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Add-Failure 'env' 'node 不在 PATH，无法运行 guardian'
  Write-ResultBlock 'FAIL'
  exit 3
}
Write-Log ("node          : {0} ({1})" -f $nodeCmd.Source, (& node --version))

$requiredPaths = @(
  (Join-Path $ProfileDir 'package.json'),
  (Join-Path $ProfileDir 'pnpm-lock.yaml'),
  (Join-Path $ProfileDir 'cordis.patch.yml'),
  (Join-Path $ProfileDir 'node_modules'),
  (Join-Path $DshHome 'mcp'),
  (Join-Path $DshHome 'storages'),
  $GuardianBin,
  $SnapMeta
)
$missingPaths = @($requiredPaths | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missingPaths.Count -gt 0) {
  foreach ($m in $missingPaths) { Add-Failure 'required-path' $m }
  Write-ResultBlock 'FAIL'
  exit 3
}
Add-Pass 'required-paths' '8 项输入齐全'

# ---------------------------------------------------------------- 1. process gate (C1)
$dsProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' })
if ($dsProcs.Count -gt 0) {
  Write-Log ("检测到 {0} 个 DeepSeek 进程；按规则不 kill，脚本中止。" -f $dsProcs.Count) 'FAIL'
  foreach ($p in $dsProcs) { Write-Log ("  pid={0} name={1} start={2}" -f $p.Id, $p.ProcessName, $p.StartTime) 'FAIL' }
  Write-Log '请完整退出 DSH（含托盘图标），确认 Get-Process 无 DeepSeek 进程后重跑本脚本。' 'FAIL'
  $script:Results['client_processes'] = $dsProcs.Count
  Write-ResultBlock 'ABORT'
  exit 2
}
$script:Results['client_processes'] = 0
Add-Pass 'client-stopped' 'Get-Process 无 DeepSeek 进程'

# ---------------------------------------------------------------- 2. digest at client-stopped
Write-Log 'runtime-inventory 计算闭包 digest（客户端已停止）…'
$invOut = & node $GuardianBin runtime-inventory --json-out $InvJson 2>&1
$invCode = $LASTEXITCODE
Write-Log ("runtime-inventory exit={0}" -f $invCode)
if ($invCode -ne 0 -or -not (Test-Path -LiteralPath $InvJson)) {
  Add-Failure 'inventory' ("exit=$invCode; json=" + (Test-Path -LiteralPath $InvJson))
  Write-ResultBlock 'FAIL'
  exit 3
}
$inv = [IO.File]::ReadAllText($InvJson) | ConvertFrom-Json
$digest = [string]$inv.digest
$snap = [IO.File]::ReadAllText($SnapMeta) | ConvertFrom-Json
$snapDigest = [string]$snap.digest
$digestMatch = ($digest -eq $snapDigest)
Write-Log ("digest-at-client-stopped = {0}" -f $digest)
Write-Log ("snapshot digest          = {0}" -f $snapDigest)
Write-Log ("digest match             = {0}" -f $digestMatch)
if (-not $digestMatch) { Write-Log 'digest 与 snap-a 不一致：按组 1 修正后的判定，记录为已知 drift，不阻塞' 'WARN' }
$script:Results['digest_at_client_stopped'] = $digest
$script:Results['snapshot_digest'] = $snapDigest
$script:Results['digest_match'] = $digestMatch
$script:Results['entries_checked'] = [int]$inv.entryCount

# ---------------------------------------------------------------- 3. C2 manual baseline
Write-Log 'C2 手工全量基线开始…'
if (-not (Test-Path -LiteralPath $BaseDir)) { New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null }
$singleFiles = @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')
foreach ($name in $singleFiles) {
  $src = Join-Path $ProfileDir $name
  $dst = Join-Path $BaseDir $name
  Copy-Item -LiteralPath $src -Destination $dst -Force
  $item = Get-Item -LiteralPath $dst
  $sha = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLower()
  Write-Log ("copied {0}: {1} bytes, sha256 {2}" -f $name, $item.Length, $sha)
  if ($name -eq 'package.json') { $script:Results['package_json_sha256'] = $sha }
  if ($name -eq 'pnpm-lock.yaml') { $script:Results['lockfile_sha256'] = $sha }
}

$treesOk = $true
$treesOk = (Copy-Tree (Join-Path $ProfileDir 'node_modules') (Join-Path $BaseDir 'node_modules') 'node_modules') -and $treesOk
$treesOk = (Copy-Tree (Join-Path $DshHome 'mcp') (Join-Path $BaseDir 'mcp') 'mcp') -and $treesOk
$treesOk = (Copy-Tree (Join-Path $DshHome 'storages') (Join-Path $BaseDir 'storages') 'storages') -and $treesOk
if (-not $treesOk) { Write-Log '目录复制存在失败项，继续统计但不视为完整基线' 'WARN' }

$linkPath = Join-Path $ProfileDir 'node_modules\novel-agents-md'
$linkTarget = $null
if (Test-Path -LiteralPath $linkPath) {
  $linkItem = Get-Item -LiteralPath $linkPath -Force
  if ($linkItem.LinkType) {
    $t = $linkItem.Target
    if ($t -is [array]) { $t = $t[0] }
    $linkTarget = [string]$t
  }
}
Write-Log ("junction: {0} -> {1} (基线内跳过，恢复时需手工重建)" -f $linkPath, $linkTarget)
$script:Results['junction_target'] = $linkTarget

# ---------------------------------------------------------------- 4. C3 integrity summary
$baseItem = Get-ChildItem -LiteralPath $BaseDir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
$nmFiles = @(Get-ChildItem -LiteralPath (Join-Path $BaseDir 'node_modules') -Recurse -File -Force -ErrorAction SilentlyContinue)
$nmCount = $nmFiles.Count
$nmEntry = $inv.entries.PSObject.Properties['profile/node_modules']
$nmExpected = 0
if ($nmEntry) { $nmExpected = [int]$nmEntry.Value.files }
$nmDelta = $nmCount - $nmExpected
Write-Log ("baseline total : {0} files, {1} bytes" -f $baseItem.Count, [int64]$baseItem.Sum)
Write-Log ("node_modules   : baseline={0} files, inventory={1} files, delta={2} (允许 ±50)" -f $nmCount, $nmExpected, $nmDelta)
$script:Results['baseline_dir'] = $BaseDir
$script:Results['baseline_files'] = [int]$baseItem.Count
$script:Results['baseline_bytes'] = [int64]$baseItem.Sum
$script:Results['node_modules_files'] = $nmCount
$script:Results['node_modules_inventory_files'] = $nmExpected
$script:Results['node_modules_delta'] = $nmDelta

if ([Math]::Abs($nmDelta) -le 50) { Add-Pass 'c3-node-modules-count' ("delta=$nmDelta") }
else { Add-Failure 'c3-node-modules-count' ("baseline=$nmCount expected=$nmExpected delta=$nmDelta (>±50)") }

$sixItems = @(
  (Join-Path $BaseDir 'package.json'),
  (Join-Path $BaseDir 'pnpm-lock.yaml'),
  (Join-Path $BaseDir 'cordis.patch.yml'),
  (Join-Path $BaseDir 'node_modules'),
  (Join-Path $BaseDir 'mcp'),
  (Join-Path $BaseDir 'storages')
)
$missingItems = @($sixItems | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missingItems.Count -eq 0) { Add-Pass 'c3-six-items' '六项齐全' }
else { foreach ($m in $missingItems) { Add-Failure 'c3-six-items' $m } }

$manifestPath = Join-Path $BaseDir 'baseline-manifest.json'
$manifest = [ordered]@{
  createdAt = (Get-Date -Format 'o')
  guardianRoot = $GuardianRoot
  profileDir = $ProfileDir
  dshHome = $DshHome
  digestAtClientStopped = $digest
  snapshotDigest = $snapDigest
  digestMatch = $digestMatch
  packageJsonSha256 = $script:Results['package_json_sha256']
  lockfileSha256 = $script:Results['lockfile_sha256']
  nodeModulesFileCount = $nmCount
  nodeModulesInventoryFileCount = $nmExpected
  totalFiles = [int]$baseItem.Count
  totalBytes = [int64]$baseItem.Sum
  junction = [ordered]@{
    path = $linkPath
    target = $linkTarget
    copiedAs = 'junction-skipped (robocopy /XJ)'
    restoreHint = ('New-Item -ItemType Junction -Path "{0}" -Target "{1}"' -f $linkPath, $linkTarget)
  }
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Log ("manifest: {0}" -f $manifestPath)

# ---------------------------------------------------------------- 5. D1 SAFE-MODE.md
$safeExpected = @'
# 当前真机使用限制（P0 未修完前）
- 禁止：restore / repair / plugin-add / plugin-link / plugin-insert / plugin-remove
- 允许：doctor / preflight / runtime-inventory / drift / status / list / ps
- 原因：P0-1/P0-2/P0-3/P0-4/P0-5/P0-6
- 恢复方式：手工从 manual-baseline-<ts> 拷回
- 解锁条件：组1→组4 全部修完且实机验收通过

## 已知 drift（组1验收时记录）
- workspace.json 在 2026-10-18 15:02 被运行中的客户端写入，digest 从 24e4232 变为 308cc71。
- 属 P2 volatile 前缀覆盖不足；组2（先停再快照）完成后，digest 基线应在客户端停止状态下重建。
- 本次不还原该文件，避免丢失工作区增量。
'@
$safeExpectedNormalized = Normalize-Text $safeExpected
$safeCurrent = ''
if (Test-Path -LiteralPath $SafeModePath) { $safeCurrent = [IO.File]::ReadAllText($SafeModePath) }
$safeCurrentNormalized = Normalize-Text $safeCurrent
if ($safeCurrentNormalized -ne $safeExpectedNormalized) {
  $payload = (($safeExpectedNormalized -replace "`n", "`r`n") + "`r`n")
  [IO.File]::WriteAllText($SafeModePath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  Write-Log 'SAFE-MODE.md 已按原文+备注写入'
  $safeCurrent = [IO.File]::ReadAllText($SafeModePath)
} else {
  Write-Log 'SAFE-MODE.md 已存在且与原文+备注一致，未改写'
}
$safeCheck = Normalize-Text ([IO.File]::ReadAllText($SafeModePath))
if ($safeCheck -eq $safeExpectedNormalized) {
  Add-Pass 'd1-safe-mode' '内容逐字一致'
} else {
  Add-Failure 'd1-safe-mode' '内容与 D1 原文+备注不一致'
}
$safeSha = (Get-FileHash -LiteralPath $SafeModePath -Algorithm SHA256).Hash.ToLower()
Write-Log ("SAFE-MODE.md sha256: {0}" -f $safeSha)
$script:Results['safe_mode_md'] = $SafeModePath
$script:Results['safe_mode_sha256'] = $safeSha

# ---------------------------------------------------------------- 6. E items 1–3 assertions
$pkgPath = Join-Path $ProfileDir 'package.json'
$lockPath = Join-Path $ProfileDir 'pnpm-lock.yaml'
try {
  $null = [IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json
  Add-Pass 'e1-json-valid' 'package.json 合法 JSON'
} catch {
  Add-Failure 'e1-json-valid' $_.Exception.Message
}
$probeHits = @(Select-String -LiteralPath $pkgPath -Pattern 'guardian-probe' -SimpleMatch)
if ($probeHits.Count -eq 0) { Add-Pass 'e1-no-probe' 'guardian-probe 命中 0' }
else { Add-Failure 'e1-no-probe' ("命中 {0} 行" -f $probeHits.Count) }
$markerHits = @(Select-String -LiteralPath $lockPath -Pattern 'guardian acceptance probe' -SimpleMatch)
if ($markerHits.Count -eq 0) { Add-Pass 'e2-no-marker' 'acceptance marker 命中 0' }
else { Add-Failure 'e2-no-marker' ("命中 {0} 行" -f $markerHits.Count) }
$script:Results['probe_hits'] = $probeHits.Count
$script:Results['lock_marker_hits'] = $markerHits.Count

$snapPkgSha = [string]$snap.entries.'profile/package.json'.sha256
$snapLockSha = [string]$snap.entries.'profile/pnpm-lock.yaml'.sha256
$pkgSha = (Get-FileHash -LiteralPath $pkgPath -Algorithm SHA256).Hash.ToLower()
$lockSha = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLower()
Write-Log ("package.json sha256 : {0} (snapshot {1})" -f $pkgSha, $snapPkgSha)
Write-Log ("pnpm-lock sha256    : {0} (snapshot {1})" -f $lockSha, $snapLockSha)
if ($pkgSha -eq $snapPkgSha -and $lockSha -eq $snapLockSha) {
  Add-Pass 'e3-sha-equals-snapshot' 'package.json 与 pnpm-lock.yaml 均等于 snap-a blob'
} else {
  Add-Failure 'e3-sha-equals-snapshot' ("pkgMatch={0} lockMatch={1}" -f ($pkgSha -eq $snapPkgSha), ($lockSha -eq $snapLockSha))
}
$script:Results['snapshot_package_json_sha256'] = $snapPkgSha
$script:Results['snapshot_lockfile_sha256'] = $snapLockSha

# ---------------------------------------------------------------- 7. summary
$elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Log ("elapsed: {0}s" -f $elapsed)
$script:Results['log_path'] = $LogPath
$script:Results['inventory_json'] = $InvJson
if ($script:Failures.Count -eq 0) {
  Write-Log '组 1 步骤 3–5 全部 PASS' 'INFO'
  Write-ResultBlock 'PASS'
  exit 0
}
Write-Log '组 1 步骤 3–5 存在 FAIL，见上方 failure 行' 'FAIL'
Write-ResultBlock 'FAIL'
exit 3

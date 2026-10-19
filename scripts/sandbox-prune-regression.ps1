<#
.SYNOPSIS
  沙箱内 prune → restore 完整性回归（绝不触碰生产 DSH 环境）。

.DESCRIPTION
  验证「prune 的 blob GC 不会删掉仍被保留快照引用的内容」：
    1) node ui\sandbox-init.mjs --reset        → 干净沙箱（notepad 假客户端）
    2) runtime-inventory                      → 记录 digest A
    3) snapshot regress-a / regress-b         → 两个独立快照
    4) 篡改 profile\cordis.yml                → digest 必须变化
    5) prune --vacuum --keep regress-a --keep regress-b
    6) restore regress-a --no-stop --no-restart --assert-offline
    7) 断言：digest 回到 A、篡改内容消失、无 blob 缺失
    8) 再 restore regress-b → digest 仍为 B，证明两个快照的 blob 都活着

  全程只操作 <GuardianRoot>\sandbox，config.launch 为 notepad.exe，
  不读取也不修改 C:\Users\28256\.dsh 下的任何生产文件。

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\sandbox-prune-regression.ps1
#>
[CmdletBinding()]
param(
  [string]$GuardianRoot = 'D:\dsh_plugin\dsh_guardian',
  [string]$SandboxName = 'sandbox'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Sandbox = Join-Path $GuardianRoot $SandboxName
$Node = 'node'
$Results = [ordered]@{}
$Failures = New-Object System.Collections.Generic.List[string]

function Step {
  param([string]$Name, [scriptblock]$Body)
  try {
    $value = & $Body
    $Results[$Name] = 'PASS'
    Write-Host ("[PASS] {0} {1}" -f $Name, ($value | Out-String).Trim())
    return $value
  } catch {
    $Results[$Name] = 'FAIL'
    $Failures.Add(("{0}: {1}" -f $Name, $_.Exception.Message)) | Out-Null
    Write-Host ("[FAIL] {0}: {1}" -f $Name, $_.Exception.Message)
    return $null
  }
}

function Invoke-G {
  param([string[]]$GArgs)
  $bin = Join-Path $Sandbox 'bin\guardian.mjs'
  $out = & $Node $bin --root $Sandbox @GArgs 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw ("guardian {0} 退出码 {1}`n{2}" -f ($GArgs -join ' '), $code, ($out -join "`n")) }
  return ($out -join "`n")
}

function Get-Digest {
  # 必须用带哈希的 digest：meta.digest 是 hash=true 的实算值，--no-hash 会产生不同 digest
  $json = Invoke-G @('runtime-inventory')
  return ($json | ConvertFrom-Json).digest
}

# ---------------------------------------------------------------- 0) 干净沙箱
Write-Host '== 初始化沙箱（notepad 假客户端，--reset）'
& $Node (Join-Path $GuardianRoot 'ui\sandbox-init.mjs') --reset | ForEach-Object { Write-Host "   $_" }
if (-not (Test-Path -LiteralPath (Join-Path $Sandbox 'config.json'))) { Write-Error '沙箱 config.json 缺失'; exit 2 }

$launch = (Get-Content -LiteralPath (Join-Path $Sandbox 'config.json') -Raw | ConvertFrom-Json).launch[0]
if ($launch -notmatch 'notepad\.exe$') { Write-Error "沙箱 launch 不是 notepad，拒绝执行: $launch"; exit 2 }

# ---------------------------------------------------------------- 1) 基线 digest
$digestA = Step 'baseline-digest' { Get-Digest }
Write-Host "   digest A = $digestA"

# ---------------------------------------------------------------- 2) 快照：保留 A/B + 待回收的 trash
$snapA = Step 'snapshot-regress-a' { Invoke-G @('snapshot', 'regress-a') | ConvertFrom-Json }
if ($snapA -and $digestA -and $snapA.digest -ne $digestA) {
  $Failures.Add("snapshot-a-digest-drift: $($snapA.digest) != $digestA") | Out-Null
}

# trash 快照里放一个全库唯一的文件 → 它被 prune 删除后，该 blob 必然成为孤儿被 GC
$trashFile = Join-Path $Sandbox ('profile\trash-' + [guid]::NewGuid().ToString('N') + '.txt')
Step 'snapshot-regress-trash' {
  Set-Content -LiteralPath $trashFile -Value ([guid]::NewGuid().ToString('N')) -Encoding utf8
  Invoke-G @('snapshot', 'regress-trash') | ConvertFrom-Json
} | Out-Null
Step 'remove-trash-file' { Remove-Item -LiteralPath $trashFile -Force; 'removed' } | Out-Null

$snapB = Step 'snapshot-regress-b' { Invoke-G @('snapshot', 'regress-b') | ConvertFrom-Json }

# ---------------------------------------------------------------- 3) 篡改
$patchFile = Join-Path $Sandbox 'profile\cordis.yml'
Step 'mutate-profile' {
  Add-Content -LiteralPath $patchFile -Value '# PRUNE-GC-REGRESSION-MUTATION' -Encoding utf8
  'mutated cordis.yml'
} | Out-Null
$digestMutated = Step 'mutated-digest' { Get-Digest }
if ($digestMutated -eq $digestA) { $Failures.Add('mutated-digest-equal: 篡改后 digest 未变化') | Out-Null }
Write-Host "   digest M = $digestMutated"

# ---------------------------------------------------------------- 4) prune
$prune = Step 'prune-vacuum' {
  (Invoke-G @('prune', '--vacuum', '--keep', 'regress-a', '--keep', 'regress-b')) | ConvertFrom-Json
}
if ($prune) {
  Write-Host ("   deleted={0} blobsDeleted={1} emptyShardsRemoved={2} freedMb={3}" -f `
    $prune.deleted.Count, $prune.store.blobsDeleted, $prune.vacuum.emptyShardsRemoved, $prune.freed.totalMb)
  if ($prune.errors.Count -gt 0) { $Failures.Add(('prune-errors: ' + ($prune.errors -join '; '))) | Out-Null }
  $keptNames = @($prune.kept | ForEach-Object { $_.dir })
  if ($keptNames -notcontains 'regress-a') { $Failures.Add('prune-dropped-regress-a: 被保留名单丢弃') | Out-Null }
  if ($keptNames -notcontains 'regress-b') { $Failures.Add('prune-dropped-regress-b: 被保留名单丢弃') | Out-Null }
  # 关键断言：trash 必须被删，且其独占 blob 必须被 GC（否则本回归没有真正走到回收路径）
  $deletedNames = @($prune.deleted | ForEach-Object { $_.dir })
  if ($deletedNames -notcontains 'regress-trash') { $Failures.Add('prune-kept-trash: regress-trash 未被清理，GC 路径未覆盖') | Out-Null }
  if ($prune.store.blobsDeleted -lt 1) { $Failures.Add('gc-noop: blobsDeleted=0，孤儿 blob 未被回收') | Out-Null }
}

# ---------------------------------------------------------------- 5) restore A
Step 'restore-regress-a' {
  (Invoke-G @('restore', 'regress-a', '--no-stop', '--no-restart', '--assert-offline')) | ConvertFrom-Json | Out-Null
  'restored'
} | Out-Null
$digestAfterA = Step 'digest-after-restore-a' { Get-Digest }
if ($digestAfterA -ne $digestA) { $Failures.Add("digest-mismatch-a: $digestAfterA != $digestA") | Out-Null }
Step 'mutation-gone' {
  $text = Get-Content -LiteralPath $patchFile -Raw
  if ($text -match 'PRUNE-GC-REGRESSION-MUTATION') { throw '篡改内容仍在，restore 未还原' }
  'ok'
} | Out-Null

# ---------------------------------------------------------------- 6) restore B
Step 'restore-regress-b' {
  (Invoke-G @('restore', 'regress-b', '--no-stop', '--no-restart', '--assert-offline')) | ConvertFrom-Json | Out-Null
  'restored'
} | Out-Null
$digestAfterB = Step 'digest-after-restore-b' { Get-Digest }
$digestB = $snapB.digest
if ($digestAfterB -ne $digestB) { $Failures.Add("digest-mismatch-b: $digestAfterB != $digestB") | Out-Null }

# ---------------------------------------------------------------- 7) 收尾
Write-Host ''
Write-Host '== RESULT'
foreach ($key in $Results.Keys) { Write-Host ("   {0,-24} {1}" -f $key, $Results[$key]) }
if ($Failures.Count -eq 0) {
  Write-Host 'RESULT: PASS  (prune 后快照仍可完整 restore，无 blob 误删)'
  exit 0
}
Write-Host 'RESULT: FAIL'
foreach ($f in $Failures) { Write-Host "   - $f" }
exit 3

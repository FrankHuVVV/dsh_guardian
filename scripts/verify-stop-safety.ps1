# verify-stop-safety.ps1 — 只读验证 stopClientAndVerify 的安全边界
# 不执行 snapshot / guard / restore，不会杀任何真实进程。
# 场景：state.rootPid 为空（或指向已死 PID）+ config.launch = notepad.exe（未运行）
# 期望：返回 stopped=true / released=true / pids=[]，且 DSH 客户端 PID 不变。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$guardian = Join-Path $root 'bin\guardian.mjs'
if (-not (Test-Path $guardian)) { throw "未找到 $guardian" }

$notepad = @(Get-Process notepad -ErrorAction SilentlyContinue)
if ($notepad.Count -gt 0) {
  throw '检测到 notepad 正在运行：为避免误伤请先关闭 notepad 再运行本验证。'
}

$test = Join-Path $root 'sandbox\stop-selftest'
if (Test-Path $test) { Remove-Item $test -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$test\bin" | Out-Null
Copy-Item $guardian "$test\bin\guardian.mjs"

$runner = @'
const __cfg = JSON.parse(fs.readFileSync(process.env.GUARDIAN_TEST_CONFIG, 'utf8'));
const __s1 = JSON.parse(fs.readFileSync(process.env.GUARDIAN_TEST_STATE1, 'utf8'));
const __s2 = JSON.parse(fs.readFileSync(process.env.GUARDIAN_TEST_STATE2, 'utf8'));
const __launchIds = launchProcessIds(__cfg);
const __r1 = stopClientAndVerify(__cfg, { state: __s1, graceMs: 0 });
const __r2 = stopClientAndVerify(__cfg, { state: __s2, graceMs: 0 });
const __ok = __launchIds.length === 0
  && __r1.stopped && __r1.released && __r1.pids.length === 0 && __r1.reason === 'no-tracked-instance'
  && __r2.stopped && __r2.released && __r2.pids.length === 0 && __r2.reason === 'no-tracked-instance';
console.log(JSON.stringify({ launchIds: __launchIds, r1: __r1, r2: __r2, ok: __ok }, null, 2));
process.exitCode = __ok ? 0 : 1;
'@

$src = [IO.File]::ReadAllText("$test\bin\guardian.mjs", [Text.UTF8Encoding]::new($false))
$src = $src -replace "(?s)try \{ process\.exitCode = main\(\); \}\r?\ncatch \(error\) \{ console\.error\(error\.stack \|\| error\.message\); process\.exitCode = 2; \}\s*$", $runner
[IO.File]::WriteAllText("$test\bin\guardian.mjs", $src, [Text.UTF8Encoding]::new($false))

[IO.File]::WriteAllText("$test\config.json", '{"launch":["C:\\Windows\\System32\\notepad.exe"],"port":0,"killGraceMs":0}', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$test\state-null.json", '{"version":5,"instance":{"rootPid":null,"port":null,"httpStatus":null,"healthy":false},"activeOperation":null,"safe":false,"disabled":[]}', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$test\state-deadpid.json", '{"version":5,"instance":{"rootPid":999999,"port":4999,"httpStatus":401,"healthy":true},"activeOperation":null,"safe":false,"disabled":[]}', [Text.UTF8Encoding]::new($false))

$before = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Select-Object -ExpandProperty ProcessId | Sort-Object)
$env:GUARDIAN_TEST_CONFIG = "$test\config.json"
$env:GUARDIAN_TEST_STATE1 = "$test\state-null.json"
$env:GUARDIAN_TEST_STATE2 = "$test\state-deadpid.json"

Write-Host '=== 运行 stopClientAndVerify 安全验证 ==='
node "$test\bin\guardian.mjs"
$code = $LASTEXITCODE

$after = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Select-Object -ExpandProperty ProcessId | Sort-Object)
$same = (($before -join ',') -eq ($after -join ','))
Write-Host "DSH 客户端 PID（前）: $($before -join ',')"
Write-Host "DSH 客户端 PID（后）: $($after -join ',')"
Write-Host "DSH 进程未变化: $same"

if ($code -ne 0) { throw '安全验证失败：返回结构与预期不符' }
if (-not $same) { throw '安全验证失败：DSH 客户端进程发生变化' }
Write-Host 'STOP_SAFETY_OK'
exit 0

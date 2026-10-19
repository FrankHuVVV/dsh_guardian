#!/usr/bin/env node
/**
 * sandbox-init.mjs — 初始化 / 刷新 UI 沙箱演练场（零第三方依赖）
 *
 * 目录：<项目根>/sandbox
 * 任何 UI 命令都会在这个目录下执行，config.launch 指向 notepad.exe，
 * 不会触碰真实的 DSH 客户端与 ~/.dsh 环境。
 *
 * 每次启动都会把沙箱重置到「干净基线」，避免上一轮演练的快照/事务残留
 * 污染本轮验收：
 *   1) 清空 sandbox/backups 与 sandbox/transactions，重置 state.json
 *   2) 重新同步 bin/guardian.mjs 到 sandbox/bin/
 *   3) 用 write-if-missing 重建 profile/home 夹具
 *   4) 清理历史遗留的 fixtures/sandbox/root 重产物（曾达 172MB），
 *      只保留可重建的最小骨架，`--root fixtures\sandbox\root` 仍然可用
 *
 * 用法：
 *   node ui/sandbox-init.mjs                # 干净重置（默认，UI 启动路径使用）
 *   node ui/sandbox-init.mjs --keep-state   # 保留 sandbox 现有快照与状态
 *   node ui/sandbox-init.mjs --reset        # 删除整个 sandbox/ 后从零重建
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARGS = process.argv.slice(2);
const KEEP_STATE = ARGS.includes('--keep-state');
const FULL_RESET = ARGS.includes('--reset');

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(UI_DIR, '..');
const SANDBOX = path.join(ROOT, 'sandbox');
const FIXTURE_ROOT = path.join(ROOT, 'fixtures', 'sandbox', 'root');
const GUARDIAN_SRC = path.join(ROOT, 'bin', 'guardian.mjs');
const GUARDIAN_DST = path.join(SANDBOX, 'bin', 'guardian.mjs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function rmrf(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function dirBytes(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let dirents = [];
    try { dirents = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) { stack.push(full); continue; }
      try { bytes += fs.statSync(full).size; } catch { /* ignore */ }
    }
  }
  return bytes;
}

if (FULL_RESET) {
  const freedBytes = fs.existsSync(SANDBOX) ? dirBytes(SANDBOX) : 0;
  rmrf(SANDBOX);
  console.log(`[sandbox-init] --reset: 已删除旧沙箱（${(freedBytes / 1048576).toFixed(2)} MB）`);
}

ensureDir(path.join(SANDBOX, 'bin'));
ensureDir(path.join(SANDBOX, 'home', 'storages', 'session_projcache', 'sessions'));
ensureDir(path.join(SANDBOX, 'home', 'storages', 'stable'));
ensureDir(path.join(SANDBOX, 'profile', 'node_modules'));
ensureDir(path.join(SANDBOX, 'profile', '.plugin-manager'));
ensureDir(path.join(SANDBOX, 'profile', '.dsh-market'));
ensureDir(path.join(SANDBOX, 'backups'));
ensureDir(path.join(SANDBOX, 'logs'));
ensureDir(path.join(SANDBOX, 'transactions'));

// ---------------------------------------------------------------- 干净基线
if (!KEEP_STATE) {
  const cleaned = [];
  for (const sub of ['backups', 'transactions']) {
    const target = path.join(SANDBOX, sub);
    const bytes = fs.existsSync(target) ? dirBytes(target) : 0;
    if (rmrf(target)) cleaned.push(`${sub}(${(bytes / 1048576).toFixed(2)}MB)`);
  }
  if (rmrf(path.join(SANDBOX, 'state.json'))) cleaned.push('state.json');
  if (rmrf(path.join(SANDBOX, 'logs', 'intent.json'))) cleaned.push('logs/intent.json');
  ensureDir(path.join(SANDBOX, 'backups'));
  ensureDir(path.join(SANDBOX, 'transactions'));
  console.log(cleaned.length
    ? `[sandbox-init] 已重置为干净沙箱基线: ${cleaned.join(', ')}`
    : '[sandbox-init] 沙箱已是干净基线');
}

// 每次启动都同步最新 guardian（保证安全修复生效）
fs.copyFileSync(GUARDIAN_SRC, GUARDIAN_DST);

const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');

const configPath = path.join(SANDBOX, 'config.json');
const configExists = fs.existsSync(configPath);
const config = configExists
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) };

// 沙箱固定字段：notepad 作为假客户端；跳过 asar 校验；版本匹配 notepad.exe 的真实版本
config.dshHome = path.join(SANDBOX, 'home');
config.profile = 'sandbox';
config.profileDir = path.join(SANDBOX, 'profile');
config.launch = [notepad];
config.expectedClientVersion = '10.0.26100.8875 (WinBuild.160101.0800)';
config.skipClientAsarCheck = true;
config.blockOnClientMismatch = false;
config.portMode = 'dynamic';
config.port = 0;
config.startTimeoutMs = 15000;
config.settleMs = 1000;
config.probeStartTimeoutMs = 15000;
config.probeSettleMs = 1000;
config.trackedSourcePaths = [];
config.dshHomeTrackedPaths = ['storages'];
config.dshHomeExclude = [];
config.storageVolatilePaths = ['session_projcache/sessions', 'workspace.json'];
config.sharedDependencyRoots = [];
config.snapshotMode = 'exact';
config.storeDir = 'backups\\_store';
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`[sandbox-init] ${configExists ? '已更新' : '已生成'} ${configPath}`);

const statePath = path.join(SANDBOX, 'state.json');
writeIfMissing(statePath, `${JSON.stringify({
  version: 5,
  activeOperation: null,
  safe: false,
  culprit: null,
  instance: { rootPid: null, descendantPids: [], port: null, httpStatus: null, healthy: false },
  drift: { detected: false, digest: null, lastCommittedDigest: null, addedPaths: [], changedPaths: [], removedPaths: [] },
  probing: false,
  disabled: []
}, null, 2)}\n`);

writeIfMissing(path.join(SANDBOX, 'home', 'storages', 'workspace.json'), '{"workspace":"sandbox-v1"}\n');
writeIfMissing(path.join(SANDBOX, 'home', 'storages', 'stable', 'keep.txt'), 'sandbox-stable-v1\n');
writeIfMissing(path.join(SANDBOX, 'home', 'storages', 'session_projcache', 'sessions', 'session-1.json'), '{"session":"sandbox-1"}\n');
writeIfMissing(path.join(SANDBOX, 'profile', 'package.json'), '{"name":"guardian-sandbox-profile","version":"1.0.0","dependencies":{}}\n');
writeIfMissing(path.join(SANDBOX, 'profile', 'cordis.patch.yml'), '');
writeIfMissing(path.join(SANDBOX, 'profile', 'cordis.yml'), '');
writeIfMissing(path.join(SANDBOX, 'profile', 'pnpm-workspace.yaml'), '');
writeIfMissing(path.join(SANDBOX, 'profile', 'pnpm-lock.yaml'), '');

// ---------------------------------------------------------------- 遗留 fixtures 瘦身
// fixtures/sandbox/root 曾是宿主级验收根，其 backups/_store 累计到 172MB 纯测试产物。
// 这里只清掉体积来源，骨架（config/state/空 backups）保持可重建，README 的 --root 用法仍然成立。
const fixtureStore = path.join(FIXTURE_ROOT, 'backups', '_store');
if (fs.existsSync(fixtureStore)) {
  const bytes = dirBytes(fixtureStore);
  rmrf(fixtureStore);
  console.log(`[sandbox-init] 已清理遗留 fixtures 测试产物 ${(bytes / 1048576).toFixed(2)} MB`);
}
ensureDir(path.join(FIXTURE_ROOT, 'backups'));
ensureDir(path.join(FIXTURE_ROOT, 'logs'));
ensureDir(path.join(FIXTURE_ROOT, 'transactions'));
const fixtureConfigPath = path.join(FIXTURE_ROOT, 'config.json');
const fixtureConfigWritten = writeIfMissing(fixtureConfigPath, `${JSON.stringify({
  ...config,
  dshHome: path.join(FIXTURE_ROOT, 'home'),
  profile: 'fixture',
  profileDir: path.join(FIXTURE_ROOT, 'profile'),
  launch: [notepad],
  expectedClientVersion: config.expectedClientVersion,
  skipClientAsarCheck: true,
  blockOnClientMismatch: false,
  trackedSourcePaths: [],
  sharedDependencyRoots: [],
  storeDir: 'backups\\_store'
}, null, 2)}\n`);
writeIfMissing(path.join(FIXTURE_ROOT, 'state.json'), `${JSON.stringify({
  version: 5,
  activeOperation: null,
  safe: false,
  culprit: null,
  instance: { rootPid: null, descendantPids: [], port: null, httpStatus: null, healthy: false },
  drift: { detected: false, digest: null, lastCommittedDigest: null, addedPaths: [], changedPaths: [], removedPaths: [] },
  probing: false,
  disabled: []
}, null, 2)}\n`);
if (fixtureConfigWritten) console.log(`[sandbox-init] 已重建最小 fixture 根 ${fixtureConfigPath}`);

console.log('[sandbox-init] 沙箱就绪');
console.log(`  root      : ${SANDBOX}`);
console.log(`  guardian  : ${GUARDIAN_DST}`);
console.log(`  launch    : ${notepad}`);
console.log(`  dshHome   : ${path.join(SANDBOX, 'home')}`);
console.log(`  fixture   : ${FIXTURE_ROOT}  (最小骨架，可直接 --root 使用)`);
console.log('  UI        : http://127.0.0.1:3082/  (node ui/server.mjs --sandbox)');

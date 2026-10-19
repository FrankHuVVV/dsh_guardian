#!/usr/bin/env node
/**
 * sandbox-init.mjs — 初始化 / 刷新 UI 沙箱演练场 + 重建 fixtures 夹具（零第三方依赖）
 *
 * 目录：<项目根>/sandbox（UI 沙箱）与 <项目根>/fixtures/sandbox/root（--root 验收根）
 * UI 沙箱的 config.launch 指向 notepad.exe，不会触碰真实 DSH 客户端与 ~/.dsh。
 *
 * 每次启动把沙箱重置到「干净基线」：
 *   1) 清空 sandbox/backups 与 sandbox/transactions，重置 state.json
 *   2) 重新同步 bin/guardian.mjs 到 sandbox/bin/
 *   3) 用 write-if-missing 重建 profile/home 夹具
 *   4) 清理历史遗留的 fixtures/sandbox/root 重产物，并重建最小 fixture 根
 *
 * fixtures/sandbox/home 不再入库（曾达 69MB：64MB 是 live profile 的陈旧副本）。
 * 默认只生成最小骨架（storages 等），需要"像生产"的夹具时用：
 *   node ui/sandbox-init.mjs --fixture-home=copy   # 从 live ~/.dsh 复制 mcp/storages/plugins/.agent-presets
 *
 * 用法：
 *   node ui/sandbox-init.mjs                # 干净重置 UI 沙箱 + 最小夹具（UI 启动路径）
 *   node ui/sandbox-init.mjs --keep-state   # 保留 sandbox 现有快照与状态
 *   node ui/sandbox-init.mjs --reset        # 删除整个 sandbox/ 后从零重建
 *   node ui/sandbox-init.mjs --fixture-only # 只重建 fixtures 夹具，不碰 sandbox/
 *   node ui/sandbox-init.mjs --fixture-home=copy  # 用 live ~/.dsh 重建较完整的夹具 home
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARGS = process.argv.slice(2);
const KEEP_STATE = ARGS.includes('--keep-state');
const FULL_RESET = ARGS.includes('--reset');
const FIXTURE_ONLY = ARGS.includes('--fixture-only');
const FIXTURE_HOME_COPY = ARGS.includes('--fixture-home=copy');

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(UI_DIR, '..');
const SANDBOX = path.join(ROOT, 'sandbox');
const FIXTURE_ROOT = path.join(ROOT, 'fixtures', 'sandbox', 'root');
const FIXTURE_HOME = path.join(FIXTURE_ROOT, 'home');
const GUARDIAN_SRC = path.join(ROOT, 'bin', 'guardian.mjs');
const GUARDIAN_DST = path.join(SANDBOX, 'bin', 'guardian.mjs');

// 本机配置：config.json 是入库模板（占位符），config.local.json 是本机覆盖（不入库）
function readRootConfig() {
  let merged = null;
  try { merged = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { }
  try {
    const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8'));
    merged = { ...(merged || {}), ...local };
  } catch { }
  if (!merged) throw new Error('未找到可用的 config.json / config.local.json');
  return merged;
}

const LIVE_HOME = (() => {
  try { return readRootConfig().dshHome; }
  catch { return null; }
})();

const STATE_TEMPLATE = {
  version: 5,
  activeOperation: null,
  safe: false,
  culprit: null,
  instance: { rootPid: null, descendantPids: [], port: null, httpStatus: null, healthy: false },
  drift: { detected: false, digest: null, lastCommittedDigest: null, addedPaths: [], changedPaths: [], removedPaths: [] },
  probing: false,
  disabled: []
};

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

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) return 0;
  fs.cpSync(source, target, { recursive: true, force: true, dereference: false });
  return dirBytes(target);
}

const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');

// ---------------------------------------------------------------- fixtures 夹具（最小可重建）

function scaffoldFixtureHome({ copyFromLive = false } = {}) {
  ensureDir(path.join(FIXTURE_HOME, 'storages'));
  ensureDir(path.join(FIXTURE_HOME, 'mcp'));
  ensureDir(path.join(FIXTURE_HOME, 'plugins'));
  ensureDir(path.join(FIXTURE_HOME, '.agent-presets'));
  writeIfMissing(path.join(FIXTURE_HOME, 'storages', 'workspace.json'), '{"workspace":"fixture-v1"}\n');
  writeIfMissing(path.join(FIXTURE_HOME, 'settings.yaml.imported'), '');
  writeIfMissing(path.join(FIXTURE_HOME, 'README.txt'),
    'fixtures home — 最小骨架，由 ui/sandbox-init.mjs 自动重建。\n'
    + '需要接近生产的夹具时运行：node ui/sandbox-init.mjs --fixture-home=copy\n');

  let copied = 0;
  if (copyFromLive && LIVE_HOME && fs.existsSync(LIVE_HOME)) {
    for (const sub of ['mcp', 'storages', 'plugins', '.agent-presets']) {
      copied += copyIfExists(path.join(LIVE_HOME, sub), path.join(FIXTURE_HOME, sub));
    }
    fs.writeFileSync(path.join(FIXTURE_HOME, 'README.txt'),
      `fixtures home — 由 --fixture-home=copy 从 ${LIVE_HOME} 复制（已复制 ${(copied / 1048576).toFixed(2)} MB）。\n`
      + '不入库；可用同一条命令随时重建。\n', 'utf8');
  }
  return copied;
}

function initFixtureRoot(config) {
  // 历史遗留：fixtures/sandbox/root/backups/_store 曾累计 172MB 纯测试产物
  const fixtureStore = path.join(FIXTURE_ROOT, 'backups', '_store');
  if (fs.existsSync(fixtureStore)) {
    const bytes = dirBytes(fixtureStore);
    rmrf(fixtureStore);
    console.log(`[sandbox-init] 已清理遗留 fixtures 测试产物 ${(bytes / 1048576).toFixed(2)} MB`);
  }
  ensureDir(path.join(FIXTURE_ROOT, 'backups'));
  ensureDir(path.join(FIXTURE_ROOT, 'logs'));
  ensureDir(path.join(FIXTURE_ROOT, 'transactions'));
  // 最小 profile：让 --root fixtures\sandbox\root 的 runtime-inventory / preflight 不再报 missing
  ensureDir(path.join(FIXTURE_ROOT, 'profile', 'node_modules'));
  ensureDir(path.join(FIXTURE_ROOT, 'profile', '.plugin-manager'));
  ensureDir(path.join(FIXTURE_ROOT, 'profile', '.dsh-market'));
  writeIfMissing(path.join(FIXTURE_ROOT, 'profile', 'package.json'), '{"name":"guardian-fixture-profile","version":"1.0.0","dependencies":{}}\n');
  writeIfMissing(path.join(FIXTURE_ROOT, 'profile', 'cordis.patch.yml'), '');
  writeIfMissing(path.join(FIXTURE_ROOT, 'profile', 'cordis.yml'), '');
  writeIfMissing(path.join(FIXTURE_ROOT, 'profile', 'pnpm-workspace.yaml'), '');
  writeIfMissing(path.join(FIXTURE_ROOT, 'profile', 'pnpm-lock.yaml'), '');
  const copiedBytes = scaffoldFixtureHome({ copyFromLive: FIXTURE_HOME_COPY });

  const fixtureConfigPath = path.join(FIXTURE_ROOT, 'config.json');
  const hadConfig = fs.existsSync(fixtureConfigPath);
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  fs.writeFileSync(fixtureConfigPath, `${JSON.stringify({
    ...config,
    dshHome: FIXTURE_HOME,
    profile: 'fixture',
    profileDir: path.join(FIXTURE_ROOT, 'profile'),
    launch: [notepad],
    skipClientAsarCheck: true,
    blockOnClientMismatch: false,
    trackedSourcePaths: [],
    sharedDependencyRoots: [],
    dshHomeTrackedPaths: ['storages', 'mcp'],
    dshHomeExclude: [],
    storeDir: 'backups\\_store'
  }, null, 2)}\n`, 'utf8');
  writeIfMissing(path.join(FIXTURE_ROOT, 'state.json'), `${JSON.stringify(STATE_TEMPLATE, null, 2)}\n`);
  console.log(`[sandbox-init] fixtures 就绪${hadConfig ? '（config 已刷新）' : '（config 已生成）'}`
    + ` home=${(dirBytes(FIXTURE_HOME) / 1048576).toFixed(2)} MB`
    + (copiedBytes ? `（从 live 复制 ${(copiedBytes / 1048576).toFixed(2)} MB）` : '（最小骨架）'));
}

// ---------------------------------------------------------------- UI 沙箱

function initSandbox() {
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

  const configPath = path.join(SANDBOX, 'config.json');
  const configExists = fs.existsSync(configPath);
  const config = configExists
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { ...readRootConfig() };

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

  writeIfMissing(path.join(SANDBOX, 'state.json'), `${JSON.stringify(STATE_TEMPLATE, null, 2)}\n`);
  writeIfMissing(path.join(SANDBOX, 'home', 'storages', 'workspace.json'), '{"workspace":"sandbox-v1"}\n');
  writeIfMissing(path.join(SANDBOX, 'home', 'storages', 'stable', 'keep.txt'), 'sandbox-stable-v1\n');
  writeIfMissing(path.join(SANDBOX, 'home', 'storages', 'session_projcache', 'sessions', 'session-1.json'), '{"session":"sandbox-1"}\n');
  writeIfMissing(path.join(SANDBOX, 'profile', 'package.json'), '{"name":"guardian-sandbox-profile","version":"1.0.0","dependencies":{}}\n');
  writeIfMissing(path.join(SANDBOX, 'profile', 'cordis.patch.yml'), '');
  writeIfMissing(path.join(SANDBOX, 'profile', 'cordis.yml'), '');
  writeIfMissing(path.join(SANDBOX, 'profile', 'pnpm-workspace.yaml'), '');
  writeIfMissing(path.join(SANDBOX, 'profile', 'pnpm-lock.yaml'), '');

  console.log('[sandbox-init] 沙箱就绪');
  console.log(`  root      : ${SANDBOX}`);
  console.log(`  guardian  : ${GUARDIAN_DST}`);
  console.log(`  launch    : ${notepad}`);
  console.log(`  dshHome   : ${path.join(SANDBOX, 'home')}`);
  console.log(`  fixture   : ${FIXTURE_ROOT}  (最小骨架，可直接 --root 使用)`);
  console.log('  UI        : http://127.0.0.1:3082/  (node ui/server.mjs --sandbox)');
  return config;
}

// ---------------------------------------------------------------- main

const rootConfig = FIXTURE_ONLY
  ? readRootConfig()
  : initSandbox();

initFixtureRoot(rootConfig);

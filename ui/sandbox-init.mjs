#!/usr/bin/env node
/**
 * sandbox-init.mjs — 初始化 / 刷新 UI 沙箱演练场（零第三方依赖）
 *
 * 目录：<项目根>/sandbox
 * 任何 UI 命令都会在这个目录下执行，config.launch 指向 notepad.exe，
 * 不会触碰真实的 DSH 客户端与 ~/.dsh 环境。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(UI_DIR, '..');
const SANDBOX = path.join(ROOT, 'sandbox');
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

ensureDir(path.join(SANDBOX, 'bin'));
ensureDir(path.join(SANDBOX, 'home', 'storages', 'session_projcache', 'sessions'));
ensureDir(path.join(SANDBOX, 'home', 'storages', 'stable'));
ensureDir(path.join(SANDBOX, 'profile', 'node_modules'));
ensureDir(path.join(SANDBOX, 'profile', '.plugin-manager'));
ensureDir(path.join(SANDBOX, 'profile', '.dsh-market'));
ensureDir(path.join(SANDBOX, 'backups'));
ensureDir(path.join(SANDBOX, 'logs'));

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

console.log('[sandbox-init] 沙箱就绪');
console.log(`  root      : ${SANDBOX}`);
console.log(`  guardian  : ${GUARDIAN_DST}`);
console.log(`  launch    : ${notepad}`);
console.log(`  dshHome   : ${path.join(SANDBOX, 'home')}`);
console.log('  UI        : http://127.0.0.1:3082/  (node ui/server.mjs --sandbox)');

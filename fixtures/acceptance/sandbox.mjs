#!/usr/bin/env node
// Step-3 acceptance harness.
//
// The sandbox is materialized from the guardian's own verified snapshot
// (backups/snap-a/meta.json + content-addressed _store). The live profile is not
// opened at all: no reads, no writes. Every fault-injection test then runs against
// fixtures/sandbox with `--root fixtures/sandbox/root`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GUARDIAN = path.resolve(import.meta.dirname, '..', '..');
const SANDBOX = path.join(GUARDIAN, 'fixtures', 'sandbox');
const HOME = path.join(SANDBOX, 'home');
const ROOT = path.join(SANDBOX, 'root');
const PROFILE = path.join(HOME, 'profiles', 'desktop');
const SOURCES = path.join(SANDBOX, 'sources');
const STORE = path.join(GUARDIAN, 'backups', '_store');
const SNAPSHOT_META = path.join(GUARDIAN, 'backups', 'snap-a', 'meta.json');
const CLIENT_EXE = 'C:\\Users\\28256\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const posix = (value) => String(value).replace(/\\/g, '/');

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function blobPath(hash) { return path.join(STORE, hash.slice(0, 2), hash); }

function build() {
  if (!fs.existsSync(SNAPSHOT_META)) throw new Error(`snapshot meta 缺失: ${SNAPSHOT_META}`);
  const meta = JSON.parse(fs.readFileSync(SNAPSHOT_META, 'utf8'));

  rmrf(SANDBOX);
  const dest = {
    profile: PROFILE,
    'dshHome/mcp': path.join(HOME, 'mcp'),
    'dshHome/storages': path.join(HOME, 'storages'),
    'dshHome/.agent-presets': path.join(HOME, '.agent-presets'),
    'dshHome/settings.yaml.imported': path.join(HOME, 'settings.yaml.imported'),
    'file:dsh-infinite-gen-2': path.join(HOME, 'plugins', 'dsh-infinite-gen-2'),
    [Object.keys(meta.roots).find((name) => name.startsWith('source:'))]: path.join(SOURCES, 'novel_assistance')
  };

  const sandboxSource = dest[Object.keys(meta.roots).find((name) => name.startsWith('source:'))];
  const resolveDest = (rootName, rel) => {
    const base = dest[rootName];
    if (!base) throw new Error(`root 未映射: ${rootName}`);
    return rel ? path.join(base, rel.split('/').join(path.sep)) : base;
  };

  let copied = 0;
  for (const file of meta.files) {
    const target = resolveDest(file.root, file.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const blob = blobPath(file.sha256);
    if (!fs.existsSync(blob)) throw new Error(`blob 缺失: ${blob}`);
    fs.copyFileSync(blob, target);
    try { fs.chmodSync(target, 0o666); } catch { /* clear inherited read-only */ }
    copied += 1;
  }
  for (const dir of meta.dirs) {
    fs.mkdirSync(resolveDest(dir.root, dir.rel), { recursive: true });
  }
  for (const link of meta.links) {
    const target = resolveDest(link.root, link.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let linkTarget = link.target;
    if (linkTarget && linkTarget.includes('Github/novel_assistance')) linkTarget = posix(sandboxSource);
    const absolute = path.isAbsolute(linkTarget);
    try {
      if (absolute) fs.symlinkSync(linkTarget, target, 'junction');
      else fs.symlinkSync(linkTarget, target, 'dir');
    } catch (error) {
      console.error(`link 创建失败: ${target} -> ${linkTarget}: ${error.message}`);
    }
  }

  // rewrite the sandbox-only absolute link spec
  const pkgPath = path.join(PROFILE, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['novel-agents-md'] = `link:${posix(sandboxSource)}`;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // shared dependency root stubs (restore must never touch these)
  const sharedRoot = path.join(HOME, 'profiles', 'node_modules');
  for (const name of ['@acme/shared-alpha', 'shared-beta']) {
    const dir = path.join(sharedRoot, name.split('/').join(path.sep));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.1-sandbox', main: 'index.js' }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = ${JSON.stringify(name)};\n`, 'utf8');
  }

  fs.mkdirSync(path.join(ROOT, 'transactions'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'backups', '_store'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'backups', 'disabled-entries'), { recursive: true });

  const config = {
    dshHome: HOME,
    profile: 'desktop',
    profileDir: PROFILE,
    launchMode: 'electron-exe',
    launch: [CLIENT_EXE],
    expectedClientVersion: '0.2.1-rc.2',
    portMode: 'dynamic',
    port: 0,
    startTimeoutMs: 90000,
    settleMs: 15000,
    probeStartTimeoutMs: 45000,
    probeSettleMs: 8000,
    maxBisectMs: 300000,
    singleInstance: 'kill-first',
    killGraceMs: 5000,
    lockTimeoutMs: 600000,
    snapshotMode: 'exact',
    snapshotStorage: 'content-addressed-hardlink',
    storeDir: 'backups\\_store',
    storeGcOnPrune: true,
    trackedFiles: ['cordis.patch.yml', 'package.json', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'],
    trackedRuntimePaths: ['node_modules', '.plugin-manager', '.dsh-market'],
    trackedSourcePaths: [path.join(HOME, 'plugins', 'dsh-infinite-gen-2'), sandboxSource],
    sourceInclude: ['**/*'],
    sourceExclude: ['node_modules', '.git', '.cache', '.pnpm-store', 'dist', 'cache', '*.log'],
    dshHomeTrackedPaths: ['mcp', 'storages', '.agent-presets', 'settings.yaml', 'settings.yaml.imported'],
    dshHomeExclude: ['sessions', 'cache', 'dsh-runtimes', 'attachments', 'llm-deepseek', '.credentials.yaml'],
    sharedDependencyRoots: [sharedRoot],
    driftPolicy: 'adopt-if-healthy',
    crashPolicy: 'resume',
    verifyPluginLoad: true,
    blockOnClientMismatch: true,
    keepTransactions: 20,
    keepLkg: 3
  };
  fs.writeFileSync(path.join(ROOT, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'state.json'), `${JSON.stringify({
    version: 5,
    activeOperation: null,
    safe: false,
    culprit: null,
    instance: { rootPid: null, descendantPids: [], port: null, httpStatus: null, healthy: false },
    drift: { detected: false, digest: null, lastCommittedDigest: null, addedPaths: [], changedPaths: [], removedPaths: [] }
  }, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    status: 'built',
    sandbox: posix(SANDBOX),
    root: posix(ROOT),
    profile: posix(PROFILE),
    filesCopied: copied,
    fromSnapshot: posix(SNAPSHOT_META)
  }, null, 2));
}

function paths() {
  return {
    pkg: path.join(PROFILE, 'package.json'),
    lock: path.join(PROFILE, 'pnpm-lock.yaml'),
    readme: path.join(SOURCES, 'novel_assistance', 'README.md'),
    marker: 'guardian sandbox probe',
    extra: path.join(PROFILE, 'guardian-extra-probe.txt')
  };
}

function mutate() {
  const p = paths();
  const pkg = JSON.parse(fs.readFileSync(p.pkg, 'utf8'));
  pkg.dependencies['guardian-probe'] = '9.9.9';
  fs.writeFileSync(p.pkg, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  for (const file of [p.lock, p.readme]) {
    if (!fs.readFileSync(file, 'utf8').includes(p.marker)) fs.appendFileSync(file, `# ${p.marker}\n`, 'utf8');
  }
  console.log(JSON.stringify({ status: 'mutated', check: check() }, null, 2));
}

function check() {
  const p = paths();
  return {
    packageJson: sha256(p.pkg),
    pnpmLock: sha256(p.lock),
    readme: sha256(p.readme),
    probeDependency: Boolean(JSON.parse(fs.readFileSync(p.pkg, 'utf8')).dependencies?.['guardian-probe']),
    lockMarker: fs.readFileSync(p.lock, 'utf8').includes(p.marker),
    readmeMarker: fs.readFileSync(p.readme, 'utf8').includes(p.marker)
  };
}

// Blob used for the tamper test: a sandbox file the harness never mutates.
function tamperTarget() {
  const file = path.join(PROFILE, 'node_modules', '.modules.yaml');
  return { file, hash: sha256(file) };
}

function tamper() {
  const { file, hash } = tamperTarget();
  const blob = path.join(ROOT, 'backups', '_store', hash.slice(0, 2), hash);
  if (!fs.existsSync(blob)) throw new Error(`blob 不存在，先跑 snapshot: ${blob}`);
  const backup = `${blob}.acceptance-backup`;
  fs.copyFileSync(blob, backup);
  try { fs.chmodSync(blob, 0o666); } catch { /* clear read-only */ }
  const buffer = fs.readFileSync(blob);
  buffer[0] = buffer[0] ^ 0xff;
  fs.writeFileSync(blob, buffer);
  try { fs.chmodSync(blob, 0o444); } catch { /* read-only back */ }
  console.log(JSON.stringify({ status: 'tampered', blob: posix(blob), backup: posix(backup), originalHash: hash }, null, 2));
}

function repair() {
  const { file, hash } = tamperTarget();
  const blob = path.join(ROOT, 'backups', '_store', hash.slice(0, 2), hash);
  const backup = `${blob}.acceptance-backup`;
  try { fs.chmodSync(blob, 0o666); } catch { /* clear read-only before overwrite */ }
  fs.copyFileSync(file, blob);
  try { fs.chmodSync(blob, 0o444); } catch { /* read-only again */ }
  if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  console.log(JSON.stringify({ status: 'repaired', blob: posix(blob), sha256: sha256(blob), matches: sha256(blob) === hash }, null, 2));
}

function extra() {
  const p = paths();
  const token = `extra-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(p.extra, `${token}\n`, 'utf8');
  console.log(JSON.stringify({ status: 'extra-created', file: posix(p.extra), sha256: sha256(p.extra), token }, null, 2));
}

function stats() {
  const store = path.join(ROOT, 'backups', '_store');
  let blobs = 0;
  let bytes = 0;
  if (fs.existsSync(store)) {
    const stack = [store];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) { stack.push(full); continue; }
        blobs += 1;
        bytes += fs.statSync(full).size;
      }
    }
  }
  const sharedRoot = path.join(HOME, 'profiles', 'node_modules');
  const shared = fs.existsSync(sharedRoot) ? fs.readdirSync(sharedRoot) : [];
  const snapshots = fs.existsSync(path.join(ROOT, 'backups'))
    ? fs.readdirSync(path.join(ROOT, 'backups'), { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory() && fs.existsSync(path.join(ROOT, 'backups', dirent.name, 'meta.json')))
        .map((dirent) => dirent.name)
    : [];
  console.log(JSON.stringify({ store: { blobs, bytes }, shared, snapshots }, null, 2));
}

function verify() {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'backups', 'sandbox-a', 'meta.json'), 'utf8'));
  const sourceRoot = Object.keys(meta.roots).find((name) => name.startsWith('source:'));
  const wanted = [
    { root: 'profile', rel: 'package.json', label: 'profile/package.json' },
    { root: 'profile', rel: 'pnpm-lock.yaml', label: 'profile/pnpm-lock.yaml' },
    { root: sourceRoot, rel: 'README.md', label: `${sourceRoot}/README.md` }
  ];
  const rows = [];
  for (const item of wanted) {
    const entry = meta.files.find((file) => file.root === item.root && file.rel === item.rel);
    const actualRel = item.root === sourceRoot ? 'README.md' : item.rel;
    const actualPath = path.join(destBase(item.root), actualRel.split('/').join(path.sep));
    const actual = fs.existsSync(actualPath) ? sha256(actualPath) : null;
    rows.push({ label: item.label, expected: entry?.sha256 ?? null, actual, match: Boolean(entry && actual === entry.sha256) });
  }
  console.log(JSON.stringify({ check: rows, digest: meta.digest, allMatch: rows.every((row) => row.match) }, null, 2));
}

function destBase(rootName) {
  const map = {
    profile: PROFILE,
    'dshHome/mcp': path.join(HOME, 'mcp'),
    'dshHome/storages': path.join(HOME, 'storages'),
    'dshHome/.agent-presets': path.join(HOME, '.agent-presets'),
    'dshHome/settings.yaml.imported': path.join(HOME, 'settings.yaml.imported'),
    'file:dsh-infinite-gen-2': path.join(HOME, 'plugins', 'dsh-infinite-gen-2')
  };
  if (map[rootName]) return map[rootName];
  if (rootName.startsWith('source:')) return path.join(SOURCES, 'novel_assistance');
  throw new Error(`unknown root ${rootName}`);
}

function checkCommand() {
  console.log(JSON.stringify(check(), null, 2));
}

const commands = { build, mutate, check: checkCommand, verify, tamper, repair, extra, stats };
const command = process.argv[2] ?? 'build';
if (!commands[command]) {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
commands[command]();

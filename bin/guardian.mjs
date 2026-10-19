#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

function resolveRoot() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--root');
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1]);
  if (process.env.GUARDIAN_ROOT) return path.resolve(process.env.GUARDIAN_ROOT);
  return path.resolve(import.meta.dirname, '..');
}

const ROOT = resolveRoot();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');
const LOCK_PATH = path.join(ROOT, '.guardian.lock');
const INTENT_PATH = path.join(ROOT, 'logs', 'intent.json');

const CONFIG_KEYS = [
  'dshHome', 'profile', 'profileDir', 'launchMode', 'launch', 'expectedClientVersion',
  'portMode', 'port', 'startTimeoutMs', 'settleMs', 'probeStartTimeoutMs',
  'probeSettleMs', 'maxBisectMs', 'singleInstance', 'killGraceMs', 'lockTimeoutMs',
  'snapshotMode', 'snapshotStorage', 'storeDir', 'storeGcOnPrune', 'trackedFiles',
  'trackedRuntimePaths', 'trackedSourcePaths', 'sourceInclude', 'sourceExclude',
  'dshHomeTrackedPaths', 'dshHomeExclude', 'storageVolatilePaths', 'sharedDependencyRoots', 'driftPolicy',
  'crashPolicy', 'verifyPluginLoad', 'blockOnClientMismatch', 'keepTransactions', 'keepLkg',
  'pruneKeepLabels'
];

// ---------------------------------------------------------------- json / io

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`读取 ${file} 失败: ${error.message}`); }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadConfig() { return loadJson(CONFIG_PATH); }
function loadState() {
  const state = loadJson(STATE_PATH);
  if (typeof state.safe !== 'boolean') state.safe = false;
  if (typeof state.probing !== 'boolean') state.probing = false;
  if (!Array.isArray(state.disabled)) state.disabled = [];
  return state;
}
function saveState(state) { saveJson(STATE_PATH, state); }

function acquireLock(config, command) {
  const timeout = Number(config.lockTimeoutMs ?? 600000);
  if (fs.existsSync(LOCK_PATH)) {
    const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    let ownerAlive = false;
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (lock.pid && Number(lock.pid) !== process.pid) {
        process.kill(Number(lock.pid), 0);
        ownerAlive = true;
      }
    } catch { ownerAlive = false; }
    if (ownerAlive && age <= timeout) {
      console.error(`LOCKED: guardian 已被占用 (${LOCK_PATH})`);
      process.exitCode = 2;
      return null;
    }
    fs.rmSync(LOCK_PATH, { force: true });
  }
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() })}\n`, 'utf8');
    fs.closeSync(fd);
    return () => fs.rmSync(LOCK_PATH, { force: true });
  } catch (error) {
    console.error(`LOCKED: 无法获取 guardian 锁: ${error.message}`);
    process.exitCode = 2;
    return null;
  }
}

function writeIntent(command, args) {
  saveJson(INTENT_PATH, { command, args, pid: process.pid, startedAt: new Date().toISOString() });
}

function transition(state, op, phase, extra = {}) {
  state.activeOperation = { ...op, phase, ...extra, updatedAt: new Date().toISOString() };
  saveState(state);
  return state;
}

function printJson(value) { console.log(JSON.stringify(value, null, 2)); }

// ---------------------------------------------------------------- hashing / fs

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
      position += read;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function toPosix(value) { return String(value).replace(/\\/g, '/'); }

function statSafe(target) {
  try { return fs.lstatSync(target); } catch { return null; }
}

function exists(target) { return fs.existsSync(target); }

function matchExclude(name, excludeList) {
  for (const raw of excludeList || []) {
    if (raw.startsWith('*.')) {
      if (name.endsWith(raw.slice(1))) return true;
      continue;
    }
    if (raw.includes('*')) {
      const pattern = `^${raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`;
      if (new RegExp(pattern).test(name)) return true;
      continue;
    }
    if (name === raw) return true;
  }
  return false;
}

function walkTree(root, { exclude = [], hash = true } = {}) {
  const nodes = [];
  const stack = [{ dir: root, rel: '' }];
  while (stack.length > 0) {
    const { dir, rel } = stack.pop();
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
      const full = path.join(dir, dirent.name);
      if (matchExclude(dirent.name, exclude)) continue;
      const stat = statSafe(full);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        let target = null;
        try { target = toPosix(fs.readlinkSync(full)); } catch { target = null; }
        nodes.push({ rel: relPath, kind: 'link', target });
        continue;
      }
      if (stat.isDirectory()) {
        nodes.push({ rel: relPath, kind: 'dir' });
        stack.push({ dir: full, rel: relPath });
        continue;
      }
      nodes.push({
        rel: relPath,
        kind: 'file',
        size: stat.size,
        sha256: hash ? sha256File(full) : null
      });
    }
  }
  return nodes;
}

function directoryEntry(root, { exclude = [], hash = true, volatilePrefixes = [] } = {}) {
  const nodes = walkTree(root, { exclude, hash });
  const files = nodes.filter((node) => node.kind === 'file');
  const bytes = files.reduce((sum, node) => sum + (node.size || 0), 0);
  const line = (node) => `${node.rel}\t${node.kind}\t${node.size ?? 0}\t${node.sha256 || node.target || ''}`;
  const isVolatile = (node) => volatilePrefixes.some((prefix) => node.rel === prefix || node.rel.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  const stableNodes = nodes.filter((node) => !isVolatile(node));
  const stableFiles = stableNodes.filter((node) => node.kind === 'file');
  const entry = {
    kind: 'directory',
    target: toPosix(root),
    files: files.length,
    bytes,
    listingSha256: sha256Buffer(Buffer.from(nodes.map(line).join('\n'), 'utf8'))
  };
  if (volatilePrefixes.length > 0) {
    entry.volatileFiles = files.length - stableFiles.length;
    entry.stableFiles = stableFiles.length;
    entry.stableBytes = stableFiles.reduce((sum, node) => sum + (node.size || 0), 0);
    entry.stableListingSha256 = sha256Buffer(Buffer.from(stableNodes.map(line).join('\n'), 'utf8'));
  }
  return entry;
}

function fileEntry(file, { hash = true, extra = {} } = {}) {
  const stat = fs.statSync(file);
  return { kind: 'file', size: stat.size, sha256: hash ? sha256File(file) : null, ...extra };
}

function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
}

function digestOf(entries) {
  const list = Object.keys(entries).sort().filter((key) => !entries[key]?.digestExcluded).map((key) => {
    const entry = entries[key];
    if (entry && entry.kind === 'directory' && entry.stableListingSha256) {
      const payload = { ...entry, files: entry.stableFiles, bytes: entry.stableBytes, listingSha256: entry.stableListingSha256 };
      delete payload.stableListingSha256;
      delete payload.stableFiles;
      delete payload.stableBytes;
      delete payload.volatileFiles;
      return `${key}|${canon(payload)}`;
    }
    return `${key}|${canon(entry)}`;
  });
  return sha256Buffer(Buffer.from(list.join('\n'), 'utf8'));
}

// ---------------------------------------------------------------- client fingerprint

function readAsarPackageJson(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) < 8) return null;
    const headerSize = head.readUInt32LE(4);
    if (headerSize <= 8 || headerSize > 64 * 1024 * 1024) return null;
    const header = Buffer.alloc(headerSize);
    if (fs.readSync(fd, header, 0, headerSize, 8) < headerSize) return null;
    const stringLength = header.readUInt32LE(4);
    if (stringLength <= 0 || stringLength > headerSize - 8) return null;
    const index = JSON.parse(header.subarray(8, 8 + stringLength).toString('utf8'));
    const entry = index?.files?.['package.json'];
    if (!entry || typeof entry.offset !== 'string') return null;
    const base = 8 + headerSize + Number(entry.offset);
    const buffer = Buffer.alloc(entry.size);
    if (fs.readSync(fd, buffer, 0, entry.size, base) < entry.size) return null;
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function exeVersion(exe) {
  try {
    const escaped = exe.replace(/'/g, "''");
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`
    ], { timeout: 20000 }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolveClientFingerprint(config, { hash = true } = {}) {
  const exe = Array.isArray(config.launch) ? config.launch[0] : null;
  const resourcesDir = exe ? path.join(path.dirname(exe), 'resources') : null;
  const asarPath = resourcesDir ? path.join(resourcesDir, 'app.asar') : null;
  const asarExists = Boolean(asarPath && exists(asarPath));
  const asarPackage = asarExists ? readAsarPackageJson(asarPath) : null;
  const clientVersion = asarPackage?.version ?? (exe && exists(exe) ? exeVersion(exe) : null);
  return {
    exePath: exe ? toPosix(exe) : null,
    exeExists: Boolean(exe && exists(exe)),
    clientAsarPath: asarPath ? toPosix(asarPath) : null,
    clientAsarExists: asarExists,
    clientAsarSha256: asarExists && hash ? sha256File(asarPath) : null,
    clientVersion: clientVersion ?? null,
    clientPackageName: asarPackage?.name ?? null
  };
}

function runtimeInfo(config, client) {
  let pnpmVersion = null;
  try {
    pnpmVersion = execFileSync('cmd.exe', ['/d', '/c', 'pnpm --version'], { timeout: 15000 }).toString().trim() || null;
  } catch {
    pnpmVersion = null;
  }
  return {
    nodeVersion: process.version,
    pnpmVersion,
    clientVersion: client.clientVersion,
    clientAsarPath: client.clientAsarPath,
    clientAsarSha256: client.clientAsarSha256,
    platform: process.platform,
    arch: process.arch,
    launchArgs: Array.isArray(config.launch) ? config.launch : []
  };
}

// ---------------------------------------------------------------- patch refs

function parsePatchRefs(patchPath) {
  const result = { refs: [], inserts: [], parseError: null };
  if (!exists(patchPath)) return result;
  let text;
  try { text = fs.readFileSync(patchPath, 'utf8'); }
  catch (error) { result.parseError = error.message; return result; }
  let current = null;
  let inInsert = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const topItem = /^-\s+(.*)$/.exec(line);
    if (topItem) {
      current = { id: null, name: null };
      result.refs.push(current);
      inInsert = false;
      const idMatch = /^id:\s*["']?([^"'\s]+)["']?/.exec(topItem[1]);
      if (idMatch) current.id = idMatch[1];
      continue;
    }
    if (!current) continue;
    if (/^\s{2,}insert:\s*$/.test(line)) { inInsert = true; continue; }
    if (inInsert) {
      const insertItem = /^\s{4,}-\s*(.*)$/.exec(line);
      if (insertItem) {
        const nameMatch = /name:\s*["']?([^"'\s]+)["']?/.exec(insertItem[1]);
        if (nameMatch) result.inserts.push(nameMatch[1]);
        continue;
      }
      if (/^\s{2}\S/.test(line)) inInsert = false;
    }
    const rowName = /^\s{2}name:\s*["']?([^"'\s]+)["']?/.exec(line);
    if (rowName && !current.name) current.name = rowName[1];
    const rowId = /^\s{2}id:\s*["']?([^"'\s]+)["']?/.exec(line);
    if (rowId && !current.id) current.id = rowId[1];
  }
  return result;
}

// ---------------------------------------------------------------- runtimeClosure

// Live session cache under ~/.dsh/storages is rewritten by the running client on
// every interaction; it stays in the closure (restore still materializes it) but is
// excluded from digest so drift detection does not fire on interactive churn.
// 以 config.storageVolatilePaths 为准（路径相对于 ~/.dsh/storages），保留默认值兼容旧配置。
const STORAGE_VOLATILE_FALLBACK = ['session_projcache/sessions'];

function storageVolatilePrefixes(config) {
  const raw = config && Array.isArray(config.storageVolatilePaths) ? config.storageVolatilePaths : null;
  const list = (raw ?? STORAGE_VOLATILE_FALLBACK)
    .map((item) => String(item).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return [...new Set(list)];
}

function resolveSharedOwners(profilesRoot, name, cache) {
  if (cache.owners.has(name)) return cache.owners.get(name);
  const owners = [];
  if (!cache.profiles) {
    try {
      cache.profiles = fs.readdirSync(profilesRoot, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
    } catch {
      cache.profiles = [];
    }
  }
  for (const profileName of cache.profiles) {
    const profileDir = path.join(profilesRoot, profileName);
    const pkg = readJsonSafe(path.join(profileDir, 'package.json'));
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    let claimed = Object.prototype.hasOwnProperty.call(deps, name);
    if (!claimed) {
      const depPath = path.join(profileDir, 'node_modules', name.split('/').join(path.sep));
      claimed = exists(depPath);
    }
    if (claimed) owners.push(profileName);
  }
  if (owners.length === 0) owners.push('unowned');
  cache.owners.set(name, owners);
  return owners;
}

function dependencyLinkEntry(linkPath) {
  const stat = statSafe(linkPath);
  if (!stat) return { linkExists: false, linkType: null, linkTarget: null };
  let linkTarget = null;
  try { linkTarget = fs.readlinkSync(linkPath); } catch { linkTarget = null; }
  if (!stat.isSymbolicLink()) {
    return { linkExists: true, linkType: 'directory', linkTarget: null };
  }
  const absolute = linkTarget ? path.isAbsolute(linkTarget) : false;
  return {
    linkExists: true,
    linkType: absolute ? 'junction' : 'symlink',
    linkTarget: toPosix(path.resolve(path.dirname(linkPath), linkTarget ?? ''))
  };
}

function discoverRuntimeClosure(config, { hash = true } = {}) {
  const profileDir = config.profileDir;
  const nodeModules = path.join(profileDir, 'node_modules');
  const entries = {};
  const missing = [];
  const dependencies = { file: [], link: [] };
  const sourceExclude = config.sourceExclude || [];
  const timing = process.env.GUARDIAN_TIMING === '1';
  let mark = Date.now();
  const tick = (label) => {
    if (!timing) return;
    const now = Date.now();
    console.error(`[timing] ${label}: ${now - mark}ms`);
    mark = now;
  };

  for (const tracked of config.trackedFiles || []) {
    const key = `profile/${tracked}`;
    const full = path.join(profileDir, tracked);
    if (!exists(full)) {
      entries[key] = { kind: 'missing', exists: false };
      missing.push(key);
      continue;
    }
    entries[key] = fileEntry(full, { hash });
  }

  const sharedProfilesRoot = path.dirname(profileDir);
  const sharedCache = { profiles: null, owners: new Map() };

  tick('trackedFiles');

  if (exists(nodeModules)) {
    entries['profile/node_modules'] = directoryEntry(nodeModules, { hash });
  } else {
    entries['profile/node_modules'] = { kind: 'missing', exists: false };
    missing.push('profile/node_modules');
  }

  for (const tracked of config.trackedRuntimePaths || []) {
    if (tracked === 'node_modules') continue;
    const key = `profile/${tracked}`;
    const full = path.join(profileDir, tracked);
    if (!exists(full)) {
      entries[key] = { kind: 'missing', exists: false };
      missing.push(key);
      continue;
    }
    const stat = fs.lstatSync(full);
    entries[key] = stat.isDirectory() ? directoryEntry(full, { hash }) : fileEntry(full, { hash });
  }

  tick('profileRuntimePaths');

  const profilePackage = readJsonSafe(path.join(profileDir, 'package.json'));
  const declaredDeps = { ...(profilePackage?.dependencies || {}) };
  for (const [name, spec] of Object.entries(declaredDeps)) {
    const value = String(spec);
    if (value.startsWith('file:')) {
      const target = path.resolve(profileDir, value.slice('file:'.length));
      const key = `file:${name}`;
      const targetStat = statSafe(target);
      const targetPackage = targetStat ? readJsonSafe(path.join(target, 'package.json')) : null;
      const base = {
        kind: 'directory',
        target: toPosix(target),
        exists: Boolean(targetStat),
        packageName: targetPackage?.name ?? null,
        packageVersion: targetPackage?.version ?? null,
        main: targetPackage?.main ?? null
      };
      entries[key] = targetStat
        ? { ...directoryEntry(target, { exclude: sourceExclude, hash }), ...base }
        : { ...base, kind: 'missing' };
      if (!targetStat) missing.push(key);
      dependencies.file.push({ name, spec: value, target: toPosix(target), exists: Boolean(targetStat) });

      const childPath = path.join(nodeModules, name);
      const childStat = statSafe(childPath);
      if (childStat) {
        entries[`profile/node_modules/${name}`] = childStat.isSymbolicLink()
          ? { kind: 'link', linkType: 'junction', target: toPosix(fs.readlinkSync(childPath)) }
          : { kind: 'directory', ...directoryEntry(childPath, { hash }) };
      }
      continue;
    }
    if (value.startsWith('link:')) {
      const declaredTarget = path.resolve(profileDir, value.slice('link:'.length));
      const key = `link:${name}`;
      const targetStat = statSafe(declaredTarget);
      const linkInfo = dependencyLinkEntry(path.join(nodeModules, name));
      const base = {
        kind: 'link',
        target: toPosix(declaredTarget),
        targetExists: Boolean(targetStat),
        ...linkInfo
      };
      entries[key] = targetStat
        ? { ...directoryEntry(declaredTarget, { exclude: sourceExclude, hash }), ...base }
        : { ...base, kind: 'missing' };
      if (!targetStat) missing.push(key);
      dependencies.link.push({
        name,
        spec: value,
        target: toPosix(declaredTarget),
        linkExists: linkInfo.linkExists,
        linkType: linkInfo.linkType,
        targetExists: Boolean(targetStat)
      });
      const sourceKey = `source:${toPosix(declaredTarget)}`;
      entries[sourceKey] = targetStat
        ? { kind: 'source', ...directoryEntry(declaredTarget, { exclude: sourceExclude, hash }) }
        : { kind: 'missing', exists: false };
      if (!targetStat) missing.push(sourceKey);
    }
  }

  tick('dependencies');
  const patch = parsePatchRefs(path.join(profileDir, 'cordis.patch.yml'));
  for (const ref of patch.refs) {
    const key = `patch:${ref.id ?? ref.name ?? 'unknown'}`;
    const resolvable = Boolean(ref.name && (exists(path.join(nodeModules, ref.name)) || exists(path.join(profileDir, 'node_modules', ref.name)) || (declaredDeps[ref.name] && (String(declaredDeps[ref.name]).startsWith('file:') || String(declaredDeps[ref.name]).startsWith('link:')))));
    entries[key] = {
      kind: 'patch-ref',
      id: ref.id,
      name: ref.name,
      declared: 'row',
      resolvable,
      builtin: Boolean(ref.name && ref.name.startsWith('@deepseek-ai/'))
    };
  }
  for (const insertName of patch.inserts) {
    const key = `patch-insert:${insertName}`;
    entries[key] = {
      kind: 'patch-insert',
      name: insertName,
      declared: 'insert',
      resolvable: exists(path.join(nodeModules, insertName)) || exists(path.resolve(profileDir, insertName)) || Boolean(declaredDeps[insertName] && (String(declaredDeps[insertName]).startsWith('file:') || String(declaredDeps[insertName]).startsWith('link:'))),
      builtin: insertName.startsWith('@deepseek-ai/')
    };
  }

  for (const tracked of config.dshHomeTrackedPaths || []) {
    const key = `dshHome/${tracked}`;
    const full = path.join(config.dshHome, tracked);
    const stat = statSafe(full);
    if (!stat) {
      entries[key] = { kind: 'missing', exists: false, optional: /^settings\.yaml/.test(tracked) };
      missing.push(key);
      continue;
    }
    const volatilePrefixes = tracked === 'storages' ? storageVolatilePrefixes(config) : [];
    entries[key] = stat.isDirectory()
      ? directoryEntry(full, { hash, volatilePrefixes })
      : fileEntry(full, { hash });
  }

  const credentialsPath = path.join(config.dshHome, '.credentials.yaml');
  if (exists(credentialsPath)) {
    const stat = fs.statSync(credentialsPath);
    entries['dshHome/.credentials.yaml'] = {
      kind: 'file',
      size: stat.size,
      sha256: hash ? sha256File(credentialsPath) : null,
      redacted: true,
      contentStored: false,
      digestExcluded: true
    };
  }

  for (const root of config.sharedDependencyRoots || []) {
    if (!exists(root)) continue;
    let dirents = [];
    try { dirents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue;
      if (dirent.name.startsWith('@')) {
        const scopeDir = path.join(root, dirent.name);
        let scoped = [];
        try { scoped = fs.readdirSync(scopeDir, { withFileTypes: true }); } catch { continue; }
        for (const sub of scoped) {
          if (sub.name.startsWith('.')) continue;
          const full = path.join(scopeDir, sub.name);
          const key = `shared/${dirent.name}/${sub.name}`;
          const pkg = readJsonSafe(path.join(full, 'package.json'));
          entries[key] = {
            kind: sub.isSymbolicLink() ? 'link' : 'directory',
            target: toPosix(full),
            owners: resolveSharedOwners(sharedProfilesRoot, `${dirent.name}/${sub.name}`, sharedCache),
            version: pkg?.version ?? null
          };
        }
        continue;
      }
      const full = path.join(root, dirent.name);
      const key = `shared/${dirent.name}`;
      const pkg = readJsonSafe(path.join(full, 'package.json'));
      entries[key] = {
        kind: dirent.isSymbolicLink() ? 'link' : 'directory',
        target: toPosix(full),
        owners: resolveSharedOwners(sharedProfilesRoot, dirent.name, sharedCache),
        version: pkg?.version ?? null
      };
    }
  }

  tick('dshHome');

  const client = resolveClientFingerprint(config, { hash });
  tick('clientFingerprint');
  const runtime = runtimeInfo(config, client);
  tick('runtimeInfo');
  const digest = digestOf(entries);
  tick('digest');
  return {
    profile: config.profile,
    profileDir: toPosix(profileDir),
    mode: config.snapshotMode,
    storage: config.snapshotStorage,
    digest,
    entries,
    missing,
    dependencies,
    client,
    runtime
  };
}

// ---------------------------------------------------------------- commands

function doctor(config, state) {
  const missingKeys = CONFIG_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(config, key));
  const exe = config.launch?.[0];
  const checks = {
    profile: config.profile,
    profileDirExists: fs.existsSync(config.profileDir),
    clientExe: exe,
    clientExeExists: Boolean(exe && fs.existsSync(exe)),
    configKeysComplete: missingKeys.length === 0,
    missingConfigKeys: missingKeys,
    lockHeld: fs.existsSync(LOCK_PATH),
    stateVersion: state.version,
    activeOperation: state.activeOperation,
    drift: state.drift
  };
  printJson(checks);
  const failed = !checks.profileDirExists || !checks.clientExeExists || !checks.configKeysComplete;
  return failed ? 1 : 0;
}

function runtimeInventory(config, args) {
  const jsonOutIndex = args.indexOf('--json-out');
  const jsonOut = jsonOutIndex >= 0 ? args[jsonOutIndex + 1] : null;
  const hash = !args.includes('--no-hash');
  const inventory = discoverRuntimeClosure(config, { hash });
  const payload = {
    profile: inventory.profile,
    profileDir: inventory.profileDir,
    mode: inventory.mode,
    storage: inventory.storage,
    digest: inventory.digest,
    entryCount: Object.keys(inventory.entries).length,
    missing: inventory.missing,
    dependencies: inventory.dependencies,
    runtime: inventory.runtime,
    entries: inventory.entries
  };
  printJson(payload);
  if (jsonOut) saveJson(path.resolve(jsonOut), payload);
  return 0;
}

function preflightReport(config, args = []) {
  const allowMismatch = args.includes('--allow-client-mismatch');
  const fails = [];
  const warns = [];
  const inventory = discoverRuntimeClosure(config, { hash: false });

  for (const key of inventory.missing) {
    const entry = inventory.entries[key];
    if (entry && entry.optional) warns.push(`optional-missing:${key}`);
    else fails.push(`missing:${key}`);
  }
  for (const dep of inventory.dependencies.file) {
    if (!dep.exists) fails.push(`file-target-missing:${dep.name} -> ${dep.target}`);
  }
  for (const dep of inventory.dependencies.link) {
    if (!dep.linkExists) fails.push(`link-missing:${dep.name}`);
    if (!dep.targetExists) fails.push(`link-target-missing:${dep.name} -> ${dep.target}`);
  }
  for (const [key, entry] of Object.entries(inventory.entries)) {
    if (entry.kind !== 'patch-ref' && entry.kind !== 'patch-insert') continue;
    if (entry.resolvable) continue;
    if (entry.builtin) warns.push(`builtin-not-in-node_modules:${key}`);
    else fails.push(`patch-unresolved:${key}`);
  }
  const mockLaunch = Array.isArray(config.launch) && (config.launch.includes('--guardian-mock-client') || config.launch[0]?.endsWith('node.exe'));
  const skipClientAsarCheck = config.skipClientAsarCheck === true;
  if (!inventory.client.clientAsarExists && !mockLaunch && !skipClientAsarCheck) fails.push('client-asar-missing');
  if (!mockLaunch && !skipClientAsarCheck && inventory.client.clientVersion !== config.expectedClientVersion) {
    const message = `client-version-mismatch: expected ${config.expectedClientVersion}, actual ${inventory.client.clientVersion}`;
    if (allowMismatch) warns.push(message);
    else fails.push(message);
  }

  const report = {
    status: fails.length === 0 ? 'ok' : 'fail',
    profile: config.profile,
    entriesChecked: Object.keys(inventory.entries).length,
    clientVersion: inventory.client.clientVersion,
    clientAsarPath: inventory.client.clientAsarPath,
    fails,
    warns
  };
  return report;
}

function preflight(config, args) {
  const report = preflightReport(config, args);
  printJson(report);
  return report.status === 'ok' ? 0 : 2;
}

// ---------------------------------------------------------------- logging

function logFile() {
  const now = new Date();
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return path.join(ROOT, 'logs', `guardian-${day}.log`);
}

function log(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`;
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    fs.appendFileSync(logFile(), `${line}\n`, 'utf8');
  } catch { /* logging must never break a command */ }
  return line;
}

// ---------------------------------------------------------------- content-addressed store

const BACKUPS_DIR = path.join(ROOT, 'backups');
const STORE_DIR = path.join(BACKUPS_DIR, '_store');
const LKG_DIR = path.join(BACKUPS_DIR, 'last-known-good');

function blobPath(hash) { return path.join(STORE_DIR, hash.slice(0, 2), hash); }

function storeBlob(file, hash) {
  const target = blobPath(hash);
  if (fs.existsSync(target)) return { hash, stored: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(file, temp);
  fs.renameSync(temp, target);
  try { fs.chmodSync(target, 0o444); } catch { /* read-only best effort */ }
  return { hash, stored: true, size: fs.statSync(target).size };
}

function verifyBlob(hash, size) {
  const target = blobPath(hash);
  if (!fs.existsSync(target)) return { ok: false, reason: 'blob-missing' };
  const stat = fs.statSync(target);
  if (typeof size === 'number' && stat.size !== size) return { ok: false, reason: 'blob-size-mismatch' };
  if (sha256File(target) !== hash) return { ok: false, reason: 'blob-hash-mismatch' };
  return { ok: true };
}

function storeStats() {
  let bytes = 0;
  let blobs = 0;
  const stack = [STORE_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    let dirents = [];
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) { stack.push(full); continue; }
      if (dirent.name.includes('.tmp-')) continue;
      try { const stat = fs.statSync(full); bytes += stat.size; blobs += 1; } catch { /* ignore */ }
    }
  }
  return { bytes, blobs };
}

function sanitizeLabel(label) {
  return String(label).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'snapshot';
}

function snapshotMetaPath(snapshotDir) { return path.join(snapshotDir, 'meta.json'); }

function resolveSnapshot(label) {
  if (!label) return null;
  const direct = path.join(BACKUPS_DIR, sanitizeLabel(label));
  if (fs.existsSync(snapshotMetaPath(direct))) {
    return { dir: direct, meta: readJsonSafe(snapshotMetaPath(direct)) };
  }
  let dirents = [];
  try { dirents = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }); } catch { return null; }
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name === '_store' || dirent.name === 'disabled-entries') continue;
    const metaPath = snapshotMetaPath(path.join(BACKUPS_DIR, dirent.name));
    if (!fs.existsSync(metaPath)) continue;
    const meta = readJsonSafe(metaPath);
    if (!meta) continue;
    if (meta.label === label || dirent.name === label || dirent.name.startsWith(label)) {
      return { dir: path.join(BACKUPS_DIR, dirent.name), meta };
    }
  }
  return null;
}

function buildRoots(config) {
  const roots = new Map();
  const addRoot = (name, full) => {
    const stat = statSafe(full);
    if (!stat) return;
    roots.set(name, { path: full, kind: stat.isDirectory() ? 'dir' : 'file' });
  };
  addRoot('profile', config.profileDir);
  for (const tracked of config.dshHomeTrackedPaths || []) {
    if (tracked === '.credentials.yaml') continue;
    addRoot(`dshHome/${tracked}`, path.join(config.dshHome, tracked));
  }
  const profilePackage = readJsonSafe(path.join(config.profileDir, 'package.json'));
  for (const [name, spec] of Object.entries(profilePackage?.dependencies || {})) {
    const value = String(spec);
    if (value.startsWith('file:')) {
      addRoot(`file:${name}`, path.resolve(config.profileDir, value.slice('file:'.length)));
    } else if (value.startsWith('link:')) {
      const target = path.resolve(config.profileDir, value.slice('link:'.length));
      addRoot(`source:${toPosix(target)}`, target);
    }
  }
  let sharedIndex = 0;
  for (const sharedRoot of config.sharedDependencyRoots || []) {
    const rootName = sharedIndex === 0 ? 'shared' : `shared:${sharedIndex}`;
    addRoot(rootName, sharedRoot);
    sharedIndex += 1;
  }
  return roots;
}

function rootExcludes(config, rootName) {
  if (rootName === 'profile') return [];
  if (rootName.startsWith('file:') || rootName.startsWith('source:')) return config.sourceExclude || [];
  return [];
}

function isVolatileRel(config, rootName, rel) {
  if (rootName !== 'dshHome/storages') return false;
  return storageVolatilePrefixes(config).some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function linkKindOf(target) {
  return target && path.isAbsolute(target) ? 'junction' : 'symlink';
}

function walkForSnapshot(rootPath, exclude) {
  const nodes = walkTree(rootPath, { exclude, hash: true });
  const files = [];
  const links = [];
  const dirs = [];
  for (const node of nodes) {
    if (node.kind === 'file') files.push({ rel: node.rel, size: node.size, sha256: node.sha256 });
    else if (node.kind === 'link') links.push({ rel: node.rel, target: node.target, linkType: linkKindOf(node.target) });
    else dirs.push({ rel: node.rel });
  }
  return { files, links, dirs };
}

function createSnapshot(config, label, options = {}) {
  const startedAt = Date.now();
  const guardianState = loadState();
  const stop = options.noStop
    ? { stopped: true, released: true, pids: [], reason: 'skipped-no-start', graceful: false, forced: false, port: null, elapsedMs: 0 }
    : stopClientAndVerify(config, {
      state: guardianState,
      graceMs: options.graceMs,
      port: options.port,
      rootPid: options.rootPid
    });
  if (!stop.stopped || !stop.released) {
    log('ERROR', 'snapshot 拒绝：客户端未完全停止', { phase: 'snapshot-refused', label, stop });
    return { error: `snapshot-refused:${stop.reason}`, phase: 'snapshot-refused', stop };
  }
  const dirName = sanitizeLabel(options.dirName ?? label);
  const snapshotDir = path.join(BACKUPS_DIR, dirName);
  if (fs.existsSync(snapshotMetaPath(snapshotDir))) {
    return { error: `snapshot 已存在: ${dirName}` };
  }
  const storeBefore = storeStats();
  const inventory = discoverRuntimeClosure(config, { hash: true });
  const roots = buildRoots(config);
  const files = [];
  const links = [];
  const dirs = [];
  let storedBytes = 0;
  let storedBlobs = 0;
  for (const [rootName, root] of roots) {
    const rootPath = root.path;
    const walked = root.kind === 'file'
      ? { files: [{ rel: '', size: fs.statSync(rootPath).size, sha256: sha256File(rootPath) }], links: [], dirs: [] }
      : walkForSnapshot(rootPath, rootExcludes(config, rootName));
    for (const file of walked.files) {
      const full = file.rel ? path.join(rootPath, file.rel.split('/').join(path.sep)) : rootPath;
      const result = storeBlob(full, file.sha256);
      if (result.stored) { storedBlobs += 1; storedBytes += result.size ?? file.size; }
      files.push({ root: rootName, ...file });
    }
    for (const link of walked.links) links.push({ root: rootName, ...link });
    for (const dir of walked.dirs) dirs.push({ root: rootName, ...dir });
  }
  const preflight = preflightReport(config, []);
  const remainingPort = stop.port ? (listenersOnPort(stop.port).length > 0 ? stop.port : null) : null;
  const meta = {
    format: 5,
    mode: config.snapshotMode,
    storage: config.snapshotStorage,
    label,
    snapshotDir: toPosix(snapshotDir),
    createdAt: new Date().toISOString(),
    state: options.state ?? 'verified',
    profile: config.profile,
    profileDir: toPosix(config.profileDir),
    runtime: {
      nodeVersion: inventory.runtime.nodeVersion,
      pnpmVersion: inventory.runtime.pnpmVersion,
      clientVersion: inventory.runtime.clientVersion,
      clientAsarPath: inventory.runtime.clientAsarPath,
      clientAsarSha256: inventory.runtime.clientAsarSha256,
      platform: inventory.runtime.platform,
      arch: inventory.runtime.arch
    },
    digest: inventory.digest,
    entries: inventory.entries,
    roots: Object.fromEntries([...roots].map(([name, root]) => [name, { path: toPosix(root.path), kind: root.kind }])),
    files,
    links,
    dirs,
    externalDependencies: [],
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      links: links.length,
      dirs: dirs.length
    },
    health: {
      preflight: preflight.status === 'ok' ? 'ok' : 'fail',
      port: remainingPort,
      httpStatus: null,
      settledMs: stop.elapsedMs,
      safe: Boolean(guardianState.safe),
      probing: Boolean(guardianState.probing),
      restart: 'not-implemented-in-group2',
      clientStop: {
        stopped: stop.stopped,
        released: stop.released,
        pids: stop.pids,
        reason: stop.reason,
        graceful: stop.graceful,
        forced: stop.forced
      },
      durationMs: Date.now() - startedAt
    }
  };
  fs.mkdirSync(snapshotDir, { recursive: true });
  saveJson(snapshotMetaPath(snapshotDir), meta);
  const storeAfter = storeStats();
  return {
    dir: snapshotDir,
    meta,
    newBlobs: storedBlobs,
    newBytes: storedBytes,
    storeBytesBefore: storeBefore.bytes,
    storeBytesAfter: storeAfter.bytes
  };
}

function snapshotCommand(config, state, args) {
  const label = args.find((arg) => !arg.startsWith('--')) ?? `snapshot-${Date.now()}`;
  const result = createSnapshot(config, label);
  if (result.error) {
    log('ERROR', 'snapshot 失败', { label, error: result.error });
    console.error(result.error);
    return 2;
  }
  const summary = {
    status: 'snapshot-created',
    label,
    dir: toPosix(result.dir),
    digest: result.meta.digest,
    entries: Object.keys(result.meta.entries).length,
    files: result.meta.totals.files,
    links: result.meta.totals.links,
    dirs: result.meta.totals.dirs,
    newBlobs: result.newBlobs,
    newBytes: result.newBytes,
    storeBytesBefore: result.storeBytesBefore,
    storeBytesAfter: result.storeBytesAfter,
    clientStop: result.meta?.health?.clientStop ?? null
  };
  log('INFO', 'snapshot 完成', summary);
  printJson(summary);
  return 0;
}

function recover(state) {
  const active = state.activeOperation;
  if (!active) {
    console.log('没有未完成的 activeOperation，无需恢复。');
    return 0;
  }
  const actions = {
    prepared: '标记 aborted（尚未写入）',
    stopped: '标记 aborted（客户端已停止，尚未快照）',
    'before-snapshot-created': '标记 aborted（尚未开始安装）',
    snapshotting: '标记 aborted（快照未完成，现场未被改写）',
    installing: '将执行恢复：使用 before 快照恢复并重启验证',
    'closure-inventoried': '将执行恢复：先验证可启动性，否则恢复 before 快照',
    'preflight-passed': '将执行恢复：先验证可启动性，否则恢复 before 快照',
    starting: '将执行恢复：检查实例健康，否则恢复 before 快照',
    'restoring-before': '将执行恢复：幂等重做 before manifest 恢复',
    'restarting-before': '将执行恢复：重新启动验证',
    committed: '将补写 after-add 快照（骨架行为）'
  };
  console.log(`activeOperation.phase=${active.phase}`);
  console.log(actions[active.phase] ?? `将执行恢复：未知 phase ${active.phase}，保留现场并报告`);
  return 0;
}

// Read-only instance view (contract: exit 0 when an instance is running, 1 when not).
function psCommand(config, state) {
  const rootPid = Number(state?.instance?.rootPid ?? 0) || null;
  const descendants = rootPid && pidAlive(rootPid) ? [...descendantPids(rootPid)] : [];
  const tracked = [...new Set([rootPid, ...descendants].filter((pid) => Number.isInteger(pid) && pid > 0))];
  const clients = launchProcessIds(config);
  const listeners = tcpListeners();
  const known = new Set([...tracked, ...clients]);
  const listener = listeners.find((row) => known.has(row.pid)) ?? null;
  const running = clients.length > 0 || tracked.some((pid) => pidAlive(pid));
  printJson({
    rootPid: rootPid ?? null,
    descendantPids: descendants,
    trackedPids: tracked,
    clientPids: clients,
    port: listener ? listener.port : null,
    httpStatus: state?.instance?.httpStatus ?? null,
    owner: listener ? (clients.includes(listener.pid) ? 'desktop-client' : 'guardian-tracked') : 'none',
    healthy: Boolean(state?.instance?.healthy),
    running
  });
  return running ? 0 : 1;
}

function status(state) {
  printJson({
    version: state.version,
    activeOperation: state.activeOperation,
    safe: state.safe,
    culprit: state.culprit,
    instance: state.instance,
    drift: state.drift
  });
  return 0;
}

// ---------------------------------------------------------------- restore / list

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function assertOfflineMode() {
  const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const banned = new Set(['http', 'https', 'http2', 'net', 'tls', 'dns', 'dgram']);
  const specifiers = [];
  const importPattern = /(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) specifiers.push(match[1]);
  const hits = specifiers
    .map((spec) => spec.replace(/^node:/, ''))
    .filter((spec) => banned.has(spec) || spec.startsWith('dns/'));
  if (hits.length > 0) throw new Error(`restore 路径引用了网络模块: ${[...new Set(hits)].join(', ')}`);
  globalThis.fetch = () => { throw new Error('--assert-offline: 网络已禁用'); };
}

function validateSnapshotMeta(config, meta) {
  const problems = [];
  if (!meta || typeof meta !== 'object') { problems.push('meta-unreadable'); return problems; }
  if (meta.format !== 5) problems.push(`format-invalid:${meta.format}`);
  if (meta.mode !== 'exact') problems.push(`mode-invalid:${meta.mode}`);
  if (typeof meta.digest !== 'string' || !/^[0-9a-f]{64}$/.test(meta.digest)) problems.push('digest-invalid');
  if (!Array.isArray(meta.files)) problems.push('files-missing');
  if (!Array.isArray(meta.links)) problems.push('links-missing');
  if (problems.length > 0) return problems;
  const seen = new Set();
  for (const file of meta.files) {
    if (!file || !file.root || typeof file.rel !== 'string' || typeof file.sha256 !== 'string') { problems.push(`file-entry-invalid:${file?.rel ?? '?'}`); continue; }
    const key = `${file.root}/${file.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const check = verifyBlob(file.sha256, file.size);
    if (!check.ok) problems.push(`${check.reason}:${file.sha256.slice(0, 12)}:${key}`);
    if (problems.length >= 20) break;
  }
  return problems;
}

function resolveLinkTarget(linkPath, target) {
  if (path.isAbsolute(target)) return target;
  return path.resolve(path.dirname(linkPath), target);
}

function createVerifiedLink(linkPath, target, linkType) {
  const mode = linkType === 'junction' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(target, linkPath, mode);
  } catch {
    fs.symlinkSync(target, linkPath, 'junction');
  }
  const readBack = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), readBack);
  if (resolved.toLowerCase() !== path.resolve(target).toLowerCase()) {
    throw new Error(`link target mismatch: ${linkPath} -> ${readBack}`);
  }
}

function rootMayDelete(rootName) {
  if (rootName === 'profile') return true;
  if (rootName.startsWith('dshHome/')) return true;
  if (rootName === 'shared' || rootName.startsWith('shared:')) return true;
  return false;
}

function sharedOwnersByRel(meta) {
  const map = new Map();
  for (const [key, entry] of Object.entries(meta?.entries || {})) {
    if (!key.startsWith('shared/')) continue;
    const rel = key.slice('shared/'.length);
    if (Array.isArray(entry?.owners)) map.set(rel, entry.owners);
  }
  return map;
}

function sharedRelOwnerKey(rel) {
  const segments = String(rel).split('/');
  if (segments[0] && segments[0].startsWith('@') && segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  return segments[0] || '';
}

function sharedOwnedSolelyByThisProfile(rel, ownerMap, profile) {
  const owners = ownerMap.get(sharedRelOwnerKey(rel)) ?? ['unowned'];
  return !owners.some((owner) => owner !== 'unowned' && owner !== profile);
}

function logSharedDelete(kind, rel, rootPath, node, owners, profile) {
  const full = path.join(rootPath, rel.split('/').join(path.sep));
  log('INFO', 'shared 条目删除', {
    rel,
    kind,
    path: toPosix(full),
    size: node?.size ?? null,
    sha256: node?.sha256 ?? null,
    owners,
    profile,
    basis: 'owners ∩ (profiles\\{thisProfile}) = ∅ 且 path ∉ before'
  });
}

function restoreMaterialize(config, meta, options) {
  const stats = { written: 0, deleted: 0, linksCreated: 0, skipped: 0, skippedVolatile: 0, skippedKeep: 0, skippedOwned: 0 };
  const rawRoots = meta.roots || {};
  const roots = {};
  for (const [name, value] of Object.entries(rawRoots)) {
    roots[name] = typeof value === 'string'
      ? { path: value, kind: 'dir' }
      : { path: value.path, kind: value.kind ?? 'dir' };
  }
  const byRoot = new Map();
  for (const rootName of Object.keys(roots)) byRoot.set(rootName, { files: new Map(), links: new Map(), dirs: new Set() });
  for (const file of meta.files) byRoot.get(file.root)?.files.set(file.rel, file);
  for (const link of meta.links) byRoot.get(link.root)?.links.set(link.rel, link);
  for (const dir of meta.dirs) byRoot.get(dir.root)?.dirs.add(dir.rel);

  const sharedOwners = sharedOwnersByRel(meta);

  for (const [rootName, target] of byRoot) {
    const rootPath = String(roots[rootName].path).split('/').join(path.sep);
    if (roots[rootName].kind === 'file') {
      const only = [...target.files.values()][0];
      if (!only) continue;
      const stat = statSafe(rootPath);
      let same = false;
      if (stat && !stat.isDirectory() && !stat.isSymbolicLink() && stat.size === only.size) {
        same = sha256File(rootPath) === only.sha256;
      }
      if (same) { stats.skipped += 1; continue; }
      if (stat && stat.isDirectory()) fs.rmSync(rootPath, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(rootPath), { recursive: true });
      const temp = `${rootPath}.guardian-tmp-${process.pid}`;
      fs.copyFileSync(blobPath(only.sha256), temp);
      try { fs.chmodSync(temp, 0o666); } catch { /* clear inherited read-only */ }
      fs.renameSync(temp, rootPath);
      stats.written += 1;
      continue;
    }
    fs.mkdirSync(rootPath, { recursive: true });
    const exclude = rootExcludes(config, rootName);
    const current = walkTree(rootPath, { exclude, hash: true });
    const currentFiles = new Map();
    const currentLinks = new Map();
    const currentDirs = new Set();
    for (const node of current) {
      if (node.kind === 'file') currentFiles.set(node.rel, node);
      else if (node.kind === 'link') currentLinks.set(node.rel, node);
      else currentDirs.add(node.rel);
    }
    const skipPath = (rel) => !options.includeVolatile && isVolatileRel(config, rootName, rel);
    const canDelete = rootMayDelete(rootName);
    const isSharedRoot = rootName === 'shared' || rootName.startsWith('shared:');

    for (const [rel, node] of currentFiles) {
      if (target.files.has(rel)) continue;
      if (skipPath(rel)) { stats.skippedVolatile += 1; continue; }
      if (!canDelete) { stats.skippedKeep += 1; continue; }
      if (isSharedRoot && !sharedOwnedSolelyByThisProfile(rel, sharedOwners, config.profile)) { stats.skippedOwned += 1; continue; }
      if (isSharedRoot) logSharedDelete('file', rel, rootPath, node, sharedOwners.get(sharedRelOwnerKey(rel)) ?? ['unowned'], config.profile);
      fs.rmSync(path.join(rootPath, rel.split('/').join(path.sep)), { force: true });
      stats.deleted += 1;
    }
    for (const rel of currentLinks.keys()) {
      if (target.links.has(rel)) continue;
      if (skipPath(rel)) { stats.skippedVolatile += 1; continue; }
      if (!canDelete) { stats.skippedKeep += 1; continue; }
      if (isSharedRoot && !sharedOwnedSolelyByThisProfile(rel, sharedOwners, config.profile)) { stats.skippedOwned += 1; continue; }
      if (isSharedRoot) logSharedDelete('link', rel, rootPath, currentLinks.get(rel), sharedOwners.get(sharedRelOwnerKey(rel)) ?? ['unowned'], config.profile);
      try { fs.unlinkSync(path.join(rootPath, rel.split('/').join(path.sep))); } catch { /* ignore */ }
      stats.deleted += 1;
    }

    for (const rel of [...target.dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const full = path.join(rootPath, rel.split('/').join(path.sep));
      const stat = statSafe(full);
      if (stat && !stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      fs.mkdirSync(full, { recursive: true });
    }

    for (const [rel, file] of target.files) {
      if (skipPath(rel)) { stats.skippedVolatile += 1; continue; }
      const full = path.join(rootPath, rel.split('/').join(path.sep));
      const live = currentFiles.get(rel);
      if (live && live.size === file.size && live.sha256 === file.sha256 && fs.existsSync(full)) { stats.skipped += 1; continue; }
      const stat = statSafe(full);
      if (stat && (stat.isDirectory() || stat.isSymbolicLink())) fs.rmSync(full, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const temp = `${full}.guardian-tmp-${process.pid}`;
      fs.copyFileSync(blobPath(file.sha256), temp);
      try { fs.chmodSync(temp, 0o666); } catch { /* clear inherited read-only */ }
      fs.renameSync(temp, full);
      stats.written += 1;
    }

    for (const [rel, link] of target.links) {
      const full = path.join(rootPath, rel.split('/').join(path.sep));
      const stat = statSafe(full);
      const resolvedTarget = resolveLinkTarget(full, link.target);
      let same = false;
      if (stat && stat.isSymbolicLink()) {
        try {
          const readBack = fs.readlinkSync(full);
          same = toPosix(readBack) === toPosix(link.target)
            || path.resolve(path.dirname(full), readBack).toLowerCase() === path.resolve(resolvedTarget).toLowerCase();
        } catch { same = false; }
      }
      if (same) continue;
      if (stat) fs.rmSync(full, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      createVerifiedLink(full, resolvedTarget, link.linkType);
      stats.linksCreated += 1;
    }

    const extraDirs = [...currentDirs]
      .filter((rel) => !target.dirs.has(rel) && !target.files.has(rel) && !target.links.has(rel))
      .sort((a, b) => b.split('/').length - a.split('/').length);
    for (const rel of extraDirs) {
      if (skipPath(rel)) continue;
      if (!canDelete) { stats.skippedKeep += 1; continue; }
      if (isSharedRoot && !sharedOwnedSolelyByThisProfile(rel, sharedOwners, config.profile)) { stats.skippedOwned += 1; continue; }
      if (isSharedRoot) logSharedDelete('dir', rel, rootPath, null, sharedOwners.get(sharedRelOwnerKey(rel)) ?? ['unowned'], config.profile);
      try { fs.rmdirSync(path.join(rootPath, rel.split('/').join(path.sep))); stats.deleted += 1; } catch { /* not empty */ }
    }
  }
  return stats;
}

function diffEntries(expected, actual, limit = 20) {
  const changes = [];
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  for (const key of [...keys].sort()) {
    if (canon(expected?.[key]) === canon(actual?.[key])) continue;
    changes.push({ key, expected: expected?.[key] ?? null, actual: actual?.[key] ?? null });
    if (changes.length >= limit) break;
  }
  return changes;
}

// ---------------------------------------------------------------- stop & verify

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function normalizeExePath(value) {
  if (!value) return null;
  try { return path.resolve(String(value)).replace(/\//g, '\\').toLowerCase(); } catch { return null; }
}

/** 只读进程表（PID / 父 PID / 可执行路径），供精确匹配与展示使用，不参与任何终止决策。 */
function processTable() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress'
    ], { timeout: 20000 }).toString();
    const list = JSON.parse(out);
    return (Array.isArray(list) ? list : [list]).map((item) => ({
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId),
      exe: item.ExecutablePath ? String(item.ExecutablePath) : null
    }));
  } catch {
    return [];
  }
}

/**
 * 仅返回“可执行文件路径与 config.launch 完全一致”的进程。
 * 绝不按镜像名匹配，避免误杀同名但不同路径的客户端。
 */
function launchProcessIds(config) {
  const targets = new Set(
    (Array.isArray(config?.launch) ? config.launch : [])
      .map(normalizeExePath)
      .filter(Boolean)
  );
  if (targets.size === 0) return [];
  return processTable()
    .filter((row) => row.exe && targets.has(normalizeExePath(row.exe)))
    .map((row) => row.pid)
    .filter(pidAlive);
}

/** 只读探测当前正在运行的客户端实例（不启动、不停止、不杀进程）。 */
function detectRunningInstance(config) {
  const pids = launchProcessIds(config);
  if (pids.length === 0) return null;
  const table = processTable();
  const pset = new Set(pids);
  const tops = pids.filter((pid) => {
    const row = table.find((item) => item.pid === pid);
    return !row || !pset.has(row.ppid);
  });
  const candidates = tops.length > 0 ? tops : pids;
  for (const pid of candidates) {
    const port = findListeningPort(pid);
    if (!port) continue;
    const httpStatus = httpProbe(port);
    return {
      rootPid: pid,
      descendantPids: [...descendantPids(pid)],
      port,
      httpStatus,
      healthy: httpStatus !== null
    };
  }
  const pid = candidates[0];
  return {
    rootPid: pid,
    descendantPids: [...descendantPids(pid)],
    port: null,
    httpStatus: null,
    healthy: false
  };
}

/** 只检查指定端口（不扫描/推断端口），用于验证释放。 */
function listenersOnPort(port) {
  const target = Number(port);
  if (!Number.isInteger(target) || target <= 0) return [];
  let out = '';
  try { out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { timeout: 20000 }).toString(); } catch { return []; }
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (match && Number(match[1]) === target) rows.push({ port: target, pid: Number(match[2]) });
  }
  return rows;
}

function tcpListeners() {
  const rows = [];
  let out = '';
  try { out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { timeout: 20000 }).toString(); } catch { return rows; }
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (match) rows.push({ port: Number(match[1]), pid: Number(match[2]) });
  }
  return rows;
}

// Invariant 2: never snapshot or restore over a live client. Graceful close first,
// then force the tree, then prove both the process tree and the port are gone.
//
// 安全边界（2026-10 修复）：
//   · 只允许操作 state.instance.rootPid（及其后代）与 config.launch 精确路径匹配到的进程；
//   · 不允许按镜像名匹配（如 "DeepSeek Harness"），也不允许通过全局端口扫描发现目标；
//   · rootPid 为空且 config.launch 进程不在运行时，直接返回“已停止/已释放”，不做任何清理。
function stopClientAndVerify(config, options = {}) {
  const startedAt = Date.now();
  const result = { stopped: false, released: false, pids: [], reason: 'unknown', port: null, graceful: false, forced: false, elapsedMs: 0 };
  try {
    const state = options.state ?? loadState();
    const graceMs = Math.max(0, Number(options.graceMs ?? config.killGraceMs ?? 5000) || 0);
    const configuredPort = Number(config.port ?? 0) || 0;
    const declaredPort = Number(options.port ?? state?.instance?.port ?? (configuredPort > 0 ? configuredPort : 0)) || null;
    const declaredRoot = Number(options.rootPid ?? state?.instance?.rootPid ?? 0) || null;

    const tracked = new Set();
    if (declaredRoot && pidAlive(declaredRoot)) {
      tracked.add(declaredRoot);
      for (const child of descendantPids(declaredRoot)) if (pidAlive(child)) tracked.add(child);
    }
    for (const pid of launchProcessIds(config)) {
      if (!pidAlive(pid)) continue;
      tracked.add(pid);
      for (const child of descendantPids(pid)) if (pidAlive(child)) tracked.add(child);
    }

    result.port = declaredPort;
    result.pids = [...tracked];

    // 没有任何“被明确声明”的进程：不杀、不扫描端口，直接视为已停止。
    if (tracked.size === 0) {
      result.stopped = true;
      result.released = true;
      result.reason = 'no-tracked-instance';
      result.elapsedMs = Date.now() - startedAt;
      return result;
    }

    const gracefulTarget = declaredRoot && tracked.has(declaredRoot) ? declaredRoot : [...tracked][0];
    if (pidAlive(gracefulTarget)) {
      try {
        execFileSync('taskkill', ['/PID', String(gracefulTarget)], { timeout: 15000, stdio: 'ignore' });
        result.graceful = true;
      } catch { result.graceful = false; }
    }

    const survivors = () => [...tracked].filter(pidAlive);
    const graceDeadline = Date.now() + graceMs;
    while (Date.now() < graceDeadline && survivors().length > 0) sleep(250);

    if (survivors().length > 0) {
      for (const pid of survivors()) {
        // 只结束 tracked 集合中的 PID；不再使用 /T 扩大到未声明进程。
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 20000, stdio: 'ignore' });
          result.forced = true;
        } catch { /* already gone */ }
      }
      const forceDeadline = Date.now() + 10000;
      while (Date.now() < forceDeadline && survivors().length > 0) sleep(250);
    }

    result.stopped = survivors().length === 0;

    // 仅核对 state/config 声明的端口，且只看它是否仍被 tracked 进程占用；不扫描、不推断、不处理未知端口。
    if (declaredPort) {
      const owners = listenersOnPort(declaredPort);
      const ours = owners.filter((row) => tracked.has(row.pid));
      result.released = result.stopped && ours.length === 0;
      result.reason = result.stopped
        ? (ours.length === 0 ? 'stopped-and-released' : 'port-held-by-tracked')
        : 'process-alive';
    } else {
      result.released = result.stopped;
      result.reason = result.stopped ? 'stopped-and-released' : 'process-alive';
    }
    result.elapsedMs = Date.now() - startedAt;
    return result;
  } catch (error) {
    result.reason = `exception:${error?.message ?? error}`;
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }
}

function descendantPids(rootPid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
    ], { timeout: 20000 }).toString();
    const list = JSON.parse(out);
    const parents = new Map();
    for (const item of Array.isArray(list) ? list : [list]) parents.set(item.ProcessId, item.ParentProcessId);
    const result = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of parents) {
        if (!result.has(pid) && result.has(ppid)) { result.add(pid); changed = true; }
      }
    }
    return result;
  } catch {
    return new Set([rootPid]);
  }
}

function findListeningPort(rootPid) {
  const pids = descendantPids(rootPid);
  let out = '';
  try { out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { timeout: 20000 }).toString(); } catch { return null; }
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (match && pids.has(Number(match[2]))) return Number(match[1]);
  }
  return null;
}

function httpProbe(port) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `try { (Invoke-WebRequest -Uri 'http://127.0.0.1:${port}/' -UseBasicParsing -TimeoutSec 5).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }`
    ], { timeout: 20000 }).toString().trim();
    const code = Number(out);
    return Number.isFinite(code) && code > 0 ? code : null;
  } catch {
    return null;
  }
}

function startClient(config) {
  const launch = Array.isArray(config.launch) ? config.launch : [];
  const exe = launch[0];
  const launchArgs = launch.slice(1);
  if (!exe || !exists(exe)) return { restart: 'launch-missing', pid: null, port: null, httpStatus: null, stable: false, reason: 'launch-missing' };
  let child;
  try {
    child = spawn(exe, launchArgs, { detached: true, stdio: 'ignore', windowsHide: true });
  } catch (error) {
    log('ERROR', '启动客户端失败：spawn 同步抛错', { code: error?.code ?? null, message: String(error?.message ?? error) });
    return { restart: 'spawn-error', pid: null, port: null, httpStatus: null, stable: false, reason: 'spawn-threw', code: error?.code ?? null };
  }
  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error;
    log('ERROR', '启动客户端失败：spawn error 事件', { code: error?.code ?? null, message: String(error?.message ?? error) });
  });
  try { child.unref(); } catch { /* ignore */ }
  if (!child.pid) {
    log('ERROR', '启动客户端失败：spawn 后无 pid', { code: spawnError?.code ?? null });
    return { restart: 'spawn-error', pid: null, port: null, httpStatus: null, stable: false, reason: 'no-pid', code: spawnError?.code ?? null };
  }
  const rootPid = child.pid;
  const deadline = Date.now() + Number(config.startTimeoutMs ?? 90000);
  const settleMs = Number(config.settleMs ?? 15000);
  let port = null;
  let httpStatus = null;
  let firstHealthyAt = 0;
  let lastPort = null;
  while (rootPid && Date.now() < deadline) {
    if (spawnError) {
      log('ERROR', '启动客户端失败：轮询中捕获 spawn error', { code: spawnError.code ?? null });
      return { restart: 'spawn-error', pid: rootPid, port, httpStatus, stable: false, reason: 'spawn-error', code: spawnError.code ?? null };
    }
    const currentPort = findListeningPort(rootPid);
    const currentHttp = currentPort ? httpProbe(currentPort) : null;
    if (currentPort && currentHttp !== null) {
      if (!firstHealthyAt || currentPort !== lastPort) firstHealthyAt = Date.now();
      lastPort = currentPort;
      port = currentPort;
      httpStatus = currentHttp;
      if (Date.now() - firstHealthyAt >= settleMs) {
        return { restart: 'started', pid: rootPid, port, httpStatus, stable: true, settledMs: Date.now() - firstHealthyAt };
      }
    } else {
      firstHealthyAt = 0;
      lastPort = null;
    }
    sleep(500);
  }
  const cleanup = stopClientAndVerify(config, { rootPid, port, state: loadState() });
  log('WARN', '启动超时，已清理残留进程', { rootPid, port, cleanup });
  return { restart: 'timeout', pid: rootPid, port, httpStatus, stable: false, reason: 'timeout', cleanup };
}

// 分根闭包校验：managed 根 entries 严格相等；source:/file:/link: 根允许超集，
// 但快照内的文件必须仍存在且哈希一致。全局 digest 仍写入 meta.json，但不作为通过条件。
function verifyRestoreClosure(config, meta, after) {
  const entryLine = (entry) => {
    if (entry && entry.kind === 'directory' && entry.stableListingSha256) {
      const payload = { ...entry, files: entry.stableFiles, bytes: entry.stableBytes, listingSha256: entry.stableListingSha256 };
      delete payload.stableListingSha256;
      delete payload.stableFiles;
      delete payload.stableBytes;
      delete payload.volatileFiles;
      return canon(payload);
    }
    return canon(entry);
  };
  const externalEntry = (key) => key.startsWith('source:') || key.startsWith('file:') || key.startsWith('link:');
  const changes = [];

  for (const [key, expected] of Object.entries(meta.entries || {})) {
    if (externalEntry(key)) continue;
    if (expected?.digestExcluded) continue;
    const actual = after.entries?.[key];
    if (entryLine(expected) !== entryLine(actual)) changes.push({ key, expected: expected ?? null, actual: actual ?? null });
  }
  for (const key of Object.keys(after.entries || {})) {
    if (externalEntry(key)) continue;
    if (after.entries[key]?.digestExcluded) continue;
    if (!Object.prototype.hasOwnProperty.call(meta.entries || {}, key)) changes.push({ key, expected: null, actual: after.entries[key] });
  }

  const sourceRoots = new Set(Object.keys(meta.roots || {}).filter((name) => name.startsWith('source:') || name.startsWith('file:')));
  for (const file of meta.files || []) {
    if (!sourceRoots.has(file.root)) continue;
    const rootPath = (meta.roots[file.root]?.path ?? '').split('/').join(path.sep);
    const full = file.rel ? path.join(rootPath, file.rel.split('/').join(path.sep)) : rootPath;
    const stat = statSafe(full);
    if (!stat || stat.isDirectory() || stat.isSymbolicLink()) { changes.push({ key: `${file.root}/${file.rel}`, reason: 'source-file-missing-or-wrong-kind' }); continue; }
    if (sha256File(full) !== file.sha256) changes.push({ key: `${file.root}/${file.rel}`, reason: 'source-file-hash-mismatch' });
  }

  return { ok: changes.length === 0, changes: changes.slice(0, 20) };
}

function restoreCommand(config, state, args) {
  const startedAt = Date.now();
  const label = args.find((arg) => !arg.startsWith('--'));
  const options = {
    noStop: args.includes('--no-stop'),
    noRestart: args.includes('--no-restart'),
    includeVolatile: args.includes('--include-volatile'),
    assertOffline: args.includes('--assert-offline')
  };
  log('INFO', 'restore 开始', { label, ...options });
  if (options.assertOffline) {
    try { assertOfflineMode(); }
    catch (error) { log('ERROR', 'restore 拒绝：离线断言失败', { error: error.message }); console.error(error.message); return 3; }
  }
  const snap = resolveSnapshot(label);
  if (!snap || !snap.meta) {
    log('ERROR', 'snapshot 不存在', { label });
    printJson({ status: 'not-found', label });
    return 2;
  }
  const meta = snap.meta;

  const problems = validateSnapshotMeta(config, meta);
  if (problems.length > 0) {
    log('ERROR', 'restore 拒绝：manifest/blob 校验失败', problems.slice(0, 10));
    printJson({ status: 'rejected', stage: 'validate', problems, preRestore: null });
    return 3;
  }

  const client = resolveClientFingerprint(config, { hash: true });
  if (client.clientAsarSha256 !== meta.runtime?.clientAsarSha256 && config.blockOnClientMismatch) {
    log('ERROR', 'restore 拒绝：客户端 asar 哈希不符', {
      expected: meta.runtime?.clientAsarSha256, actual: client.clientAsarSha256
    });
    printJson({
      status: 'rejected',
      stage: 'client-mismatch',
      expected: meta.runtime?.clientAsarSha256,
      actual: client.clientAsarSha256
    });
    return 3;
  }

  const stop = options.noStop
    ? { stopped: true, released: true, reason: 'skipped-by-flag', pids: [], elapsedMs: 0 }
    : stopClientAndVerify(config, { state });
  if (!stop.stopped || !stop.released) {
    log('ERROR', 'restore 拒绝：客户端未完全停止', { stage: 'client-stop', stop });
    printJson({ status: 'restore-failed', stage: 'client-stop', stop, preRestore: null });
    return 3;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const preRestore = createSnapshot(config, `pre-restore-${stamp}`, {
    dirName: `pre-restore-${stamp}`,
    state: 'pre-restore'
  });
  if (preRestore.error) {
    log('ERROR', 'pre-restore 快照创建失败', { error: preRestore.error });
    printJson({ status: 'restore-failed', stage: 'pre-restore', error: preRestore.error });
    return 2;
  }

  let materialized;
  try {
    materialized = restoreMaterialize(config, meta, options);
  } catch (error) {
    log('ERROR', 'restore 物化失败', { error: error.message });
    printJson({ status: 'restore-failed', stage: 'materialize', error: error.message, preRestore: toPosix(preRestore.dir) });
    return 3;
  }

  const after = discoverRuntimeClosure(config, { hash: true });
  const verify = verifyRestoreClosure(config, meta, after);
  if (!verify.ok) {
    log('ERROR', 'restore 校验失败：闭包不一致（分根）', { changes: verify.changes });
    printJson({
      status: 'restore-failed',
      stage: 'closure',
      expectedDigest: meta.digest,
      actualDigest: after.digest,
      changes: verify.changes,
      preRestore: toPosix(preRestore.dir)
    });
    return 3;
  }

  const report = preflightReport(config, []);
  if (report.status !== 'ok') {
    log('ERROR', 'restore 校验失败：offline preflight', report.fails);
    printJson({ status: 'restore-failed', stage: 'preflight', report, preRestore: toPosix(preRestore.dir) });
    return 3;
  }

  const health = options.noRestart ? { restart: 'skipped' } : startClient(config);
  const restartFailed = !options.noRestart && ['timeout', 'spawn-error', 'launch-missing'].includes(health.restart);
  const summary = {
    status: restartFailed ? 'restored-restart-failed' : 'restored',
    label,
    dir: toPosix(snap.dir),
    digest: after.digest,
    preRestore: toPosix(preRestore.dir),
    preRestoreNewBytes: preRestore.newBytes,
    stop,
    materialized,
    health,
    restartFailed,
    durationMs: Date.now() - startedAt
  };
  log('INFO', restartFailed ? 'restore 完成但重启失败' : 'restore 完成', summary);
  printJson(summary);
  return restartFailed ? 2 : 0;
}

function listCommand(config) {
  const lkgMeta = readJsonSafe(path.join(LKG_DIR, 'meta.json'));
  const snapshots = [];
  let dirents = [];
  try { dirents = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }); } catch { dirents = []; }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name === '_store' || dirent.name === 'disabled-entries') continue;
    const metaPath = snapshotMetaPath(path.join(BACKUPS_DIR, dirent.name));
    if (!fs.existsSync(metaPath)) continue;
    const meta = readJsonSafe(metaPath);
    if (!meta) continue;
    snapshots.push({
      label: meta.label,
      dir: dirent.name,
      createdAt: meta.createdAt,
      state: meta.state,
      mode: meta.mode,
      digest: meta.digest,
      files: meta.totals?.files ?? meta.files?.length ?? null,
      links: meta.totals?.links ?? meta.links?.length ?? null,
      bytes: meta.totals?.bytes ?? null,
      lkg: Boolean(lkgMeta && lkgMeta.digest === meta.digest)
    });
  }
  snapshots.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const transactions = [];
  try {
    for (const entry of fs.readdirSync(path.join(ROOT, 'transactions'))) {
      if (!entry.endsWith('.json')) continue;
      const tx = readJsonSafe(path.join(ROOT, 'transactions', entry));
      if (tx) transactions.push({ id: entry.replace(/\.json$/, ''), state: tx.state ?? null, op: tx.op ?? null, createdAt: tx.createdAt ?? null });
    }
  } catch { /* no transactions yet */ }
  printJson({
    profile: config.profile,
    store: { dir: toPosix(STORE_DIR), ...storeStats() },
    lkg: lkgMeta ? { label: lkgMeta.label, digest: lkgMeta.digest } : null,
    snapshots,
    transactions
  });
  return 0;
}

// ---------------------------------------------------------------- prune（快照保留 + _store 物理回收）

// 事务进入这些状态后不再需要它的 before/after 快照作为回滚依据。
const TERMINAL_TX_STATES = new Set(['committed', 'rolled-back', 'aborted', 'restore-verified', 'rollback-failed', 'failed']);

function directoryBytes(dir) {
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

/** backups/ 下所有快照目录（含 last-known-good），排除 _store 与 disabled-entries。 */
function scanSnapshotDirs() {
  const rows = [];
  let dirents = [];
  try { dirents = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }); } catch { return rows; }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name === '_store' || dirent.name === 'disabled-entries') continue;
    const dir = path.join(BACKUPS_DIR, dirent.name);
    const meta = readJsonSafe(snapshotMetaPath(dir));
    rows.push({ name: dirent.name, dir, meta, createdAt: meta?.createdAt ?? '', bytes: directoryBytes(dir) });
  }
  return rows;
}

/** 未完成事务引用的快照目录名（basename），必须保留。 */
function heldSnapshotNames() {
  const held = new Set();
  const dir = path.join(ROOT, 'transactions');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return held; }
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('drift-')) continue;
    const tx = readJsonSafe(path.join(dir, entry));
    if (!tx) continue;
    const phase = String(tx.state ?? tx.phase ?? '');
    if (TERMINAL_TX_STATES.has(phase)) continue;
    for (const ref of [tx.before, tx.after]) {
      if (typeof ref === 'string' && ref) held.add(path.basename(String(ref).replace(/\\/g, '/')));
    }
  }
  return held;
}

/** meta 中所有被引用的 blob 哈希（files[].sha256 + entries.*.sha256）。 */
function collectBlobRefs(meta, refs) {
  if (!meta) return refs;
  for (const file of meta.files ?? []) {
    if (file && typeof file.sha256 === 'string') refs.add(file.sha256);
  }
  for (const entry of Object.values(meta.entries ?? {})) {
    if (entry && typeof entry.sha256 === 'string') refs.add(entry.sha256);
  }
  return refs;
}

/** _store 下所有 blob 文件（排除 .tmp- 残片）。 */
function listStoreBlobs() {
  const blobs = [];
  let shards = [];
  try { shards = fs.readdirSync(STORE_DIR, { withFileTypes: true }); } catch { return blobs; }
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(STORE_DIR, shard.name);
    let files = [];
    try { files = fs.readdirSync(shardDir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || file.name.includes('.tmp-')) continue;
      const full = path.join(shardDir, file.name);
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      blobs.push({ full, hash: file.name, shard: shardDir, size });
    }
  }
  return blobs;
}

function removeReadonly(file) {
  try { fs.chmodSync(file, 0o666); } catch { /* 只读位可能已不存在 */ }
  fs.unlinkSync(file);
}

function pruneCommand(config, state, args) {
  const dryRun = args.includes('--dry-run');
  const strict = args.includes('--strict');
  const keepTransactions = Number.isFinite(Number(config.keepTransactions)) ? Number(config.keepTransactions) : 20;
  const keepLkgCount = Number.isFinite(Number(config.keepLkg)) ? Number(config.keepLkg) : 3;
  const keepArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--keep' && args[index + 1]) keepArgs.push(String(args[index + 1]));
  }
  // --strict 时忽略配置保护名单，严格按保留规则执行。
  const keepList = new Set(strict ? keepArgs : [...(config.pruneKeepLabels || []).map(String), ...keepArgs]);

  const rows = scanSnapshotDirs();
  if (rows.length === 0) {
    printJson({ status: 'nothing-to-prune', reason: 'no-snapshot-dirs', keepTransactions, keepLkg: keepLkgCount });
    return 0;
  }
  const byNewest = [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const lkgMeta = readJsonSafe(path.join(LKG_DIR, 'meta.json'));

  const keep = new Map(); // name -> reason
  const keepRow = (row, reason) => { if (!keep.has(row.name)) keep.set(row.name, reason); };

  // 1) 永不清理：last-known-good / manual-baseline-*
  for (const row of rows) {
    if (row.name === 'last-known-good') keepRow(row, 'last-known-good');
    else if (/^manual-baseline-/.test(row.name)) keepRow(row, 'manual-baseline');
    else if (!row.meta) keepRow(row, 'meta-unreadable'); // 读不懂的目录不删，交人工
  }
  // 2) 最新 keepLkg 个 adopted-*
  byNewest.filter((row) => /^adopted-/.test(row.name) && !keep.has(row.name))
    .slice(0, keepLkgCount)
    .forEach((row) => keepRow(row, `adopted-最新${keepLkgCount}`));
  // 3) 最新 keepTransactions 个 before/after-add-*
  byNewest.filter((row) => /^(before|after)-add-/.test(row.name) && !keep.has(row.name))
    .slice(0, keepTransactions)
    .forEach((row) => keepRow(row, `tx-最新${keepTransactions}`));
  // 4) 安全持有：未完成事务引用的快照
  const held = heldSnapshotNames();
  for (const row of rows) if (held.has(row.name)) keepRow(row, 'unfinished-transaction');
  // 5) 显式保护名单（config.pruneKeepLabels 或 --keep）
  for (const row of rows) if (keepList.has(row.name)) keepRow(row, 'keep-list');

  const doomed = rows.filter((row) => !keep.has(row.name));
  const keptRows = rows.filter((row) => keep.has(row.name));

  const snapshotBytesBefore = rows.reduce((sum, row) => sum + row.bytes, 0);
  const doomedBytes = doomed.reduce((sum, row) => sum + row.bytes, 0);
  const storeBefore = storeStats();

  // blob 引用集：只由保留下来的 meta.json 构成
  const refs = new Set();
  for (const row of keptRows) collectBlobRefs(row.meta, refs);

  const blobs = listStoreBlobs();
  const orphans = refs.size === 0 && blobs.length > 0 ? [] : blobs.filter((blob) => !refs.has(blob.hash));
  const orphanBytes = orphans.reduce((sum, blob) => sum + blob.size, 0);

  const errors = [];
  if (!dryRun) {
    for (const row of doomed) {
      try { fs.rmSync(row.dir, { recursive: true, force: true }); }
      catch (error) { errors.push(`snapshot-delete-failed:${row.name}:${error.message}`); }
    }
    for (const blob of orphans) {
      try { removeReadonly(blob.full); }
      catch (error) { errors.push(`blob-delete-failed:${blob.hash}:${error.message}`); }
    }
    // 回收空的 2 位分片目录
    try {
      for (const shard of fs.readdirSync(STORE_DIR, { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        const shardDir = path.join(STORE_DIR, shard.name);
        try { if (fs.readdirSync(shardDir).length === 0) fs.rmdirSync(shardDir); } catch { /* ignore */ }
      }
    } catch { /* store 不存在即无需清理 */ }
  }

  const storeAfter = storeStats();
  const snapshotBytesAfter = dryRun ? snapshotBytesBefore : directoryBytes(BACKUPS_DIR) - storeAfter.bytes;
  const freedTotal = (dryRun ? 0 : doomedBytes) + (dryRun ? 0 : orphanBytes);
  const report = {
    status: dryRun ? 'dry-run' : 'pruned',
    strict,
    dryRun,
    policy: {
      keep: ['last-known-good', 'manual-baseline-*', `adopted-* 最新 ${keepLkgCount} 个`, `before/after-add-* 最新 ${keepTransactions} 个`, '未完成事务引用的快照'],
      keepList: [...keepList]
    },
    kept: keptRows.map((row) => ({ dir: row.name, reason: keep.get(row.name), createdAt: row.createdAt, mb: Number((row.bytes / 1048576).toFixed(2)) })),
    deleted: doomed.map((row) => ({ dir: row.name, createdAt: row.createdAt, mb: Number((row.bytes / 1048576).toFixed(2)) })),
    store: {
      blobsBefore: storeBefore.blobs,
      orphansFound: orphans.length,
      blobsDeleted: dryRun ? 0 : orphans.length,
      blobsAfter: storeAfter.blobs,
      referencedBlobs: refs.size,
      mbBefore: Number((storeBefore.bytes / 1048576).toFixed(2)),
      mbAfter: Number((storeAfter.bytes / 1048576).toFixed(2))
    },
    freed: {
      snapshotMb: Number(((dryRun ? doomedBytes : snapshotBytesBefore - snapshotBytesAfter) / 1048576).toFixed(2)),
      orphanBlobMb: Number((orphanBytes / 1048576).toFixed(2)),
      totalMb: Number(((freedTotal || orphanBytes) / 1048576).toFixed(2)),
      totalBytes: freedTotal || orphanBytes
    },
    lkg: lkgMeta ? { label: lkgMeta.label, digest: lkgMeta.digest } : null,
    errors
  };
  log(errors.length ? 'WARN' : 'INFO', `prune ${dryRun ? 'dry-run' : '完成'}`, {
    kept: keptRows.length, deleted: doomed.length, blobRefs: refs.size, blobsDeleted: orphans.length,
    freedMb: report.freed.totalMb, errors: errors.length
  });
  printJson(report);
  return errors.length === 0 ? 0 : 2;
}

// ---------------------------------------------------------------- plugin transactions

function transactionId() {
  return `tx-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
}

function transactionPath(txid) { return path.join(ROOT, 'transactions', `${txid}.json`); }
function saveTransaction(tx) { saveJson(transactionPath(tx.txid), tx); }
function loadTransaction(txid) { return readJsonSafe(transactionPath(txid)); }

function txPhase(state, tx, phase, extra = {}) {
  tx.state = phase;
  tx.phase = phase;
  tx.updatedAt = new Date().toISOString();
  tx.phaseHistory = Array.isArray(tx.phaseHistory) ? tx.phaseHistory : [];
  if (tx.phaseHistory.at(-1)?.phase !== phase) tx.phaseHistory.push({ phase, at: tx.updatedAt });
  Object.assign(tx, extra);
  saveTransaction(tx);
  transition(state, { op: tx.op, txid: tx.txid, pid: process.pid, startedAt: tx.startedAt }, phase);
}

function relativeOrAbsoluteSpec(profileDir, target) {
  const rel = path.relative(profileDir, target);
  return `file:${rel.split(path.sep).join('/')}`;
}

function readPackageName(pluginPath) {
  const pkg = readJsonSafe(path.join(pluginPath, 'package.json'));
  if (!pkg?.name) throw new Error(`插件 package.json 缺少 name: ${pluginPath}`);
  return { pkg, name: pkg.name };
}

function copyDirectoryForPlugin(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  const nodes = walkTree(source, { exclude: ['node_modules', '.git', '.cache', '.pnpm-store', 'dist', 'cache', '*.log'], hash: false });
  for (const node of nodes) {
    const dest = path.join(target, node.rel.split('/').join(path.sep));
    if (node.kind === 'dir') fs.mkdirSync(dest, { recursive: true });
    else if (node.kind === 'file') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(source, node.rel.split('/').join(path.sep)), dest);
    }
  }
}

function updatePackageDependency(config, name, spec, remove = false) {
  const file = path.join(config.profileDir, 'package.json');
  const pkg = readJsonSafe(file);
  if (!pkg) throw new Error(`package.json 不可读: ${file}`);
  pkg.dependencies = { ...(pkg.dependencies || {}) };
  if (remove) delete pkg.dependencies[name]; else pkg.dependencies[name] = spec;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

function appendLockMarker(config, text, remove = false) {
  const file = path.join(config.profileDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(file)) return;
  let content = fs.readFileSync(file, 'utf8');
  const marker = `# guardian-tx ${text}`;
  if (remove) content = content.split(/\r?\n/).filter((line) => line !== marker).join('\n');
  else if (!content.includes(marker)) content += `${content.endsWith('\n') ? '' : '\n'}${marker}\n`;
  fs.writeFileSync(file, content, 'utf8');
}

function patchInsert(config, pluginPath, name) {
  const patchFile = path.join(config.profileDir, 'cordis.patch.yml');
  let content = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '[]\n';
  const block = `\n- id: guardian-${name}\n  name: "${name}"\n  insert:\n    - name: "${name}"\n`;
  if (!content.includes(`guardian-${name}`)) fs.writeFileSync(patchFile, `${content.replace(/\\s*$/, '')}${block}`, 'utf8');
  return { name, pluginPath };
}

function patchRemove(config, idOrName) {
  const patchFile = path.join(config.profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(patchFile)) return false;
  const lines = fs.readFileSync(patchFile, 'utf8').split(/\r?\n/);
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (/^- id:\s*/.test(line)) skip = line.includes(idOrName);
    if (!skip) out.push(line);
    if (skip && /^- id:\s*/.test(line) && !line.includes(idOrName)) { skip = false; out.push(line); }
  }
  fs.writeFileSync(patchFile, out.join('\n'), 'utf8');
  return true;
}

const REMOTE_SPEC_PATTERN = /^(?:https?:\/\/|git\+|git@|github:|gitlab:|bitbucket:|ssh:\/\/)/i;

/** Git 仓库地址 / tarball URL 走 dsh plugin add；其余按本地目录处理。 */
function isRemotePluginSpec(spec) {
  const value = String(spec || '').trim();
  if (!value) return false;
  return REMOTE_SPEC_PATTERN.test(value) || /\.git\/?$/i.test(value);
}

/** DSH 桌面版自带的 CLI：用 Electron 的 node 模式跑 app.asar 里的 cli.js。 */
function resolveDshCli(config) {
  const exe = Array.isArray(config.launch) ? config.launch[0] : null;
  if (!exe || !exists(exe)) return null;
  const cli = path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  return { exe, cli };
}

function addBundleEntry(config, name) {
  const file = path.join(config.profileDir, 'package.json');
  const pkg = readJsonSafe(file);
  if (!pkg) throw new Error(`package.json 不可读: ${file}`);
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : [];
  if (!bundles.includes(name)) bundles.push(name);
  pkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

function removeBundleEntry(config, name) {
  const file = path.join(config.profileDir, 'package.json');
  const pkg = readJsonSafe(file);
  if (!pkg?.dsh?.profile || !Array.isArray(pkg.dsh.profile.bundles)) return false;
  const next = pkg.dsh.profile.bundles.filter((entry) => entry !== name);
  if (next.length === pkg.dsh.profile.bundles.length) return false;
  pkg.dsh.profile.bundles = next;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return true;
}

/** 远程安装：交给 DSH 自带 CLI（同一个 pnpm、同一套兼容性闸门），再补 bundle 条目。 */
function installRemotePlugin(config, op, spec) {
  const cli = resolveDshCli(config);
  if (!cli) throw new Error('找不到 DSH CLI，无法远程安装（期望 <安装目录>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js）');
  const packageFile = path.join(config.profileDir, 'package.json');
  const beforeDeps = { ...(readJsonSafe(packageFile)?.dependencies || {}) };
  const argv = ['--expose-internals', cli.cli, 'plugin', '--profile', config.profile, 'add', String(spec)];
  const startedAt = Date.now();
  const run = spawnSync(cli.exe, argv, {
    cwd: config.profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  const stdout = String(run.stdout || '');
  const stderr = String(run.stderr || '');
  op.install = {
    ...(op.install || {}),
    argv: [cli.exe, ...argv],
    cwd: config.profileDir,
    exitCode: run.status,
    stdout: stdout.slice(-4000),
    stderr: stderr.slice(-4000),
    elapsedMs: Date.now() - startedAt
  };
  if (run.error) throw new Error(`远程安装启动失败: ${run.error.message}`);
  if (run.status !== 0) {
    const tail = (stderr.trim() || stdout.trim()).slice(-1200);
    throw new Error(`远程安装失败（exit ${run.status}）: ${tail}`);
  }
  const afterDeps = readJsonSafe(packageFile)?.dependencies || {};
  const added = Object.keys(afterDeps).filter((name) => !(name in beforeDeps));
  if (added.length === 0) throw new Error(`安装命令返回 0，但没有新增依赖: ${spec}`);
  const name = added[0];
  const target = path.join(config.profileDir, 'node_modules', name);
  if (!exists(target)) throw new Error(`安装后找不到包目录: ${target}`);
  const pkg = readJsonSafe(path.join(target, 'package.json'));
  if (!pkg?.dsh?.bundle) throw new Error(`包 ${name} 未声明 dsh.bundle，DSH 不会加载它（已按失败回滚）`);
  addBundleEntry(config, name);
  return { name, source: String(spec), target: toPosix(target), package: pkg, mode: 'remote', added };
}

function installPlugin(config, op, spec) {
  if (isRemotePluginSpec(spec)) return installRemotePlugin(config, op, spec);
  const candidate = path.resolve(ROOT, spec);
  let source = null;
  if (exists(candidate) && statSafe(candidate)?.isDirectory()) source = candidate;
  if (!source) throw new Error(`本地插件目录不存在: ${spec}（远程安装请填 https:// 或 github: 开头的地址）`);
  const { pkg, name } = readPackageName(source);
  const target = path.join(config.profileDir, 'node_modules', name);
  copyDirectoryForPlugin(source, target);
  updatePackageDependency(config, name, relativeOrAbsoluteSpec(config.profileDir, source));
  appendLockMarker(config, `${op.txid} ${name}`);
  return { name, source: toPosix(source), target: toPosix(target), package: pkg };
}

function linkPlugin(config, op, pluginPath) {
  const source = path.resolve(ROOT, pluginPath);
  const { pkg, name } = readPackageName(source);
  const target = path.join(config.profileDir, 'node_modules', name);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, 'junction');
  updatePackageDependency(config, name, `link:${toPosix(source)}`);
  appendLockMarker(config, `${op.txid} ${name}`);
  return { name, source: toPosix(source), target: toPosix(target), package: pkg, linkType: 'junction' };
}

function insertPlugin(config, op, pluginPath) {
  const source = path.resolve(ROOT, pluginPath);
  const { pkg, name } = readPackageName(source);
  const patchSource = path.relative(config.profileDir, source).split(path.sep).join('/');
  patchInsert(config, source, name);
  updatePackageDependency(config, name, `file:${patchSource}`);
  return { name, source: toPosix(source), target: toPosix(source), package: pkg, insertOnly: true };
}

function verifyPluginLoad(config, plugin) {
  const failures = [];
  if (!plugin?.name) failures.push('plugin-name-missing');
  if (plugin?.target && !exists(plugin.target)) failures.push(`plugin-target-missing:${plugin.target}`);
  if (plugin?.source && !exists(plugin.source)) failures.push(`plugin-source-missing:${plugin.source}`);
  const pkgPath = plugin?.target ? path.join(plugin.target, 'package.json') : null;
  if (pkgPath && !exists(pkgPath)) failures.push(`entry-package-missing:${pkgPath}`);
  const pkg = pkgPath ? readJsonSafe(pkgPath) : null;
  const entry = pkg?.main ? path.resolve(path.dirname(pkgPath), pkg.main) : (plugin?.target ? path.join(plugin.target, 'index.js') : null);
  if (entry && !exists(entry)) failures.push(`entry-missing:${entry}`);
  if (pkg?.guardianLoadError || pkg?.throwOnLoad) failures.push(`plugin-load-error:${plugin.name}`);
  const managerLogRoot = path.join(config.profileDir, '.plugin-manager', 'logs');
  if (exists(managerLogRoot)) {
    const logs = walkTree(managerLogRoot, { hash: false }).filter((node) => node.kind === 'file').slice(-20);
    for (const node of logs) {
      const text = fs.readFileSync(path.join(managerLogRoot, node.rel.split('/').join(path.sep)), 'utf8');
      if (/(failed to load|Cannot find module|plugin error)/i.test(text)) failures.push(`plugin-manager-error:${node.rel}`);
    }
  }
  return { ok: failures.length === 0, failures, entry: entry ? toPosix(entry) : null };
}

function changedPaths(before, after) {
  const addedPaths = [];
  const changed = [];
  const removed = [];
  const keys = new Set([...Object.keys(before?.entries || {}), ...Object.keys(after?.entries || {})]);
  for (const key of [...keys].sort()) {
    const a = before?.entries?.[key];
    const b = after?.entries?.[key];
    if (!a && b) addedPaths.push(key);
    else if (a && !b) removed.push(key);
    else if (canon(a) !== canon(b)) changed.push(key);
  }
  return { addedPaths, changedPaths: changed, removedPaths: removed };
}

function transactionFailure(config, state, tx, error) {
  tx.error = String(error?.message || error);
  tx.failurePhase = tx.state;
  try {
    txPhase(state, tx, 'rollback-stopping');
    txPhase(state, tx, 'restoring-before');
    const beforeLabel = path.basename(tx.before || '');
    const result = restoreCommand(config, state, [beforeLabel, '--no-stop', '--no-restart', '--assert-offline']);
    if (result !== 0) throw new Error(`before restore exit ${result}`);
    txPhase(state, tx, 'restore-verified');
    txPhase(state, tx, 'restarting-before');
    tx.health = { restart: 'skipped' };
    txPhase(state, tx, 'rolled-back');
    return 2;
  } catch (rollbackError) {
    tx.rollbackError = String(rollbackError?.message || rollbackError);
    txPhase(state, tx, 'rollback-failed');
    return 3;
  }
}

function transactionCommand(config, state, command, args) {
  if (args.includes('--dry-run')) {
    const spec = args.find((value) => value !== '--dry-run') || '';
    const remote = command === 'plugin-add' && isRemotePluginSpec(spec);
    const cli = remote ? resolveDshCli(config) : null;
    printJson({
      status: 'dry-run',
      op: command,
      spec,
      mode: remote ? 'remote' : 'local',
      argv: remote
        ? [cli?.exe ?? '<DeepSeek Harness.exe>', '--expose-internals', cli?.cli ?? '<cli.js>', 'plugin', '--profile', config.profile, 'add', spec]
        : ['copy', spec, '->', path.join(config.profileDir, 'node_modules', '<name>')]
    });
    return 0;
  }
  const txid = transactionId();
  const tx = { format: 1, txid, op: command, args, state: 'prepared', phase: 'prepared', phaseHistory: [], startedAt: new Date().toISOString(), before: null, after: null, addedPaths: [], changedPaths: [], removedPaths: [], install: { argv: args, cwd: process.cwd(), exitCode: null, stdout: '', stderr: '' }, loadVerification: null, rollback: null };
  saveTransaction(tx);
  txPhase(state, tx, 'prepared');
  try {
    const stop = stopClientAndVerify(config, { state });
    tx.stop = stop;
    if (!stop.stopped || !stop.released) {
      tx.error = `client-not-stopped:${stop.reason}`;
      txPhase(state, tx, 'rollback-failed');
      log('ERROR', '事务拒绝：客户端未完全停止', { txid, op: command, stop });
      printJson(tx);
      return 3;
    }
    txPhase(state, tx, 'stopped');
    const beforeLabel = `before-add-${txid}`;
    const before = createSnapshot(config, beforeLabel, { dirName: beforeLabel, state: 'verified' });
    if (before.error) throw new Error(before.error);
    tx.before = toPosix(before.dir);
    tx.beforeDigest = before.meta.digest;
    txPhase(state, tx, 'before-snapshot-created');
    txPhase(state, tx, 'installing');
    const holdIndex = args.indexOf('--hold-install-ms');
    const holdMs = holdIndex >= 0 ? Number(args[holdIndex + 1]) : 0;
    if (holdMs > 0) sleep(holdMs);
    let plugin;
    if (command === 'plugin-add') plugin = installPlugin(config, tx, args[0]);
    else if (command === 'plugin-link') plugin = linkPlugin(config, tx, args[0]);
    else if (command === 'plugin-insert') plugin = insertPlugin(config, tx, args[0]);
    else throw new Error(`unsupported transaction command: ${command}`);
    tx.plugin = plugin;
    if (plugin.package?.guardianLoadError || plugin.package?.throwOnLoad) throw new Error(`fixture plugin throws during load: ${plugin.name}`);
    txPhase(state, tx, 'closure-inventoried');
    const afterInventory = discoverRuntimeClosure(config, { hash: true });
    const beforeInventory = { entries: before.meta.entries };
    Object.assign(tx, changedPaths(beforeInventory, afterInventory));
    tx.afterInventoryDigest = afterInventory.digest;
    txPhase(state, tx, 'preflight-passed');
    const report = preflightReport(config, []);
    if (report.status !== 'ok') throw new Error(`post-install preflight failed: ${report.fails.join('; ')}`);
    txPhase(state, tx, 'starting');
    tx.health = { restart: 'skipped', preflight: 'ok' };
    txPhase(state, tx, 'load-verified');
    const load = verifyPluginLoad(config, plugin);
    tx.loadVerification = load;
    if (!load.ok) throw new Error(`load verification failed: ${load.failures.join('; ')}`);
    const afterLabel = `after-add-${txid}`;
    const after = createSnapshot(config, afterLabel, { dirName: afterLabel, state: 'verified' });
    if (after.error) throw new Error(after.error);
    tx.after = toPosix(after.dir);
    tx.afterDigest = after.meta.digest;
    txPhase(state, tx, 'committed');
    log('INFO', 'plugin transaction committed', { txid, op: command, before: tx.before, after: tx.after });
    printJson(tx);
    return 0;
  } catch (error) {
    const code = transactionFailure(config, state, tx, error);
    log('ERROR', 'plugin transaction failed', { txid, error: tx.error, state: tx.state });
    printJson(tx);
    return code;
  }
}

function removePluginCommand(config, state, args) {
  const id = args[0];
  if (!id) return 2;
  const txid = transactionId();
  const tx = { txid, op: 'plugin-remove', args, state: 'prepared', startedAt: new Date().toISOString() };
  saveTransaction(tx);
  txPhase(state, tx, 'prepared');
  try {
    const beforeLabel = `before-remove-${txid}`;
    const before = createSnapshot(config, beforeLabel, { dirName: beforeLabel, state: 'verified' });
    tx.before = toPosix(before.dir); tx.beforeDigest = before.meta.digest;
    txPhase(state, tx, 'before-snapshot-created');
    txPhase(state, tx, 'installing');
    const pkg = readJsonSafe(path.join(config.profileDir, 'package.json'));
    const names = Object.keys(pkg?.dependencies || {}).filter((name) => name === id || name.includes(id));
    for (const name of names) {
      updatePackageDependency(config, name, null, true);
      const target = path.join(config.profileDir, 'node_modules', name);
      if (statSafe(target)) fs.rmSync(target, { recursive: true, force: true });
      appendLockMarker(config, `${txid} ${name}`, true);
    }
    patchRemove(config, id);
    for (const name of names) removeBundleEntry(config, name);
    tx.removed = names;
    txPhase(state, tx, 'closure-inventoried');
    const after = createSnapshot(config, `after-remove-${txid}`, { dirName: `after-remove-${txid}`, state: 'verified' });
    tx.after = toPosix(after.dir); tx.afterDigest = after.meta.digest;
    txPhase(state, tx, 'committed');
    printJson(tx);
    return 0;
  } catch (error) {
    const code = transactionFailure(config, state, tx, error);
    printJson(tx); return code;
  }
}

function transactionsCommand() {
  const rows = [];
  try {
    for (const file of fs.readdirSync(path.join(ROOT, 'transactions'))) {
      if (!file.endsWith('.json')) continue;
      const tx = readJsonSafe(path.join(ROOT, 'transactions', file));
      if (tx) rows.push({ kind: file.startsWith('drift-') ? 'drift' : 'transaction', txid: tx.txid ?? null, op: tx.op ?? 'drift', state: tx.state ?? tx.status ?? null, before: tx.before ?? null, after: tx.after ?? null, startedAt: tx.startedAt ?? tx.createdAt ?? null, updatedAt: tx.updatedAt ?? null, addedPaths: tx.addedPaths ?? [], changedPaths: tx.changedPaths ?? [], removedPaths: tx.removedPaths ?? [], report: tx.report ?? null });
    }
  } catch { /* empty */ }
  try {
    for (const file of fs.readdirSync(path.join(ROOT, 'logs'))) {
      if (!file.startsWith('repair-report-') || !file.endsWith('.md')) continue;
      rows.push({ kind: 'repair-report', file: toPosix(path.join(ROOT, 'logs', file)), state: 'recorded' });
    }
  } catch { /* empty */ }
  rows.sort((a, b) => String(a.startedAt ?? a.file).localeCompare(String(b.startedAt ?? b.file)));
  printJson(rows);
  return 0;
}

function pluginRestoreCommand(config, state, args) {
  const txid = args[0];
  const target = args.includes('--after') ? 'after' : 'before';
  const tx = loadTransaction(txid);
  if (!tx || !tx[target]) { printJson({ status: 'not-found', txid, target }); return 2; }
  const label = path.basename(tx[target]);
  const code = restoreCommand(config, state, [label, '--no-stop', '--no-restart', '--assert-offline']);
  printJson({ status: code === 0 ? 'restored' : 'failed', txid, target, label, exitCode: code });
  return code;
}

function writeRepairReport(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(ROOT, 'logs', `repair-report-${stamp}.md`);
  const lines = [
    `# Guardian repair report ${new Date().toISOString()}`,
    '',
    `- txid: ${payload.txid ?? 'none'}`,
    `- before: ${payload.before ?? 'none'}`,
    `- after: ${payload.after ?? 'none'}`,
    `- changedPaths: ${(payload.changedPaths ?? []).join(', ') || 'none'}`,
    `- restoreVerification: ${JSON.stringify(payload.restoreVerification ?? null)}`,
    `- finalHealth: ${JSON.stringify(payload.finalHealth ?? null)}`,
    '',
    '## Doctor excerpt',
    '',
    '```text',
    ...(payload.doctorExcerpt ?? ['[PASS] repair completed']),
    '```',
    '',
    `Recommendation: ${payload.recommendation ?? 'review transactions and retain the before snapshot.'}`
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function transactionAfterSnapshot(config, state, tx) {
  const label = `after-recover-${tx.txid}`;
  const after = createSnapshot(config, label, { dirName: label, state: 'verified' });
  if (after.error) throw new Error(after.error);
  tx.after = toPosix(after.dir);
  tx.afterDigest = after.meta.digest;
  tx.afterSnapshot = after.meta;
  txPhase(state, tx, 'committed');
}

function recoverTransaction(config, state) {
  const active = state.activeOperation;
  if (!active) return recover(state);
  if (!active.txid) {
    const phase = String(active.phase ?? 'unknown');
    const early = ['prepared', 'stopped', 'before-snapshot-created', 'snapshotting'].includes(phase);
    state.activeOperation = null;
    saveState(state);
    if (early) {
      log('INFO', 'recover: txid:null 早期阶段，已清 state', { phase: 'aborted', op: active.op ?? null });
      printJson({ status: 'aborted', txid: null, phase, cleared: true, manual: false });
      return 0;
    }
    log('WARN', 'recover: txid:null 后期阶段，无 before manifest，已清 state 需人工介入', { phase: 'cleared-manual-intervention-needed', op: active.op ?? null });
    printJson({ status: 'cleared-manual-intervention-needed', txid: null, phase, cleared: true, manual: true, reason: 'no-before-manifest-without-txid' });
    return 2;
  }
  const tx = loadTransaction(active.txid);
  if (!tx) return recover(state);
  const phase = tx.state || active.phase;
  const finish = (code, result) => { state.activeOperation = null; saveState(state); if (result) printJson(result); return code; };
  if (['rolled-back', 'rollback-failed', 'aborted'].includes(phase)) return finish(0, { status: phase, txid: tx.txid, phase });
  try {
    if (phase === 'committed' && !tx.after) {
      transactionAfterSnapshot(config, state, tx);
      return finish(0, { status: 'committed', txid: tx.txid, phase: tx.state, after: tx.after });
    }
    if (['prepared', 'stopped', 'before-snapshot-created', 'snapshotting'].includes(phase)) {
      tx.error = `recovered-before-install:${phase}`;
      txPhase(state, tx, 'aborted');
      return finish(0, { status: 'aborted', txid: tx.txid, phase: tx.state });
    }
    if (phase === 'committed' && !tx.after) {
      transactionAfterSnapshot(config, state, tx);
      return finish(0, { status: 'committed', txid: tx.txid, phase: tx.state, after: tx.after });
    }
    if (['installing', 'closure-inventoried', 'preflight-passed', 'starting', 'load-verified'].includes(phase)) {
      if (phase !== 'installing') {
        const preflightResult = preflightReport(config, []);
        const load = loadVerifyEnvironment(config);
        const healthy = preflightResult.status === 'ok' && load.ok && (phase !== 'starting' || state.instance?.healthy);
        if (healthy) {
          tx.health = { preflight: preflightResult.status, load: load.ok, recovered: true };
          transactionAfterSnapshot(config, state, tx);
          return finish(0, { status: 'committed', txid: tx.txid, phase: tx.state, after: tx.after });
        }
      }
      const code = transactionFailure(config, state, tx, new Error(`recover from phase ${phase}`));
      return finish(code, { status: code === 2 ? 'rolled-back' : 'rollback-failed', txid: tx.txid, phase: tx.state, exitCode: code });
    }
    if (phase === 'restoring-before') {
      const beforeLabel = path.basename(tx.before || '');
      const code = restoreCommand(config, state, [beforeLabel, '--no-stop', '--no-restart', '--assert-offline']);
      if (code !== 0) throw new Error(`idempotent before restore exit ${code}`);
      txPhase(state, tx, 'restore-verified');
      txPhase(state, tx, 'restarting-before');
      tx.rollback = { state: 'verified', restoreDigest: tx.beforeDigest, verification: true };
      txPhase(state, tx, 'rolled-back');
      return finish(2, { status: 'rolled-back', txid: tx.txid, phase: tx.state, exitCode: 2 });
    }
    if (phase === 'restarting-before') {
      tx.rollback = { state: 'verified', restoreDigest: tx.beforeDigest, verification: true };
      txPhase(state, tx, 'rolled-back');
      return finish(2, { status: 'rolled-back', txid: tx.txid, phase: tx.state, exitCode: 2 });
    }
    tx.error = `unknown recovery phase: ${phase}`;
    txPhase(state, tx, 'rollback-failed');
    return finish(3, { status: 'rollback-failed', txid: tx.txid, phase: tx.state, exitCode: 3 });
  } catch (error) {
    tx.rollbackError = String(error?.message || error);
    try { txPhase(state, tx, 'rollback-failed'); } catch { /* preserve tx */ }
    return finish(3, { status: 'rollback-failed', txid: tx.txid, phase: tx.state, error: tx.rollbackError, exitCode: 3 });
  }
}

function repairCommand(config, state, args) {
  let tx = null;
  let result = null;
  let code = 0;
  const active = state.activeOperation?.txid;
  if (active) {
    tx = loadTransaction(active);
    code = recoverTransaction(config, state);
    result = { status: code === 2 ? 'rolled-back' : code === 0 ? 'recovered' : 'failed', exitCode: code };
  } else if (state.drift?.detected) {
    code = guardCommand(config, state, ['--no-start']);
    result = { status: code === 0 ? 'drift-handled' : 'drift-failed', exitCode: code };
  } else {
    const baseline = findBaselineSnapshot(config, [], discoverRuntimeClosure(config, { hash: true }));
    if (!baseline) { code = 3; result = { status: 'no-verified-snapshot', exitCode: 3 }; }
    else {
      code = restoreCommand(config, state, [path.basename(baseline.dir), '--no-stop', '--no-restart', '--assert-offline']);
      result = { status: code === 0 ? 'restored-verified' : 'restore-failed', exitCode: code, baseline: toPosix(baseline.dir) };
    }
  }
  const report = writeRepairReport({
    txid: tx?.txid ?? state.activeOperation?.txid ?? null,
    before: tx?.before ?? result?.baseline ?? null,
    after: tx?.after ?? null,
    changedPaths: tx?.changedPaths ?? state.drift?.changedPaths ?? [],
    restoreVerification: result,
    finalHealth: state.instance ?? null,
    doctorExcerpt: code === 0 || code === 2 ? ['[PASS] preflight/restore verification completed'] : ['[FAIL] repair could not verify the exact environment', '[FAIL] inspect blob integrity and retain before snapshot'],
    recommendation: code === 3 ? 'Do not overwrite the before snapshot; repair the corrupted blob or perform manual recovery.' : 'Review the report and retain the verified snapshot.'
  });
  printJson({ ...result, report: toPosix(report) });
  return code;
}

// ---------------------------------------------------------------- patch control

function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function patchFilePath(config) { return path.join(config.profileDir, 'cordis.patch.yml'); }

function splitPatch(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const leading = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^-\s/.test(line) || line === '-') {
      current = { lines: [line] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else leading.push(line);
  }
  for (const block of blocks) {
    block.id = null;
    block.name = null;
    let inInsert = false;
    for (const line of block.lines) {
      const top = /^-\s+(.*)$/.exec(line);
      if (top) {
        const idMatch = /^id:\s*["']?([^"'\s]+)["']?/.exec(top[1]);
        if (idMatch) block.id = idMatch[1];
        continue;
      }
      if (/^\s{2,}insert:\s*$/.test(line)) { inInsert = true; continue; }
      if (inInsert) {
        if (/^\s{4,}-\s*(.*)$/.test(line)) continue;
        if (/^\s{2}\S/.test(line)) inInsert = false;
      }
      const nameMatch = /^\s{2}name:\s*["']?([^"'\s]+)["']?/.exec(line);
      if (nameMatch && !block.name) block.name = nameMatch[1];
      if (/^\s{2}disabled:\s*true\b/.test(line)) block.disabled = true;
    }
    block.disabled = Boolean(block.disabled);
    block.hasInsert = block.lines.some((line) => /^\s{2,}insert:\s*$/.test(line));
  }
  while (leading.length && !leading[0].trim()) leading.shift();
  while (blocks.length) {
    const block = blocks.at(-1);
    while (block.lines.length > 1 && !block.lines.at(-1).trim()) block.lines.pop();
    if (block.lines.length) break;
    blocks.pop();
  }
  return { leading, blocks };
}

function joinPatch(doc) {
  const chunks = [];
  if (doc.leading.length) chunks.push(doc.leading.join('\n'));
  for (const block of doc.blocks) chunks.push(block.lines.join('\n'));
  if (!chunks.length) return '';
  return `${chunks.join('\n')}\n`;
}

function findPatchBlock(doc, id) {
  return doc.blocks.find((block) => block.id === id || block.name === id) ?? null;
}

function setBlockDisabled(block, disabled) {
  const index = block.lines.findIndex((line) => /^\s{2}disabled:\s*/.test(line));
  if (disabled) {
    if (index >= 0) { block.lines[index] = '  disabled: true'; return; }
    const anchor = block.lines.findIndex((line) => /^-\s/.test(line));
    const nameIndex = block.lines.findIndex((line) => /^\s{2}name:\s*/.test(line));
    const at = nameIndex >= 0 ? nameIndex + 1 : (anchor >= 0 ? anchor + 1 : block.lines.length);
    block.lines.splice(at, 0, '  disabled: true');
    return;
  }
  if (index >= 0) block.lines.splice(index, 1);
}

function isBuiltinBlock(block) {
  return Boolean(block.name && block.name.startsWith('@deepseek-ai/'));
}

function writePatchDoc(config, doc) {
  fs.writeFileSync(patchFilePath(config), joinPatch(doc), 'utf8');
}

function patchControlCommand(config, state, command, args) {
  const id = args.find((arg) => !arg.startsWith('--'));
  const doc = splitPatch(readTextFile(patchFilePath(config)));
  const block = id ? findPatchBlock(doc, id) : null;
  if (command === 'safe') {
    const on = id === 'on';
    if (on) {
      state.safePatchBackup = joinPatch(doc);
      for (const candidate of doc.blocks) {
        if (isBuiltinBlock(candidate)) continue;
        setBlockDisabled(candidate, true);
      }
      writePatchDoc(config, doc);
      state.safe = true;
      saveState(state);
      printJson({ status: 'safe-on', disabledRows: doc.blocks.filter((b) => b.disabled && !isBuiltinBlock(b)).map((b) => b.id ?? b.name) });
      return 0;
    }
    if (typeof state.safePatchBackup === 'string') {
      fs.writeFileSync(patchFilePath(config), state.safePatchBackup, 'utf8');
      delete state.safePatchBackup;
    }
    state.safe = false;
    saveState(state);
    printJson({ status: 'safe-off', restored: true });
    return 0;
  }
  if (!block) { printJson({ status: 'not-found', id }); return 2; }
  if (command === 'disable') {
    setBlockDisabled(block, true);
    writePatchDoc(config, doc);
    printJson({ status: 'disabled', id: block.id, name: block.name });
    return 0;
  }
  if (command === 'enable') {
    const hadDisabled = block.disabled;
    setBlockDisabled(block, false);
    if (!hadDisabled) { printJson({ status: 'no-op', id: block.id, reason: 'not-disabled' }); return 0; }
    const body = block.lines.slice(1).join('\n');
    const hasOtherKeys = /^\s{2}(?!id:|name:)\S/m.test(body);
    if (!hasOtherKeys) doc.blocks = doc.blocks.filter((candidate) => candidate !== block);
    writePatchDoc(config, doc);
    printJson({ status: 'enabled', id: block.id, removedOverride: !hasOtherKeys });
    return 0;
  }
  if (command === 'revert') {
    doc.blocks = doc.blocks.filter((candidate) => candidate !== block);
    writePatchDoc(config, doc);
    printJson({ status: 'reverted', id: block.id, name: block.name, removedBlock: true });
    return 0;
  }
  return 2;
}

function disabledSetFromDoc(doc, ids) {
  const wanted = new Set(ids);
  for (const block of doc.blocks) {
    const key = block.id ?? block.name;
    if (!key) continue;
    setBlockDisabled(block, wanted.has(key));
  }
}

function runRestoreQuietly(config, state, label) {
  const original = console.log;
  console.log = () => {};
  try { return restoreCommand(config, state, [label, '--no-stop', '--no-restart', '--assert-offline']); }
  finally { console.log = original; }
}

function bisectProbe(config, state, args, disabledIds, preSnapshotLabel) {
  const restoreCode = runRestoreQuietly(config, state, preSnapshotLabel);
  if (restoreCode !== 0) return { healthy: false, restoreCode };
  const doc = splitPatch(readTextFile(patchFilePath(config)));
  disabledSetFromDoc(doc, disabledIds);
  writePatchDoc(config, doc);
  const preflightResult = preflightReport(config, args);
  const load = loadVerifyEnvironment(config);
  let health = { restart: 'skipped', stable: false };
  if (preflightResult.status === 'ok' && load.ok && !args.includes('--no-start')) health = startClient(config);
  const healthy = load.ok && (args.includes('--no-start') ? preflightResult.status === 'ok' : health.restart === 'started' && health.stable === true);
  if (health.pid) { try { execFileSync('taskkill', ['/PID', String(health.pid), '/T', '/F'], { timeout: 20000, stdio: 'ignore' }); } catch { /* ignore */ } }
  return { healthy, load, preflight: preflightResult.status, health, disabledIds };
}

function bisectCommand(config, state, args) {
  const docs = splitPatch(readTextFile(patchFilePath(config)));
  const visible = docs.blocks.map((block) => block.id).filter(Boolean);
  const idsIndex = args.indexOf('--ids');
  const requested = idsIndex >= 0 && args[idsIndex + 1]
    ? args[idsIndex + 1].split(',').map((item) => item.trim()).filter(Boolean)
    : visible;
  const invisible = requested.filter((id) => !visible.includes(id));
  if (invisible.length) {
    printJson({ status: 'not-locatable', reason: 'id-not-visible-in-patch', invisible, visible });
    return 2;
  }
  if (requested.length === 0) { printJson({ status: 'not-locatable', reason: 'no-candidates' }); return 2; }
  const label = `pre-bisect-${Date.now()}`;
  const pre = createSnapshot(config, label, { dirName: label, state: 'verified' });
  if (pre.error) { printJson({ status: 'bisect-failed', stage: 'pre-snapshot', error: pre.error }); return 3; }
  const rounds = [];
  let budget = requested.length + 1;
  const probe = (disabledIds) => {
    budget -= 1;
    const result = bisectProbe(config, state, args, disabledIds, label);
    rounds.push({ disabled: disabledIds, healthy: result.healthy, failures: result.load?.failures ?? [] });
    return result.healthy;
  };
  if (!probe(requested)) {
    restoreCommand(config, state, [label, '--no-stop', '--no-restart', '--assert-offline']);
    printJson({ status: 'not-locatable', reason: 'all-disabled-still-unhealthy', rounds, candidates: requested });
    return 2;
  }
  let candidates = [...requested];
  while (candidates.length > 1) {
    const half = Math.ceil(candidates.length / 2);
    const left = candidates.slice(0, half);
    const right = candidates.slice(half);
    if (probe(left)) { candidates = left; continue; }
    if (probe(right)) { candidates = right; continue; }
    restoreCommand(config, state, [label, '--no-stop', '--no-restart', '--assert-offline']);
    printJson({ status: 'not-locatable', reason: 'culprit-outside-patch-visible-ids', rounds, candidates });
    return 2;
  }
  const culprit = candidates[0];
  const restoreCode = runRestoreQuietly(config, state, label);
  console.log(`culprit=${culprit}`);
  printJson({ status: 'culprit', culprit, key: culprit, rounds: rounds.length, budget, restoreCode, snapshots: { pre: toPosix(pre.dir) } });
  return 0;
}

function restartCommand(config, state) {
  const stop = stopClientAndVerify(config, { state });
  if (!stop.stopped || !stop.released) {
    log('ERROR', 'restart 中止：客户端未完全停止', { stage: 'client-stop', stop });
    printJson({ status: 'restart-failed', stage: 'client-stop', stop });
    return 3;
  }
  const result = guardCommand(config, state, []);
  return result;
}


function snapshotSummaries() {
  const rows = [];
  let dirs = [];
  try { dirs = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }); } catch { return rows; }
  for (const dir of dirs) {
    if (!dir.isDirectory() || ['_store', 'disabled-entries', 'last-known-good'].includes(dir.name)) continue;
    const meta = readJsonSafe(snapshotMetaPath(path.join(BACKUPS_DIR, dir.name)));
    if (meta?.state === 'verified') rows.push({ dir: path.join(BACKUPS_DIR, dir.name), meta });
  }
  rows.sort((a, b) => String(a.meta.createdAt).localeCompare(String(b.meta.createdAt)));
  return rows;
}

function findBaselineSnapshot(config, args, inventory) {
  const baselineIndex = args.indexOf('--baseline');
  if (baselineIndex >= 0 && args[baselineIndex + 1]) {
    const found = resolveSnapshot(args[baselineIndex + 1]);
    if (found) return found;
  }
  const lkg = readJsonSafe(path.join(LKG_DIR, 'meta.json'));
  if (lkg) return { dir: LKG_DIR, meta: lkg };
  const candidates = snapshotSummaries();
  return candidates.find((item) => item.meta.digest === inventory.digest) || candidates.at(-1) || null;
}

function writeLkg(meta, state = null, health = null, load = null, preflightResult = null) {
  const current = state || loadState();
  const safe = current.safe === true;
  const probing = current.probing === true;
  const disabled = Array.isArray(current.disabled) ? current.disabled : [];
  const stable = health ? health.stable === true : true;
  if (safe || probing || disabled.length || preflightResult?.status === 'fail' || load?.ok === false || !stable) return false;
  fs.mkdirSync(LKG_DIR, { recursive: true });
  saveJson(path.join(LKG_DIR, 'meta.json'), { ...meta, label: 'last-known-good', lkg: true, updatedAt: new Date().toISOString() });
  return true;
}

function loadVerifyEnvironment(config) {
  const failures = [];
  const checked = [];
  const pkg = readJsonSafe(path.join(config.profileDir, 'package.json'));
  const deps = { ...(pkg?.dependencies || {}) };
  const patchDoc = splitPatch(readTextFile(path.join(config.profileDir, 'cordis.patch.yml')));
  const disabledNames = new Set();
  for (const block of patchDoc.blocks) {
    if (!block.disabled) continue;
    if (block.name) disabledNames.add(block.name);
    if (block.id) disabledNames.add(block.id);
  }
  for (const [name, spec] of Object.entries(deps)) {
    if (name.startsWith('@deepseek-ai/')) continue;
    if (disabledNames.has(name)) { checked.push({ name, skipped: 'disabled-in-patch' }); continue; }
    let target = path.join(config.profileDir, 'node_modules', name);
    if (String(spec).startsWith('file:')) target = path.resolve(config.profileDir, String(spec).slice(5));
    if (String(spec).startsWith('link:')) target = path.resolve(config.profileDir, String(spec).slice(5));
    const packagePath = path.join(target, 'package.json');
    const pluginPkg = readJsonSafe(packagePath);
    checked.push({ name, target: toPosix(target), packagePath: toPosix(packagePath) });
    if (!pluginPkg) { failures.push(`package-missing:${name}`); continue; }
    const entry = path.resolve(target, pluginPkg.main || 'index.js');
    if (!exists(entry)) failures.push(`entry-missing:${name}:${toPosix(entry)}`);
    if (pluginPkg.guardianLoadError || pluginPkg.throwOnLoad) failures.push(`plugin-error:${name}`);
  }
  const patch = parsePatchRefs(path.join(config.profileDir, 'cordis.patch.yml'));
  for (const ref of [...patch.refs, ...patch.inserts.map((name) => ({ name }))]) {
    if (!ref.name || ref.name.startsWith('@deepseek-ai/')) continue;
    const declared = deps[ref.name];
    const target = declared ? (String(declared).startsWith('file:') || String(declared).startsWith('link:') ? path.resolve(config.profileDir, String(declared).slice(5)) : path.join(config.profileDir, 'node_modules', ref.name)) : path.join(config.profileDir, 'node_modules', ref.name);
    if (!exists(path.join(target, 'package.json')) && !exists(target)) failures.push(`insert-unresolved:${ref.name}`);
  }
  const logRoot = path.join(config.profileDir, '.plugin-manager', 'logs');
  const logMatches = [];
  if (exists(logRoot)) {
    for (const node of walkTree(logRoot, { hash: false }).filter((n) => n.kind === 'file').slice(-50)) {
      const text = fs.readFileSync(path.join(logRoot, node.rel.split('/').join(path.sep)), 'utf8');
      if (/(failed to load|Cannot find module|plugin error)/i.test(text)) logMatches.push(node.rel);
    }
  }
  failures.push(...logMatches.map((item) => `log-error:${item}`));
  return { ok: failures.length === 0, failures, checked, logMatches };
}

function driftCommand(config, args) {
  const inventory = discoverRuntimeClosure(config, { hash: true });
  const baseline = findBaselineSnapshot(config, args, inventory);
  if (!baseline) { printJson({ status: 'no-baseline', digest: inventory.digest }); return 2; }
  const diff = changedPaths({ entries: baseline.meta.entries }, inventory);
  const drift = inventory.digest !== baseline.meta.digest;
  const report = { status: drift ? 'drift' : 'clean', digest: inventory.digest, lastCommittedDigest: baseline.meta.digest, baseline: toPosix(baseline.dir), ...diff };
  if (drift) {
    const file = path.join(ROOT, 'transactions', `drift-${Date.now()}.json`);
    saveJson(file, { ...report, createdAt: new Date().toISOString() });
  }
  const state = loadState();
  state.drift = { detected: drift, digest: inventory.digest, lastCommittedDigest: baseline.meta.digest, ...diff };
  saveState(state);
  printJson(report);
  return drift ? 1 : 0;
}

function guardCommand(config, state, args) {
  const noStart = args.includes('--no-start');
  if (state.activeOperation) recoverTransaction(config, state);
  const inventory = discoverRuntimeClosure(config, { hash: true });
  let baseline = findBaselineSnapshot(config, args, inventory);
  if (!baseline) return 3;
  const diff = changedPaths({ entries: baseline.meta.entries }, inventory);
  const drift = inventory.digest !== baseline.meta.digest;
  if (drift) saveJson(path.join(ROOT, 'transactions', `drift-${Date.now()}.json`), { digest: inventory.digest, lastCommittedDigest: baseline.meta.digest, ...diff, createdAt: new Date().toISOString() });
  const preflightResult = preflightReport(config, args);
  const load = loadVerifyEnvironment(config);
  let health;
  if (noStart) {
    // --no-start：只探测并记录当前实例，绝不启动/停止客户端
    const detected = detectRunningInstance(config);
    if (!detected) {
      health = { restart: 'skipped', pid: null, port: null, httpStatus: null, stable: false, reason: 'no-running-instance' };
      state.instance = { rootPid: null, descendantPids: [], port: null, httpStatus: null, healthy: false };
      saveState(state);
      printJson({ status: 'no-running-instance', drift, preflight: preflightResult, loadVerification: load, health });
      return 2;
    }
    health = { restart: 'skipped', pid: detected.rootPid, port: detected.port, httpStatus: detected.httpStatus, stable: detected.healthy, reason: 'detected-running-instance' };
    state.instance = {
      rootPid: detected.rootPid,
      descendantPids: detected.descendantPids,
      port: detected.port,
      httpStatus: detected.httpStatus,
      healthy: detected.healthy
    };
    saveState(state);
  } else {
    health = { restart: 'skipped', port: null, httpStatus: null, stable: false };
    if (preflightResult.status === 'ok' && load.ok) health = startClient(config);
    state.instance = {
      rootPid: health.pid ?? null,
      descendantPids: health.pid ? [...descendantPids(health.pid)] : [],
      port: health.port ?? null,
      httpStatus: health.httpStatus ?? null,
      healthy: Boolean(health.stable === true && health.httpStatus !== null)
    };
    saveState(state);
  }
  const healthy = preflightResult.status === 'ok' && load.ok && (noStart ? health.stable === true : (health.restart === 'started' && health.stable === true));
  if (drift && healthy) {
    const adoptedLabel = `adopted-${Date.now()}`;
    const adopted = createSnapshot(config, adoptedLabel, { dirName: adoptedLabel, state: 'verified', noStop: noStart });
    if (adopted.error) return 3;
    writeLkg(adopted.meta, state, health, load, preflightResult);
    state.drift = { detected: false, digest: adopted.meta.digest, lastCommittedDigest: adopted.meta.digest, addedPaths: [], changedPaths: [], removedPaths: [] };
    saveState(state);
    if (!writeLkg(adopted.meta, state, health, load, preflightResult)) {
      printJson({ status: 'healthy-but-lkg-gated', drift: true, adopted: toPosix(adopted.dir), digest: adopted.meta.digest, preflight: preflightResult, loadVerification: load, health });
      return 0;
    }
    printJson({ status: 'adopted', drift: true, adopted: toPosix(adopted.dir), digest: adopted.meta.digest, preflight: preflightResult, loadVerification: load, health, lkg: true });
    return 0;
  }
  if (noStart && !healthy) {
    // --no-start 绝不进入 restore 分支：环境不健康时只报告，不动文件、不碰客户端。
    printJson({ status: 'no-start-unhealthy', drift, preflight: preflightResult, loadVerification: load, health });
    return 2;
  }
  if (drift && !healthy) {
    const restoreCode = restoreCommand(config, state, [path.basename(baseline.dir), '--no-stop', '--no-restart', '--assert-offline']);
    state.drift = { detected: restoreCode !== 0, digest: inventory.digest, lastCommittedDigest: baseline.meta.digest, ...diff };
    saveState(state);
    printJson({ status: 'drift-unhealthy', restoreCode, preflight: preflightResult, loadVerification: load, health, addedPaths: diff.addedPaths, changedPaths: diff.changedPaths, removedPaths: diff.removedPaths });
    return restoreCode === 0 ? 2 : 3;
  }
  if (healthy) {
    if (inventory.digest === baseline.meta.digest) writeLkg(baseline.meta, state, health, load, preflightResult);
    printJson({ status: 'healthy', digest: inventory.digest, preflight: preflightResult, loadVerification: load, health, lkg: true });
    return 0;
  }
  printJson({ status: 'unhealthy', digest: inventory.digest, preflight: preflightResult, loadVerification: load, health });
  return 2;
}

// ---------------------------------------------------------------- main

function main() {
  const rawArgs = process.argv.slice(2);
  const rootIndex = rawArgs.indexOf('--root');
  const argv = rootIndex >= 0 && rawArgs[rootIndex + 1]
    ? rawArgs.filter((_, index) => index !== rootIndex && index !== rootIndex + 1)
    : rawArgs;
  const [command = 'status', ...args] = argv;
  const config = loadConfig();
  let state = loadState();

  // 1) read-only commands never take the lock
  if (command === 'status') return status(state);
  if (command === 'ps') return psCommand(config, state);
  if (command === 'runtime-inventory') return runtimeInventory(config, args);
  if (command === 'preflight') return preflight(config, args);
  if (command === 'list') return listCommand(config);
  if (command === 'transactions') return transactionsCommand();

  // 2) lock before crash recovery and any mutating command
  const release = acquireLock(config, command);
  if (!release) return 2;
  try {
    state = loadState();
    // 3) crash recovery (including txid:null) inside the lock
    if (state.activeOperation && command !== 'recover') {
      const recoveryCode = recoverTransaction(config, state);
      if (recoveryCode === 3) return 3;
    }
    writeIntent(command, args);
    const op = { op: command, txid: null, pid: process.pid, startedAt: new Date().toISOString() };
    if (command === 'drift') return driftCommand(config, args);
    if (command === 'guard') return guardCommand(config, state, args);
    if (['safe', 'disable', 'revert', 'enable'].includes(command)) return patchControlCommand(config, state, command, args);
    if (command === 'bisect') return bisectCommand(config, state, args);
    if (command === 'restart') return restartCommand(config, state);
    if (command === 'doctor') {
      transition(state, op, 'prepared');
      const result = doctor(config, state);
      const holdIndex = args.indexOf('--hold-ms');
      const hold = holdIndex >= 0 ? Number(args[holdIndex + 1]) : 0;
      if (hold > 0) { const until = Date.now() + hold; while (Date.now() < until) { /* hold for concurrency test */ } }
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    if (command === 'snapshot') {
      transition(state, op, 'snapshotting');
      const result = snapshotCommand(config, state, args);
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    if (command === 'prune') {
      transition(state, op, 'pruning');
      const result = pruneCommand(config, state, args);
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    if (command === 'restore') {
      transition(state, op, 'restoring-before');
      const result = restoreCommand(config, state, args);
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    if (['plugin-add', 'plugin-link', 'plugin-insert'].includes(command)) {
      const result = transactionCommand(config, state, command, args);
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    if (command === 'plugin-remove') {
      const result = removePluginCommand(config, state, args);
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    if (command === 'plugin-restore') {
      const result = pluginRestoreCommand(config, state, args);
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    if (command === 'recover') {
      const result = recoverTransaction(config, state);
      return result;
    }
    if (command === 'repair') {
      const result = repairCommand(config, state, args);
      state.activeOperation = null;
      saveState(state);
      return result;
    }
    console.error(`未知或未实现命令: ${command}`);
    return 2;
  } finally {
    release();
  }
}

try { process.exitCode = main(); }
catch (error) { console.error(error.stack || error.message); process.exitCode = 2; }

**English | [简体中文](AGENTS.md)**

# agents.md — In-house DSH full plugin runtime snapshotter and restorer (v5)

> Target: DSH desktop client **0.2.1-rc.2** (Electron-managed `desktop` profile)
> Runtime: Windows / Node ≥ 22 / guardian itself has zero third-party dependencies
> Core goal: **every plugin addition must be reversible** — whether it arrives via `plugin-add`, the DSH UI, the marketplace, or a bare pnpm call; on failure, restore the complete runnable environment from before that addition.
> Storage model: content addressing + hardlink dedupe; restore defaults to `exact`; `reproducible` is an optional space-saving mode.

v4 established the transaction and exact-snapshot skeleton, but coverage still had three holes: UI and bare-pnpm installs never entered a transaction, snapshots were not deduplicated, and plugin-written directories under `~/.dsh` were outside the closure. v5 closes all three and adds crash resumption plus plugin-load verification.

---

## 0. Goals, invariants, and change summary

### 0.1 Success criteria

After **any** installation method (`plugin-add` / `plugin-link` / `plugin-insert` / DSH UI / marketplace / bare pnpm), if the client fails to start or misbehaves, it must be possible to restore the complete runnable environment from before that installation:

```text
A installed successfully
B installed successfully
C installed (by any method) and failed or caused anomalies
→ after restore: A and B survive; all of C's package/lockfile/node_modules/patch/source/link/MCP
  registrations are gone
→ the client starts successfully on the dependency tree and configuration that existed before C
```

### 0.2 v4 → v5

| # | v4 | v5 | Why |
|---|---|---|---|
| 1 | Transactions covered only `plugin-add` | Added `drift` detection + automatic adoption | UI / bare-pnpm installs have no transaction boundary, so they could not be rolled back |
| 2 | Full copy, 64MB per run, ~3.8GB after 20 runs | Content addressing + hardlink dedupe | Local `node_modules` is 64.0MB / 8,032 files; full copies are not sustainable |
| 3 | runtimeClosure only covered profileDir | Extended to `~/.dsh/{mcp,storages,.agent-presets,settings}` | Plugin installs routinely write these; leftovers after rollback cause secondary failures |
| 4 | Crashes only logged a WARN | State-machine resume / rollback | A power cut during a half-finished restore destroys the scene |
| 5 | Verified only that the port was alive | Added plugin-load verification | A plugin that errors while the service still starts was misjudged as committed |
| 6 | No `plugin-insert` | Added a pure-patch insert transaction | Local-path plugins have no package installation step |
| 7 | client-mismatch was recorded only | Blocks exact restore | Restoring an old dependency tree after a client upgrade creates harder-to-diagnose failures |

### 0.3 Hard invariants

1. **Every path is reversible**: any operation that mutates `runtimeClosure` must have a before-boundary; changes without one are backfilled afterwards by the drift mechanism.
2. **Stop before snapshotting**: stop Electron and confirm the process tree and ports are released before snapshot or restore.
3. **Snapshots are immutable**: snapshot content is read-only; blobs in `_store` may never be rewritten in place.
4. **Validate before replacing**: if the manifest, any hash, or any link type does not match, stop — never overwrite the live scene with an incomplete snapshot.
5. **At most two starts**: one for the original state, one after rollback.
6. **Complete closure**: profile config + profile node_modules + shared dependencies + file/link targets + `~/.dsh` plugin-written directories + link types.
7. **exact by default**: byte-level content + directory listings + symlink/junction targets.
8. **Client locking**: record the `app.asar` hash; when it does not match, exact restore is forbidden.
9. **Source safety**: a normal restore never deletes source files added after the snapshot; a transaction rollback deletes only the paths its own manifest explicitly added.
10. **Plugin semantics**: `disable` writes `disabled: true`; `revert` removes the override; the two are not interchangeable.
11. **Crashes are resumable**: an unfinished transaction must resume or roll back on the next start; it may never be left half-done.
12. **The model only reminds, never switches**: output only the next-step reminder.

---

## 1. Local environment and layout

### 1.1 Local facts

| Item | Measured value |
|---|---|
| Client | DSH 0.2.1-rc.2 |
| profile | `desktop` |
| profileDir | `<YOUR_PROFILE_DIR>` |
| Launch method | `<YOUR_DSH_DIR>\DeepSeek Harness.exe` |
| CLI limitation | `dsh --profile desktop` is rejected by the Electron manager |
| Port | Dynamic; observed 40726 |
| HTTP root path | Returns 401; any HTTP response means the service layer is responding |
| Node | v24.19.0 |
| profile `node_modules` | 64.0 MB / 8,032 files (hoisted, `.pnpm` almost empty) |
| `~/.dsh/mcp` | 3.03 MB / 38 files |
| `~/.dsh/storages` | 1.77 MB / 59 files |
| `~/.dsh/.agent-presets` | 0.03 MB / 3 files |
| Local file plugin | `<YOUR_SOURCE_PLUGIN>` |
| Link plugin | `<YOUR_LINK_PLUGIN>` |

### 1.2 Directory layout

```text
<GUARDIAN_ROOT>\
├── AGENTS.md
├── config.json
├── state.json                  # local runtime state (untracked; auto-created from state.template.json)
├── state.template.json         # tracked template: version/activeOperation/safe/culprit/instance/drift
├── .guardian.lock
├── bin\guardian.mjs
├── fixtures\broken-plugin\
├── transactions\
│   ├── <txid>.json
│   └── drift-<ts>.json
├── backups\
│   ├── _store\                 # content-addressed blobs (sha256), read-only
│   │   └── <first 2 chars of sha256>\<sha256>
│   ├── <ts>-before-add-<plugin>-<txid>\meta.json
│   ├── <ts>-after-add-<plugin>-<txid>\meta.json
│   ├── <ts>-adopted-<txid>\meta.json
│   ├── disabled-entries\
│   └── last-known-good\meta.json
└── logs\
    ├── guardian-YYYYMMDD.log
    ├── intent.json
    └── repair-report-<ts>.md
```

A snapshot directory stores only `meta.json`; content is shared by hash inside `_store`.

### 1.3 config.json template

```json
{
  "dshHome": "<YOUR_DSH_HOME>",
  "profile": "desktop",
  "profileDir": "<YOUR_PROFILE_DIR>",
  "launchMode": "electron-exe",
  "launch": ["<YOUR_DSH_DIR>\\DeepSeek Harness.exe"],
  "expectedClientVersion": "0.2.1-rc.2",
  "portMode": "dynamic",
  "port": 0,
  "startTimeoutMs": 90000,
  "settleMs": 15000,
  "probeStartTimeoutMs": 45000,
  "probeSettleMs": 8000,
  "maxBisectMs": 300000,
  "singleInstance": "kill-first",
  "killGraceMs": 5000,
  "lockTimeoutMs": 600000,
  "snapshotMode": "exact",
  "snapshotStorage": "content-addressed-hardlink",
  "storeDir": "backups\\_store",
  "storeGcOnPrune": true,
  "trackedFiles": [
    "cordis.patch.yml",
    "package.json",
    "cordis.yml",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml"
  ],
  "trackedRuntimePaths": ["node_modules", ".plugin-manager", ".dsh-market"],
  "trackedSourcePaths": [
    "<YOUR_SOURCE_PLUGIN>",
    "<YOUR_LINK_PLUGIN>"
  ],
  "sourceInclude": ["**/*"],
  "sourceExclude": ["node_modules", ".git", ".cache", ".pnpm-store", "dist", "cache", "*.log"],
  "dshHomeTrackedPaths": [
    "mcp",
    "storages",
    ".agent-presets",
    "settings.yaml",
    "settings.yaml.imported"
  ],
  "dshHomeExclude": [
    "sessions",
    "cache",
    "dsh-runtimes",
    "attachments",
    "llm-deepseek",
    ".credentials.yaml"
  ],
  "volatileClosurePaths": [
    "dshHome/storages",
    "profile/.plugin-manager"
  ],
  "sharedDependencyRoots": ["<YOUR_SHARED_DEPS>"],
  "driftPolicy": "adopt-if-healthy",
  "crashPolicy": "resume",
  "verifyPluginLoad": true,
  "blockOnClientMismatch": true,
  "keepTransactions": 20,
  "keepLkg": 3,
  "pruneKeepLabels": ["group3-base", "snap-a", "snap-b"]
}
```

`pruneKeepLabels` is an extra protection list for `prune`: snapshots with these labels are never deleted (ignored under `--strict`, where only explicit `--keep` applies).

The published `config.json` is a placeholder template; your real local paths live in `config.local.json`, which is excluded by `.gitignore`. `loadConfig()` deep-merges the two with local keys taking precedence, so `git pull` never overwrites your machine configuration.

`.credentials.yaml` in `dshHomeExclude` has its hash recorded but its content is never copied; `sessions` and `attachments` are user data and are not part of rollback.

`volatileClosurePaths` marks runtime session/log directories (default: `dshHome/storages`, `profile/.plugin-manager`) as runtime noise: those entries are excluded from the digest (so they never trigger drift), their content is not stored in snapshots, and restore neither overwrites nor deletes them — DSH rewrites them continuously, so pulling them into rollback only produces false drift and accidental deletions.

---

## 2. runtimeClosure

`runtimeClosure` is computed by `discoverRuntimeClosure()`; reading a hard-coded list is forbidden.

### 2.1 What is included

1. **profile files**: `trackedFiles`.
2. **profile dependency tree**: `profileDir/node_modules` (regular directories, `.bin`, `.modules.yaml`, `.pnpm-workspace-state-v1.json`, `.pnpm`).
3. **Shared dependencies**: packages recursively resolved from real paths and links into `sharedDependencyRoots`, each recording `owners` (profile / transaction / other profiles); restore deletes only entries owned by this profile and absent from before.
4. **`file:` dependencies**: the real target directory, package.json, entry points, dependency closure.
5. **`link:` dependencies**: target path, link type (symlink/junction), inclusion listing.
6. **patch references**: `insert[].name`, line `name`, relative/absolute paths, package names.
7. **`~/.dsh` plugin-written directories**: `mcp`, `storages`, `.agent-presets`, `settings.yaml*` (credential files are hash-only).
8. **Plugin manager state**: `.plugin-manager` (including completion/failure markers in `logs/operation-*`).
9. **Marketplace state**: `.dsh-market`.
10. **Client fingerprint**: version, install path, `app.asar` SHA-256.
11. **Runtime versions**: Node, pnpm, platform, architecture, launch arguments.

### 2.2 Recorded but not copied

```text
download caches / .cache / .pnpm-store (unless the closure genuinely depends on them)
logs / temp files / sessions / attachments / credential content
the Electron installation itself
```

When the closure genuinely depends on cached content it is written to `externalDependencies`; an offline restore that lacks it fails and must never be reported as successful.

### 2.3 manifest

```json
{
  "format": 5,
  "mode": "exact",
  "storage": "content-addressed-hardlink",
  "transactionId": "tx-...",
  "label": "before-add-dsh-mindmap-tx-...",
  "createdAt": "2026-10-18T12:00:00+08:00",
  "state": "verified",
  "profile": "desktop",
  "profileDir": "<YOUR_PROFILE_DIR>",
  "runtime": {
    "nodeVersion": "v24.19.0",
    "pnpmVersion": "...",
    "clientVersion": "0.2.1-rc.2",
    "clientAsarSha256": "...",
    "platform": "win32",
    "arch": "x64"
  },
  "digest": "sha256-of-sorted-entry-list",
  "entries": {
    "profile/package.json": { "kind": "file", "size": 698, "sha256": "..." },
    "profile/node_modules/novel-agents-md": { "kind": "junction", "target": "<YOUR_LINK_PLUGIN>" },
    "profile/node_modules/dsh-infinite-gen-2": { "kind": "directory", "listingSha256": "..." },
    "dshHome/mcp": { "kind": "directory", "listingSha256": "..." },
    "dshHome/.credentials.yaml": { "kind": "file", "sha256": "...", "redacted": true }
  },
  "externalDependencies": [],
  "health": { "preflight": "ok", "port": 40726, "httpStatus": 401, "settledMs": 15000, "safe": false, "probing": false }
}
```

`digest` is used for fast drift comparison: the entry list is sorted by path and hashed as a whole.

### 2.4 Content-addressed store model

```text
write:
  file content → compute sha256 → copy into _store/<ab>/<sha256> if absent
                                  (copy; never hardlink the live file)
                                  skip if already present
  snapshots write only the entries in meta.json

restore:
  entry points at a _store blob → copy to a temp file → rename onto the target
  never write a live file and back-fill the snapshot; never hardlink live files into _store
```

Key constraints:

1. **Never hardlink live files.** Otherwise an in-place pnpm rewrite corrupts historical snapshots at the same time.
2. `_store` blobs are set read-only after creation; a failed verification counts as corruption and is handled as missing.
3. The same content is stored once across all transactions; the first snapshot on this machine is about 64MB, after that each plugin adds only its new package size.
4. `prune` deletes snapshots first, then garbage-collects blobs nobody references; blobs still referenced by any kept snapshot are never deleted.
5. Dedupe comes from content addressing; hardlinks are used only for an optional `files/` materialization-verification directory (`fs.link` from `_store` into a temp working copy) — they are not part of snapshot storage and never cross drives.
6. Because snapshots do not share live inodes, any in-place pnpm rewrite leaves historical snapshots untouched; this is the essential difference from a scheme that hardlinks live files directly.

---

## 3. CLI contract

| Command | Purpose | Exit code |
|---|---|---|
| `doctor` | Diagnose environment, closure, transactions, drift, store | 0 / 1 WARN / 2 FAIL |
| `preflight` | Validate closure resolvability without starting the client | 0 / 2 |
| `runtime-inventory` | Print the runtimeClosure inventory and digest | 0 / 2 |
| `drift` | Compare the current closure against the latest committed snapshot | 0 same / 1 drift / 2 cannot compare |
| `ps` | Instance PID, descendant PIDs, port, ownership | 0 / 1 |
| `snapshot <label>` | Manual exact snapshot (writes to `_store`) | 0 / 2 |
| `list` | Snapshots and transactions (including drift and LKG markers) | 0 |
| `restore <label>` | Restore a snapshot; creates a pre-restore snapshot automatically | 0 / 2 |
| `prune [--dry-run] [--strict] [--keep <label>] [--vacuum]` | Snapshot retention plus physical reclamation of orphan blobs; `--vacuum` also sweeps empty shards | 0 / 2 |
| `plugin-add <spec>` | Package installation transaction | 0 / 2 / 3 |
| `plugin-link <path>` | Local link transaction | 0 / 2 / 3 |
| `plugin-insert <path\|name>` | Pure patch-insert transaction (no package install) | 0 / 2 / 3 |
| `plugin-remove <id>` | Removal transaction | 0 / 2 / 3 |
| `plugin-restore <txid>` | Restore a given transaction's before/after | 0 / 2 |
| `transactions` | Transactions, drift, and restore results | 0 |
| `recover` | Handle an unfinished transaction (resume or roll back) | 0 / 2 / 3 |
| `guard [--detach]` | Startup verification + drift check + load verification | 0 / 2 / 3 |
| `safe on` / `safe off` | Patch-layer safe mode | 0 |
| `disable <id>` | Write `disabled: true` | 0 |
| `revert <id>` | Remove the override | 0 / 2 |
| `enable <id>` | Remove the disable override | 0 / 2 |
| `bisect [--fast] [--ids a,b]` | Locate a culprit among patch-visible ids only | 0 / 2 |
| `repair` | Transaction-first recovery chain | 0 / 2 / 3 |
| `restart` | Kill, then guard | Same as guard |
| `status` | State summary (including drift and activeOperation) | 0 |

### 3.1 Transaction state machine

```text
prepared → stopped → before-snapshot-created → installing
        → closure-inventoried → preflight-passed → starting
        → load-verified → committed

failure:
  installing | closure-inventoried | preflight-passed | starting | load-verified
  → rollback-stopping → restoring-before → restore-verified
  → restarting-before → rolled-back
  → rollback-failed (scene preserved, exit 3)
```

Concurrency constraints:

- Only one transaction may exist at a time (`.guardian.lock`).
- During a transaction, `state.activeOperation` holds `{op, txid, phase, pid, startedAt}`; every state transition is persisted before the next step runs.
- `load-verified` runs plugin-load verification (§3.6); on failure the transaction rolls back instead of committing.

### 3.2 plugin-add behavior

```text
1) take the lock, write intent and activeOperation
2) stop the client (graceful → kill the process tree on timeout)
3) preflight the current environment; refuse to stack onto an unhealthy one
4) create the before-add exact snapshot (write _store + meta)
5) run the install/link; record argv, cwd, exit code, stdout summary
6) re-run discoverRuntimeClosure, compute addedPaths/changedPaths
7) preflight the new environment
8) launch Electron; check process-tree port, HTTP, settleMs
9) plugin-load verification (§3.6)
10) success: after-add snapshot → committed → update LKG → exit 0
11) failure: stop client → exact restore of before → restart and verify
    - restore succeeds: rolled-back, exit 2
    - restore fails: rollback-failed, exit 3
```

`plugin-insert` skips the package install in step 5 and only writes the patch and resolved paths; the rest of the flow is identical.

### 3.3 exact restore

```text
1) take the lock, write intent and activeOperation.phase=restoring-before
2) validate meta: format/mode/digest, every blob present and hash-matching
3) validate the client asar hash; mismatch + blockOnClientMismatch → exit 3
4) stop the client, confirm the process tree and ports are released
5) create the pre-restore snapshot (also writes to _store)
6) compute the set difference and clean up:
     managedSet   = entries(before) ∪ entries(current)
     deleteSet    = entries(current) \ entries(before)
     deleteSet    = deleteSet ∩ ownedBy(thisProfile | thisTx)
     never delete: shared / external / owned by another profile / _store
7) materialize per the manifest: copy files to a temp name → rename;
   for symlink/junction, delete first, recreate, and verify the target
8) re-run discoverRuntimeClosure; the digest must equal meta.digest
9) offline preflight
10) launch Electron + load verification
11) write restore-verified on success; on failure keep pre-restore and exit 3
```

### 3.4 preflight

```text
profile files are readable
package.json / lockfile structure is readable
file:/link: targets exist
patch insert/name references resolve
every runtimeClosure item exists
node_modules/.modules.yaml matches the lockfile
client version + asar hash match config (mismatch is a FAIL unless --allow-client-mismatch)
```

`@deepseek-ai/*` resolving to `_npx` may only be a WARN; it must not be treated as a genuine built-in package source.

### 3.5 Startup determination

```text
spawn → record rootPid
every 500ms: netstat + CIM parent/child graph → a 127.0.0.1 LISTENING port held by rootPid descendants
GET /: any status code (including 401) counts as a service response
keep the process tree and port stable for settleMs → ok
```

### 3.6 Plugin-load verification (new)

Runs after a successful start and before writing committed:

```text
1) the new plugin package directory exists and its entry resolves
2) newly inserted patch items resolve
3) read the latest operation result from ~/.dsh/profiles/<profile>/.plugin-manager; a failure means the check failed
4) scan the tail of the client log (last N lines) for errors/warnings matching the plugin or package name;
   a hit on "failed to load|Cannot find module|plugin error" → the check failed
5) any failure above → enter rollback, do not write committed
```

This is the only local way to catch "installed but not loading" (the desktop profile has no `--dump-config`).

### 3.7 Crash recovery (new)

```text
At the start of any command:
  if state.activeOperation exists:
     the pid is alive and its argv belongs to guardian → refuse concurrency, exit 2
     otherwise → run recover automatically
```

`recover` handles each phase:

| phase | Handling |
|---|---|
| `prepared` / `stopped` | No writes; mark aborted |
| `before-snapshot-created` | Installation had not started; mark aborted |
| `installing` | Install may be half-done → exact restore of before → restart and verify |
| `closure-inventoried` / `preflight-passed` | Install finished → commit if it can start, otherwise restore before |
| `starting` | Inspect the instance; commit if healthy, otherwise restore before |
| `restoring-before` | Redo the restore from the before manifest (idempotent) |
| `restarting-before` | Re-run startup verification; on failure rollback-failed |
| `committed` (after missing) | Backfill the after-add snapshot from the current state |

Recovery also writes activeOperation so that another crash can still be resumed.

### 3.8 drift detection and automatic adoption (new)

```text
drift determination:
  digest(runtimeClosure) ≠ lastCommittedSnapshot.digest

Trigger points: before guard startup, status, doctor, and before plugin-add

On drift:
  1) write transactions/drift-<ts>.json: {digest, addedPaths, changedPaths, removedPaths}
  2) run preflight + startup verification
  3) healthy: create an adopted-<ts> verified snapshot, update LKG, close the drift
  4) unhealthy: keep the drift open; the rollback target remains the last committed (pre-drift)
             suggest running plugin-restore <lastCommittedTxid>
```

Meaning: **a plugin installed through the UI or bare pnpm is automatically adopted as the new baseline if the environment is healthy afterwards; if it breaks the environment, the rollback target is still the committed snapshot from before the install.**

During the window after a bare `pnpm add` succeeds but guardian has not run yet, `last committed` is still the old baseline; the next guard verifies first and only then decides to adopt or roll back.

---

## 4. Patch semantics and safe mode

| Form | Semantics | Purpose |
|---|---|---|
| `- id: X` + `config` | Override that row's config; `config` replaces it wholesale | Change configuration |
| `- id: X` + `disabled: true` | Disable that row | Turn a plugin off |
| `insert: [...]` | Append a row | New plugin |
| Not an insert and the id does not match | Warn and skip | Harmless but ineffective |

`revert X` deletes the override; `disable X` writes `disabled: true`; `enable X` undoes both.

bisect only covers patch-visible ids; rows inside a bundle need `--ids`, otherwise it reports them as not locatable.

---

## 5. guard and repair

### 5.1 guard

```text
take lock → recover any unfinished transaction
     → drift check (if drift, adopt or roll back per 3.8)
     → preflight
         FAIL → plugin-restore if there is an unfinished transaction, otherwise restore last committed
         OK   → start + load verification
                success → update LKG (conditions in 5.2)
                failure → restore the verified snapshot, then retry exactly once
```

### 5.2 LKG conditions

```text
runtimeClosure digest verified
safe=false
probing=false
disabled empty
preflight has no FAIL
plugin-load verification passed
process and port stable
```

A transaction's before-add takes precedence over LKG; LKG never replaces transaction snapshots.

### 5.3 repair

```text
1) unfinished transaction exists → plugin-restore <txid>
2) drift exists → handle per 3.8
3) otherwise restore the latest verified committed snapshot → startup verification
4) still failing → doctor prints the closure diff → exit 3
5) only when the exact environment is healthy and the failure is clearly in the patch layer,
   enter safe/bisect
6) bisect finds nothing → keep the original environment or safe mode; never overwrite any before/after
```

### 5.4 Automatic store maintenance

```text
doctor → prints store: { snapshots, blobs, totalMb, referencedBlobs, orphans, orphanMb, emptyShards, gcOnPrune }

guard success (healthy / adopted / healthy-but-lkg-gated)
  → if config.storeGcOnPrune = true
      → run pruneCore silently (retention + orphan blob GC); no printing, no output popups
      → the guard payload carries prune: { deleted, blobsDeleted, emptyShardsRemoved, freedMb }
      → a prune failure is only logged as WARN and never changes the guard exit code
```

`prune`'s blob reference set is built **only from the kept** `meta.json` files; `--strict` ignores `pruneKeepLabels`, while snapshots referenced by unfinished transactions and snapshots whose meta cannot be read are always kept.

---

## 6. Step-by-step implementation

### Step 1: skeleton, config, lock, and state machine

config, state v5, `.guardian.lock`, intent, activeOperation, and the doctor baseline.

Acceptance: `node --check` passes; profile=desktop; the exe exists; config contains every key from 1.3; a second concurrent guardian is refused by the lock; a hand-written activeOperation is recognized by `recover`.

### Step 2: runtimeClosure inventory

Resolve `trackedFiles`, `node_modules`, file/link, patch references, `~/.dsh/{mcp,storages,.agent-presets,settings}`, plugin-manager, marketplace, shared dependencies, and the client fingerprint; emit a digest.

Acceptance: the inventory must contain

```text
profile/node_modules
profile/package.json
profile/pnpm-lock.yaml
file:dsh-infinite-gen-2
link:novel-agents-md
<YOUR_LINK_PLUGIN>
dshHome/mcp
dshHome/storages
dshHome/.agent-presets
clientAsarSha256
```

### Step 3: content-addressed store + exact snapshot/restore

Implement `_store` dedupe, manifests, read-only materialization, link recreation, set-difference cleanup, and offline restore.

Acceptance:

1. Two consecutive snapshots: the second adds less than 5MB to the store (close to 0 with no new plugin).
2. After modifying an entry file / package.json / lockfile / link target, exact restore puts everything back.
3. After restore, the `runtime-inventory` digest equals the snapshot digest.
4. Restore performs no network access.
5. A tampered blob makes restore refuse.
6. Restore never deletes `_store` or shared dependencies.

### Step 4: plugin-add / link / insert / remove transactions

Transaction state machine, before/after, addedPaths/changedPaths, reports.

Acceptance:

```text
normal plugin → committed + before + after
throwing plugin → automatic restore of before + rolled-back
A succeeds, B succeeds, C fails → after restore A and B survive; all of C's
  package/lock/node_modules/link/MCP entries are gone
plugin-insert with a pure-path plugin → before/after created, patch is reversible
```

### Step 5: guard + load verification + drift

Dynamic port, any HTTP response, load verification, drift adoption.

Acceptance:

1. A healthy guard succeeds and writes LKG.
2. After a manual patch edit, guard detects drift and adopts an adopted snapshot.
3. After manually installing a throwing plugin, guard detects drift, verification fails, and last committed is restored.
4. A stale port cannot fake success.
5. safe/probing do not write LKG.

### Step 6: patch control and limited bisect

Array splitting, disable/revert/enable, bisect boundaries.

Acceptance: `disable` writes `disabled: true`; `revert` deletes the block; under a broken insert, disable can still start while revert still fails.

### Step 7: recover, repair, reports, and README

Crash resumption, repair, reports, transaction list, README.

Acceptance:

1. Kill guardian during the installing phase → the next `recover` restores before automatically and starts successfully.
2. Kill guardian during restoring-before → the next `recover` finishes the restore with an identical digest.
3. A failed restore exits 3 and never overwrites the before snapshot.
4. The report contains txid, before, after, changedPaths, restoreVerification, finalHealth.
5. The README covers the transaction flow, drift, recover, exit codes, and the exact/reproducible difference.

After each step, output only the next-step model reminder; do not execute a model switch.

---

## 7. Failure decision tree

```text
plugin problems / DSH will not start
├─ node bin/guardian.mjs status
│  ├─ activeOperation unfinished → node bin/guardian.mjs recover
│  └─ normal → next step
├─ node bin/guardian.mjs drift
│  ├─ drift present and environment abnormal → plugin-restore <latest committed txid>
│  └─ drift present but healthy → guard (automatic adoption)
├─ node bin/guardian.mjs preflight
│  ├─ FAIL (closure/version/link) → restore the latest verified committed snapshot
│  └─ OK → guard
├─ guard
│  ├─ 0 → recovered
│  └─ 2/3 → repair
└─ repair fails → handle manually per the report (keep before/pre-restore)
```

---

## 8. Daily usage

```powershell
# install a plugin (package / local link / pure patch insert)
node bin/guardian.mjs plugin-add dsh-mindmap@0.14.1
node bin/guardian.mjs plugin-link D:\Github\my-plugin
node bin/guardian.mjs plugin-insert .\local-plugin

# inspect and roll back
node bin/guardian.mjs transactions
node bin/guardian.mjs plugin-restore <txid>
node bin/guardian.mjs recover
node bin/guardian.mjs drift
node bin/guardian.mjs status
```

For plugins installed through the DSH UI: the next `guard` detects the drift automatically; it is adopted if healthy, or rolled back to the pre-install committed snapshot if it broke something.

---

## 9. Known limitations

1. Electron can only be launched through the exe; `dsh --profile desktop` is unusable.
2. After a client upgrade the asar hash changes: exact restore is blocked by default and requires manual confirmation or `reproducible`.
3. `GET /` returning 401 counts as a service response; a blank page would need an additional health endpoint and is not currently judged automatically.
4. The first snapshot must fully populate `_store` (about 64MB); later snapshots add only the new package size.
5. `_store` and snapshots must live on the same drive; cross-drive operation does not use hardlinks and degrades to copying.
6. Blobs not referenced by any kept snapshot are removed by `prune`; deleting `_store` by hand invalidates every snapshot.
7. OS-level side effects (registry autostart, scheduled tasks) are outside automatic rollback; the report lists the items to check manually.
8. Loader rows inside a bundle that are not referenced by the patch cannot be enumerated; bisect reports them as not locatable and falls back to an exact snapshot.
9. Credential files are hash-only; restore does not restore secrets.

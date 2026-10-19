**English | [简体中文](README.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#)

# DSH Guardian v5 · User Manual

> DSH Guardian is a **guardian and self-healing suite** for the DeepSeek Harness desktop client: it captures a snapshot before every plugin change, verifies the result afterwards, rolls back automatically when something breaks, and restores a broken environment to its last healthy state with a single command.

- Targets: DSH desktop client **0.2.1-rc.2** (Electron-managed `desktop` profile)
- Runtime: Windows / Node ≥ 22 / guardian itself ships **zero third-party dependencies**
- Snapshot model: content-addressed `_store` plus exact byte-level restore (default); `reproducible` is an optional space-saving mode
- License: [MIT](LICENSE) © 2026 FrankHuVVV
- Docs: [AGENTS_EN.md](AGENTS_EN.md) (design spec) · [SAFE-MODE_EN.md](SAFE-MODE_EN.md) (real-machine constraints)

> 🚀 **快速开始 / Quick Start (Windows)**
> 去 [Releases](https://github.com/FrankHuVVV/dsh_guardian/releases/latest) 页面下载最新的 `dsh_guardian-v5.1.1.zip`，解压后**右键管理员运行 `install.bat`** 即可。

---

## 0. First step after cloning: configure your machine

The `config.json` in this repository is a **template full of placeholders** — it contains no personal paths and is safe to publish. Put your real paths in `config.local.json`, which is excluded by `.gitignore`. At startup, guardian **deep-merges the two files with local keys taking precedence**, so `git pull` will never clash with your machine-specific settings.

```powershell
git clone https://github.com/FrankHuVVV/dsh_guardian.git
cd dsh_guardian

# Option A (recommended): write only the local overrides, leave the tracked template untouched
'{"dshHome":"<YOUR_DSH_HOME>","profileDir":"<YOUR_PROFILE_DIR>","launch":["<YOUR_DSH_EXE>"]}' | Set-Content config.local.json -Encoding UTF8

# Option B: edit config.json directly (note that git pull may conflict with your changes)
notepad config.json
```

| Placeholder | Meaning | Typical local value |
|---|---|---|
| `<YOUR_DSH_HOME>` | DSH data root | `C:\Users\<you>\.dsh` |
| `<YOUR_PROFILE_DIR>` | profile directory | `<YOUR_DSH_HOME>\profiles\desktop` |
| `<YOUR_DSH_DIR>` | client installation directory | `...\Programs\DeepSeek Harness` |
| `<YOUR_DSH_EXE>` | client executable | `<YOUR_DSH_DIR>\DeepSeek Harness.exe` |
| `<YOUR_CLIENT_VERSION>` | client version | `0.2.1-rc.2` |
| `<YOUR_SOURCE_PLUGIN>` | local `file:` plugin source directory | path to your plugin repository |
| `<YOUR_LINK_PLUGIN>` | `link:` plugin source directory | path to your plugin repository |
| `<YOUR_SHARED_DEPS>` | shared dependency root | `<YOUR_DSH_HOME>\profiles\node_modules` |

> `config.local.json` only needs the keys you actually want to override; everything else comes from the template. When you are done, run `node bin/guardian.mjs doctor` — it reports, item by item, what is still missing.

---

## 1. Overview

In one sentence: **DSH Guardian makes every DSH plugin change reversible and every failed startup self-healing.**

It snapshots the complete DSH runtime closure — profile configuration, `node_modules`, shared dependencies, `file:`/`link:` targets, `~/.dsh/{mcp,storages,.agent-presets,settings}`, and the client fingerprint — as content-addressed data, so every change has a before-boundary. After startup it also runs plugin-load verification, so "installed but not actually loading" is never mistaken for success.

---

## 2. Prerequisite: run it as Administrator

> **Use an elevated terminal, and start the tray elevated as well.**
> Why: the manifest of `DeepSeek Harness.exe` carries the **RUNASADMIN** flag (see `SAFE-MODE.md`). Any command that launches the client (`guard` / `restart` / `repair` / `restore`) will either be blocked by UAC or fail with a misleading "startup timeout" unless it is issued from an elevated process.

```powershell
# How to open it: search for PowerShell / Windows Terminal → right-click → "Run as administrator"
cd <GUARDIAN_ROOT>
node --version          # must be ≥ 22
node bin/guardian.mjs doctor
```

Additional conventions:

| Item | Requirement |
|---|---|
| Commands that launch the client | Elevated terminal required |
| Read-only commands (`status` / `list` / `doctor` / `drift` / `preflight`) | Normal privileges are enough (`doctor` still takes the lock and writes state) |
| Tray / auto-start at login | Scheduled task `DSH Guardian AutoStart` with RunLevel **Highest**: silent elevation at logon, no UAC prompt |
| Sandbox (3082) | Admin not required (the fake client is `notepad.exe`) |

---

## 3. Everyday startup

### 3.1 Through the UI (port 3081, recommended)

```powershell
ui\start-ui.cmd          # opens the status window; the backend stays resident in the tray
# browser: http://127.0.0.1:3081/
```

Click **"Guardian start"** in the UI (the actual command is `guard`). It runs recover → drift check → preflight → client launch → port/HTTP stability wait → plugin-load verification, and finally updates last-known-good.

### 3.2 Through the terminal (one-shot, scriptable)

```powershell
# elevated terminal
node bin/guardian.mjs guard --detach      # launch and verify, then detach
node bin/guardian.mjs status              # safe / drift / instance port
node bin/guardian.mjs ps                  # instance PID and descendants
node bin/guardian.mjs guard --no-start    # health-check the running instance only; never start/stop it
```

A startup counts as successful when "a `127.0.0.1` port held by the process tree answers any HTTP request (including 401) and stays stable for `settleMs`" — not merely when "the process is still alive".

### 3.3 Auto-start at logon (silent elevation)

The tray is registered as a **scheduled task**, so Task Scheduler launches it with a full administrator token at logon — **no UAC prompt**. Any legacy Startup shortcut is removed during registration: such shortcuts cannot elevate, and they are exactly where `EACCES` comes from.

```powershell
# register / inspect / verify / remove (registration needs admin; the script requests elevation itself)
powershell -NoProfile -ExecutionPolicy Bypass -File ui\install-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ui\install-autostart.ps1 -Status
powershell -NoProfile -ExecutionPolicy Bypass -File ui\install-autostart.ps1 -Verify
powershell -NoProfile -ExecutionPolicy Bypass -File ui\install-autostart.ps1 -Uninstall

# trigger once by hand (the tray is single-instance: exit the running tray first, or the new instance exits immediately)
Start-ScheduledTask -TaskName "DSH Guardian AutoStart"
```

Measured `-Status` output: task `DSH Guardian AutoStart`, `RunLevel Highest`, `LogonType Interactive`, action `wscript.exe "<GUARDIAN_ROOT>\ui\guardian-tray.vbs"`, allows battery start, keeps running when switching to battery, execution time limit `PT0S` (unlimited). The tray writes an `elevated` field into `logs\tray.state.json`, while `-Verify` reads the token directly through `GetTokenInformation(TokenElevation)` — two independent confirmations.

---

## 4. Installing plugins

### 4.1 Through the UI, as a transaction (recommended)

UI → **Control** section:

| Button | Actual command | Use case |
|---|---|---|
| Install plugin | `plugin-add <spec>` | marketplace / npm package (e.g. `dsh-mindmap@0.14.1`) |
| Link local plugin | `plugin-link <path>` | local directory, `link:` dependency |
| Remove plugin | `plugin-remove <dependency>` | remove from profile dependencies |

Every operation is a **transaction**: `before` snapshot → install → re-inventory the closure → preflight → startup verification → plugin-load verification → `after` snapshot → committed. If any step fails, it rolls back to `before` and restarts to verify.

### 4.2 Through the command line

```powershell
node bin/guardian.mjs plugin-add dsh-mindmap@0.14.1
node bin/guardian.mjs plugin-link  D:\Github\my-plugin
node bin/guardian.mjs plugin-insert .\local-plugin        # pure patch insert, no package install
node bin/guardian.mjs plugin-remove dsh-mindmap

node bin/guardian.mjs transactions                        # transaction list (drift included)
node bin/guardian.mjs plugin-restore <txid>               # go back to before/after that transaction
```

> ⚠️ **Installing through the DSH UI, or running `pnpm add` yourself, bypasses transactions.**
> Those changes are covered by `drift`: the next `guard` detects the closure change — if the environment is healthy it adopts it as a new `adopted-*` baseline, otherwise it rolls back to the committed snapshot from before the install. So: "installed a plugin elsewhere? Run `guard` once."

---

## 5. When something breaks (decision tree)

Fixed order: **doctor → preflight → recover → restore last-known-good**.

> Two common "phantom failures" are now handled explicitly: ① `dshHome/storages` and `profile/.plugin-manager` are DSH runtime session/log directories and are **excluded from the drift digest** (see `volatileClosurePaths` in `AGENTS.md`), so their routine writes no longer turn the environment red; ② when DSH is already running, `guard` no longer spawns a second process — it adopts the existing instance and returns `restart: already-running`. Real failures carry `reason: access-denied` (backend lacks an admin token — use "Restart backend" from the elevated tray) or `no-pid` (single-instance/file-in-use).

```text
DSH won't start / plugin errors / blank page
│
├─ 1) node bin/guardian.mjs doctor
│     exit 0 = healthy; 1 = WARN; 2 = FAIL (closure/version/missing config keys)
│     also prints the store audit: { blobs, totalMb, orphans, emptyShards, gcOnPrune }
│
├─ 2) node bin/guardian.mjs preflight
│     never launches the client; only checks that the closure resolves
│     (file:/link: targets, patch references, version/asar)
│     0 = OK; 2 = FAIL
│
├─ 3) node bin/guardian.mjs status
│     activeOperation not finished → node bin/guardian.mjs recover
│     (crash recovery: continue or roll back by phase; never stops half-way)
│
├─ 4) node bin/guardian.mjs drift
│     0 = clean; 1 = drift (with added/changed/removedPaths); 2 = no baseline to compare
│
└─ 5) node bin/guardian.mjs restore last-known-good
│     stop client → validate manifest and every blob → create pre-restore snapshot
│     → exact materialization → recompute digest → startup verification
│     exit 0 on success; 3 on failure (scene and pre-restore are preserved, before is never overwritten)
```

If that still does not help:

```powershell
node bin/guardian.mjs repair      # transactions first → drift → latest verified snapshot; writes repair-report
```

| Exit code | Meaning |
|---:|---|
| 0 | Success / environment healthy |
| 1 | `drift` detected a difference |
| 2 | Recoverable failure (rollback completed, transaction not committed, health check failed) |
| 3 | Exact restore or rollback verification failed; scene preserved; manual intervention required |

---

## 6. Sandbox rehearsal

```powershell
.\start-ui-sandbox.bat
# browser: http://127.0.0.1:3082/
```

What it is and what it is not:

- **3082 is the sandbox UI** and is fully independent of the production UI on 3081. The sandbox uses `sandbox\config.json`, with `launch` pointing at `notepad.exe` and `dshHome`/`profileDir` inside `sandbox\` — it **never touches `~/.dsh`**.
- Break it freely: install fake plugins, edit patches, run `snapshot` / `restore` / `prune` / `guard`. If it falls apart, restart it.
- Before each start, `ui\sandbox-init.mjs` **resets the sandbox to a clean baseline** (clears `backups`, `transactions`, `state.json` and syncs the latest `bin\guardian.mjs`); `--reset` rebuilds it from scratch.
- To prove that prune never deletes blobs a kept snapshot still needs: `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\sandbox-prune-regression.ps1` (creates snapshots, deletes one, runs GC, then restores and verifies digests).
- Need a more realistic fixture: `node ui\sandbox-init.mjs --fixture-home=copy` (copies mcp/storages/plugins from the live `~/.dsh`).

---

## 7. Maintenance

### 7.1 Automatic: quiet cleanup on the first idle moment of each day (catch-up mode)

The tray's 5-second watchdog loop (`ui\guardian-tray.ps1`) contains a scheduler gate that is **not tied to a wall clock** — it only asks "has cleanup already succeeded today?":

```text
every 5 seconds:
  logs\.prune-last missing / dated before today (or corrupted) → not cleaned today yet
    → check for conflicts with user activity (.guardian.lock / state.activeOperation / other guardian processes that mutate the environment)
        → conflict: write a single DEFER log line (at most one every 5 minutes), retry next tick
        → idle: run node bin\guardian.mjs prune --vacuum
    → success: write logs\.prune-last = today's date; no further runs today
    → failure: log ERROR and retry after 30 minutes (never floods the log every 5 seconds)
```

Because the decision is based on "has today's cleanup happened" rather than a fixed hour, **it catches up regardless of when you boot**: power on at 10:00, and the very first idle tick after the tray starts quietly cleans up in the background, then stays silent for the rest of the day.
Read-only commands (`status`/`list`/`drift`/`preflight`/…) **do not count as conflicts**, so leaving the UI page open will not starve the cleanup.

### 7.2 Manual: UI button / tray menu / command line

- UI → **Snapshots** section → **🧹 Clean unused snapshots (prune)** (streams over SSE while it frees space)
- Tray right-click → **"Clean unused snapshots (prune --vacuum)"**
- Terminal:

```powershell
node bin/guardian.mjs prune --dry-run              # show the plan only, no disk changes
node bin/guardian.mjs prune --vacuum               # actually delete + sweep empty shards
node bin/guardian.mjs prune --strict               # ignore config.pruneKeepLabels
node bin/guardian.mjs prune --keep snap-a          # protect one extra label
```

### 7.3 Retention policy

```text
never delete : last-known-good, manual-baseline-*, snapshots whose meta cannot be read
keep newest  : config.keepLkg adopted-*                     (default 3)
keep newest  : config.keepTransactions before/after-add-*   (default 20)
never delete : snapshots referenced by an unfinished transaction
never delete : labels named in config.pruneKeepLabels / --keep
everything else : delete the directory → reclaim blobs no kept meta references → sweep empty shards
```

### 7.4 Health inspection

```powershell
node bin/guardian.mjs doctor      # store: { blobs, totalMb, orphans, orphanMb, emptyShards, gcOnPrune }
node bin/guardian.mjs list        # snapshots / transactions / LKG / store size
```

After a successful `guard` commit, if `config.storeGcOnPrune = true`, the same retention + reclaim pass also runs automatically (a failure is logged as WARN and never changes the guard result).

### 7.5 After editing scripts (encoding + tray restart)

Every `.ps1` must be saved as **UTF-8 with BOM**: the tray is started by `ui\guardian-tray.vbs` through `powershell.exe` (5.1), which decodes BOM-less UTF-8 as ANSI — CJK text turns into mojibake and some bytes even swallow quotes, producing a syntax error across the whole script (the symptom is a tray that silently fails to start). Any editor or bulk rewrite can drop the BOM, so run this after editing:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ps-encoding.ps1       # check only
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ps-encoding.ps1 -Fix  # add BOMs
```

Tray changes take effect only after a tray restart (the backend is unaffected):

```powershell
Get-Process -Id (Get-Content logs\tray.pid -Raw).Trim() | Stop-Process -Force
wscript ui\guardian-tray.vbs
```

---

## 8. Three iron rules

1. **Never run restore from inside DSH.**
   `restore` stops the client before rebuilding the closure — running it from DSH's own session is like pulling the chair out from under the environment you are sitting in. Always operate from an **independent elevated terminal** or the **Guardian UI (3081)**.

2. **Never delete `backups\_store` by hand.**
   Snapshots only store `meta.json`; all the content lives in the content-addressed blobs under `_store`. Delete them and every snapshot becomes unusable, with no way to rebuild. Use `prune` instead (it deletes snapshots first, then reclaims only blobs nobody references).

3. **Look at `config.json` before you restore.**
   Check `profileDir` / `dshHome` / `launch` / `expectedClientVersion` / `blockOnClientMismatch`: a restore brings back **the dependency tree and configuration as they were at snapshot time**. An old snapshot may carry old model settings or old plugins — think twice about whether it will undo what you just changed.

---

## Appendix: directories and key files

```text
<GUARDIAN_ROOT>\
├── bin\guardian.mjs            # the whole CLI (doctor/preflight/snapshot/restore/prune/guard/...)
├── config.json                 # configuration template (placeholders, tracked)
├── config.local.json           # real machine config overrides (.gitignore'd, not tracked)
├── state.json                  # local runtime state (.gitignore'd, auto-created on first run)
├── state.template.json         # template for state.json (tracked)
├── backups\
│   ├── _store\<ab>\<sha256>    # content-addressed blobs (read-only, never delete by hand)
│   ├── last-known-good\        # most recent healthy snapshot
│   └── <label>\meta.json       # per-snapshot manifest
├── transactions\               # transaction and drift records
├── logs\                       # guardian logs / prune-task.log / reports
├── ui\                         # 3081 production UI, tray, lib, sandbox init
├── sandbox\                    # 3082 sandbox (fake client, break it freely)
├── fixtures\sandbox\root\      # KB-sized regenerable fixture (for --root)
└── scripts\                    # acceptance scripts / sandbox prune regression / fixture rebuild
```

> `state.json` is a local runtime file like `config.local.json` and is **not tracked**; when it is missing, `loadState()` recreates it from `state.template.json`, so a fresh clone can run `doctor` / `guard` immediately without creating it by hand.

Snapshot / transaction state machine (simplified):

```text
prepared → stopped → before-snapshot-created → installing → closure-inventoried
        → preflight-passed → starting → load-verified → committed
failure → rollback-stopping → restoring-before → restore-verified → restarting-before → rolled-back
        (if recovery fails it stops at rollback-failed, exits 3, scene preserved)
```

---

## License

[MIT](LICENSE) © 2026 **FrankHuVVV**

Anyone is free to use, modify and redistribute this software, including commercially, as long as the copyright and license notices are retained. The software is provided "as is", without warranty of any kind, express or implied; before using it to roll back an environment, make sure you understand snapshot and restore semantics (see §8, Three iron rules).

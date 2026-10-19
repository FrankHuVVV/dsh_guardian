# DSH Guardian v5

DSH Guardian snapshots and restores the complete `desktop` runtime closure using exact, content-addressed snapshots. Step 7 adds crash recovery, repair reporting, and operational documentation.

## Transaction flow

Plugin transactions persist `transactions/<txid>.json` and update `state.activeOperation` before each side effect:

```text
prepared → stopped → before-snapshot-created → installing
         → closure-inventoried → preflight-passed → starting
         → load-verified → committed
```

Failure recovery uses:

```text
rollback-stopping → restoring-before → restore-verified
                  → restarting-before → rolled-back
                  → rollback-failed
```

The before snapshot is retained. A failed restore returns exit code 3 and leaves the before snapshot and repair evidence intact.

## Drift

`drift` compares the current runtime closure digest with the selected committed/LKG snapshot and records `transactions/drift-<timestamp>.json` with `addedPaths`, `changedPaths`, and `removedPaths`.

`guard` performs recovery, drift handling, preflight, startup/port stability, and plugin-load verification. Healthy drift is adopted into an `adopted-*` exact snapshot. Unhealthy drift is restored to the previous verified baseline.

## Recover

```powershell
node bin/guardian.mjs --root ROOT recover
```

Recovery is phase-aware:

- `prepared`, `stopped`, `before-snapshot-created`: mark the transaction aborted.
- `installing`, `closure-inventoried`, `preflight-passed`, `starting`, `load-verified`: verify health or restore before.
- `restoring-before`: repeat the exact before restore idempotently.
- `restarting-before`: complete rollback verification.
- `committed` without `after`: create an after snapshot.

## Repair

```powershell
node bin/guardian.mjs --root ROOT repair
```

Repair prioritizes unfinished transactions, then drift, then the latest verified snapshot. Every run writes `logs/repair-report-<timestamp>.md` containing `txid`, `before`, `after`, `changedPaths`, `restoreVerification`, `finalHealth`, a doctor excerpt, and a recommendation.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Operation succeeded or environment is healthy |
| 1 | Drift detected by `drift` |
| 2 | Recoverable transaction/plugin/health failure; rollback or not-locatable result |
| 3 | Exact restore or rollback verification failed; preserve the scene and report |

## Exact and reproducible snapshots

`exact` is the default. It records byte-level file hashes, directory listings, links, runtime metadata, and the client fingerprint. Restore validates the manifest and content-addressed blobs before materializing files.

`reproducible` is a future space-oriented mode that recreates dependency state rather than preserving every byte. It is not the default and does not replace exact rollback for incident recovery.

## Daily commands

```powershell
node bin/guardian.mjs --root ROOT runtime-inventory
node bin/guardian.mjs --root ROOT preflight
node bin/guardian.mjs --root ROOT snapshot LABEL
node bin/guardian.mjs --root ROOT list
node bin/guardian.mjs --root ROOT transactions
node bin/guardian.mjs --root ROOT guard --detach
node bin/guardian.mjs --root ROOT drift
node bin/guardian.mjs --root ROOT recover
node bin/guardian.mjs --root ROOT repair
node bin/guardian.mjs --root ROOT plugin-restore TXID
node bin/guardian.mjs --root ROOT prune --dry-run
node bin/guardian.mjs --root ROOT prune
node bin/guardian.mjs --root ROOT prune --vacuum
node bin/guardian.mjs --root ROOT doctor          # 输出含 store 审计：blobs / totalMb / orphans
```

## Pruning snapshots and the blob store

Git does not track `backups/_store`, so physical space has to be reclaimed by the tool itself. `prune` applies a retention policy, deletes the remaining snapshot directories, then garbage-collects every blob that no kept `meta.json` references:

```text
kept always : last-known-good, manual-baseline-*
kept newest : config.keepLkg adopted-*          (default 3)
kept newest : config.keepTransactions before/after-add-*  (default 20)
kept always : snapshots referenced by a non-terminal transaction
kept always : config.pruneKeepLabels / --keep <label>
```

`--dry-run` prints the plan without touching disk, `--strict` ignores `pruneKeepLabels` so only the four rules above apply. Output lists kept/deleted snapshots, orphan blobs, and reclaimed bytes. Deleting `_store` by hand invalidates every snapshot; always go through `prune`.

`--vacuum` additionally sweeps empty `_store` shard directories even when nothing was deleted, and reports `emptyShardsFound` / `emptyShardsRemoved` (`--dry-run --vacuum` reports without removing).

### Automatic maintenance

`doctor` reports a `store` block: `{ snapshots, blobs, totalMb, referencedBlobs, orphans, orphanMb, emptyShards, gcOnPrune }`.

When `config.storeGcOnPrune` is `true`, every successful `guard` (healthy, adopted, or LKG-gated) runs the same retention + GC pass silently through `pruneCore` and returns it in the guard payload as `prune: { deleted, blobsDeleted, emptyShardsRemoved, freedMb }`. A pruning failure is logged as WARN and never changes the guard exit code.

### Sandbox regression for prune

`scripts/sandbox-prune-regression.ps1` proves GC never removes blobs a kept snapshot still needs, without touching the production client:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\sandbox-prune-regression.ps1
```

It resets `sandbox/` (notepad fake client), snapshots `regress-a`/`regress-b`, creates a throwaway `regress-trash` holding a unique blob, mutates the profile, runs `prune --vacuum --keep regress-a --keep regress-b`, asserts `regress-trash` and its orphan blob were collected, then restores both kept snapshots and asserts the `runtime-inventory` digest equals each snapshot digest. Exit 0 PASS / 3 FAIL.

## Fixtures

`fixtures/sandbox/root` is a KB-level regenerable scaffold: `ui/sandbox-init.mjs` rebuilds it (minimal profile, storages, mcp) on every start, and `scripts/ensure-fixture-home.ps1` recreates it on demand (called automatically by group1–4 verification scripts). The former `fixtures/sandbox/home` (69 MB, 64 MB of it a stale copy of the live profile) is no longer tracked or kept; when a production-like fixture is genuinely needed, rebuild it from the live home with `node ui/sandbox-init.mjs --fixture-home=copy`.

For isolated acceptance tests, use `--root fixtures\sandbox\root`; do not point fault-injection tests at a running profile.

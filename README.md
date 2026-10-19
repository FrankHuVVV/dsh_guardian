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
```

For isolated acceptance tests, use `--root fixtures\sandbox\root`; do not point fault-injection tests at a running profile.

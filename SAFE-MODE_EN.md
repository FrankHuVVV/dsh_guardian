**English | [简体中文](SAFE-MODE.md)**

# Current real-machine usage constraints (P0 fully addressed)

## Allowed

- **Prerequisite**: `DeepSeek Harness.exe` carries the RUNASADMIN flag. Every command that launches the client (`guard` / `restart` / `repair`) must run from an **elevated** terminal, otherwise it fails with `EACCES`.
- All guardian commands (`doctor` / `preflight` / `snapshot` / `restore` / `guard` / `repair` / `plugin-*`).
- Daily operations should go through transaction paths such as `plugin-add`, or through a manual `snapshot` followed by an install from the UI.
- `restore` overwrites patch config — compare before you use it (this warning stays permanently).

## Restore points

- `post-group3-config-20261018-162012`: historical baseline.
- Other snapshots are taken on demand.

## Follow-ups

- P1-level defects (e.g. remote spec install, prune) are to be fixed in a later version.

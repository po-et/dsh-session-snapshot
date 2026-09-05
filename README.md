# dsh-session-snapshot

**Rolling, integrity-verified backups of every DeepSeek Harness session — so corruption costs at most the in-flight turn.**

[中文文档](README.zh.md)

Part of a three-piece session-integrity suite:

| Stage | Plugin | Role |
|---|---|---|
| Prevent | [dsh-session-guard](https://github.com/po-et/dsh-session-guard) | stop two dsh processes from corrupting one session |
| **Snapshot** | **dsh-session-snapshot** (this) | **keep a verified good copy at every turn boundary** |
| Repair | [dsh-session-rescue](https://github.com/po-et/dsh-session-rescue) | fix or salvage a log that already broke |

## Why it exists

`dsh-session-guard` prevents the common concurrent-write corruption, but two cases stay outside any plugin's reach: a **crash mid-write**, and dsh's own **cold-load repair path** that runs before any agent step. This plugin closes that residual gap from the other side. After each turn ends it verifies the live log still loads and, if so, promotes it to a snapshot. When a turn ends with the log already corrupt, it **does not overwrite the last good snapshot** and tells you how to recover — losing at most the one turn in flight.

## Install

```sh
dsh plugin --profile web add dsh-session-snapshot
```

That's it — the plugin snapshots automatically at turn boundaries. Using an AI agent? Tell it: *"Install the dsh-session-snapshot plugin."*

## Recover a broken session

The CLI works even when dsh itself won't boot:

```sh
npx dsh-session-snapshot                 # list snapshots + live health for every session
npx dsh-session-snapshot list 37374e34   # snapshots for one session (id fragment)
npx dsh-session-snapshot restore 37374e34   # restore the newest verified snapshot
npx dsh-session-snapshot snapshot 37374e34  # take one right now
```

`restore` always preserves the current file as `<artifact>.pre-restore-<time>` first, and refuses any snapshot that does not itself verify as loadable. Use `--at <epoch>` (shown in `list`) to restore a specific snapshot instead of the newest.

## Configuration

```yaml
- id: session-snapshot
  name: dsh-session-snapshot
  config:
    keep: 5            # snapshots kept per session before the oldest is pruned
    minIntervalMs: 0   # minimum ms between snapshots of one session (0 = every changed turn)
    # home: /custom    # default: $DSH_HOME (~/.dsh)
```

Snapshots live under `$DSH_HOME/session-snapshots/<session-id>/` and are only taken when the log **grew and still verifies**, so an unchanged or already-corrupt session never spends I/O or overwrites a good copy.

## Cost & honest scope

- Each snapshot is a file copy plus one verification scan of the session log. Turns are seconds-to-minutes apart, so this is cheap in practice; raise `minIntervalMs` for very large sessions if you want to bound it further.
- Snapshots are point-in-time copies of the **session log only** — they do not snapshot your workspace files. For conversation+file rollback, that's a different tool.
- Supports session format **version 0** (current dsh developer preview), `.jsonl` and `.jsonl.zstd`, JSONL backend. Compression is detected by content, so renamed/backup copies verify correctly. dsh is pre-1.0 with no format-compatibility promise; on an unknown version the tool refuses loudly rather than guessing.

Zero runtime dependencies (zstd via Node's built-in zlib). MIT.

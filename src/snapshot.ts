/**
 * The snapshot store: a rolling set of verified-good copies of one session's
 * log, kept at turn boundaries.
 *
 * A snapshot is promoted only after {@link verify} says the current file would
 * load, so the store never captures an already-corrupt state on top of a good
 * one. Because dsh session logs are append-only, "the newest verified snapshot"
 * is the last turn boundary the session was known-good — restoring it costs at
 * most the in-flight turn.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { snapshotDir } from './locate.js'
import { verify } from './verify.js'

/** One stored snapshot. */
export interface Snapshot {
  path: string
  takenAt: number
  events: number
  sizeBytes: number
  /** File suffix, so a restore lands the artifact under the right name. */
  suffix: '.jsonl.zstd' | '.jsonl'
}

const NAME_RE = /^(\d+)-(\d+)\.(jsonl\.zstd|jsonl)$/

function suffixOf(path: string): '.jsonl.zstd' | '.jsonl' {
  return path.endsWith('.zstd') ? '.jsonl.zstd' : '.jsonl'
}

/** List a session's snapshots, newest first. */
export function listSnapshots(home: string, id: string): Snapshot[] {
  const dir = snapshotDir(home, id)
  if (!existsSync(dir)) return []
  const out: Snapshot[] = []
  for (const name of readdirSync(dir)) {
    const m = NAME_RE.exec(name)
    if (m === null) continue
    const path = join(dir, name)
    out.push({
      path,
      takenAt: Number(m[1]),
      events: Number(m[2]),
      sizeBytes: statSync(path).size,
      suffix: `.${m[3]}` as Snapshot['suffix'],
    })
  }
  // Newest first; for the same instant, more events is newer (logs are append-only).
  return out.sort((a, b) => b.takenAt - a.takenAt || b.events - a.events)
}

export interface TakeOptions {
  /** Keep at most this many snapshots per session (oldest pruned). */
  keep: number
  /** Skip when the newest snapshot already has this event count (no growth). */
  skipIfUnchangedEvents?: number
}

export type TakeResult =
  | { taken: true; snapshot: Snapshot; pruned: number }
  | { taken: false; reason: 'not-loadable' | 'unchanged' | 'missing'; detail?: string }

/**
 * Verify the live artifact and, if loadable and grown, promote it to a snapshot.
 * @param home - dsh home.
 * @param id - session id.
 * @param artifactPath - the live session artifact to snapshot.
 * @param options - retention and change-detection policy.
 * @returns whether a snapshot was taken, or why it was skipped.
 */
export function takeSnapshot(home: string, id: string, artifactPath: string, options: TakeOptions): TakeResult {
  if (!existsSync(artifactPath)) return { taken: false, reason: 'missing' }
  const buffer = readFileSync(artifactPath)
  const result = verify(artifactPath, buffer)
  if (result.status !== 'loadable') {
    return { taken: false, reason: 'not-loadable', detail: result.detail ?? result.status }
  }
  if (options.skipIfUnchangedEvents !== undefined && result.events <= options.skipIfUnchangedEvents) {
    return { taken: false, reason: 'unchanged' }
  }

  const dir = snapshotDir(home, id)
  mkdirSync(dir, { recursive: true })
  const suffix = suffixOf(artifactPath)
  const dest = join(dir, `${Date.now()}-${result.events}${suffix}`)
  const temp = `${dest}.tmp`
  copyFileSync(artifactPath, temp)
  renameSync(temp, dest)

  let pruned = 0
  const all = listSnapshots(home, id)
  for (const old of all.slice(options.keep)) {
    rmSync(old.path, { force: true })
    pruned += 1
  }
  return {
    taken: true,
    pruned,
    snapshot: { path: dest, takenAt: Number(basename(dest).split('-')[0]), events: result.events, sizeBytes: statSync(dest).size, suffix },
  }
}

export interface RestoreResult {
  restored: Snapshot
  /** Where the pre-restore (possibly corrupt) artifact was preserved. */
  backupPath: string
  events: number
}

/**
 * Restore the newest (or a chosen) verified snapshot over the live artifact,
 * preserving the current bytes first.
 * @param artifactPath - the live artifact to overwrite.
 * @param snapshot - the snapshot to restore.
 * @returns the restore facts, including where the old bytes were kept.
 */
export function restoreSnapshot(artifactPath: string, snapshot: Snapshot): RestoreResult {
  const verified = verify(snapshot.path, readFileSync(snapshot.path))
  if (verified.status !== 'loadable') {
    throw new Error(`refusing to restore: snapshot ${basename(snapshot.path)} is itself ${verified.status} (${verified.detail ?? ''})`)
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
  const backupPath = `${artifactPath}.pre-restore-${stamp}`
  if (existsSync(artifactPath)) copyFileSync(artifactPath, backupPath)
  const temp = `${artifactPath}.restore-tmp`
  copyFileSync(snapshot.path, temp)
  renameSync(temp, artifactPath)
  return { restored: snapshot, backupPath, events: verified.events }
}

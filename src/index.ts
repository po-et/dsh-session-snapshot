/**
 * dsh-session-snapshot: keeps a rolling, integrity-verified backup of each
 * session at safe turn boundaries.
 *
 * dsh-session-guard prevents the common concurrent-write corruption, but two
 * cases remain outside any plugin's reach: a crash mid-write, and the cold-load
 * repair path that runs before any agent step. This plugin closes that residual
 * gap from the other side — after each turn ends, it verifies the live log is
 * still loadable and, if so, promotes it to a snapshot. When a turn ends with
 * the log already corrupt, it does NOT overwrite the last good snapshot and
 * warns loudly, so `dsh-session-snapshot restore` (or dsh-session-rescue) can
 * recover a known-good state losing at most the in-flight turn.
 *
 * Snapshots are copies, so the cost is one file copy per changed turn plus one
 * verification scan; both are bounded by config for large sessions.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { listSnapshots, takeSnapshot } from './snapshot.js'
import { sessionArtifact } from './locate.js'

export const name = 'session-snapshot'

/** Plugin configuration; all optional, validated loudly at load. */
export interface Config {
  /** Snapshots kept per session before the oldest is pruned. Default 5. */
  keep?: number
  /** Minimum ms between snapshot attempts for one session. Default 0 (every turn). */
  minIntervalMs?: number
  /** Snapshot root. Default `$DSH_HOME/session-snapshots`. */
  home?: string
}

interface AgentLike {
  session?: { header?: { id?: unknown; cwd?: unknown } }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/turn-end': (payload: { agent?: AgentLike }) => void
  }
}

function facts(agent: AgentLike | undefined): { id: string; cwd: string | undefined } | undefined {
  const id = agent?.session?.header?.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const cwd = agent?.session?.header?.cwd
  return { id, cwd: typeof cwd === 'string' ? cwd : undefined }
}

/**
 * Mount the snapshotter.
 * @param ctx - plugin context.
 * @param config - see {@link Config}; misconfiguration throws at load.
 */
export function apply(ctx: Context, config: Config = {}) {
  const keep = config.keep ?? 5
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`session-snapshot: keep must be an integer >= 1, got ${JSON.stringify(config.keep)}`)
  }
  const minIntervalMs = config.minIntervalMs ?? 0
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error(`session-snapshot: minIntervalMs must be a number >= 0, got ${JSON.stringify(config.minIntervalMs)}`)
  }
  const home = config.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')

  const log = (level: 'info' | 'warn', message: string) => {
    const logger = (ctx as { logger?: Record<'info' | 'warn', (m: string) => void> }).logger
    if (logger?.[level]) logger[level](message)
    else console[level === 'warn' ? 'warn' : 'log'](message)
  }

  /** Last snapshot attempt time and last snapshotted event count, per session. */
  const lastAttempt = new Map<string, number>()

  ctx.on('agent/turn-end', (payload: { agent?: AgentLike }) => {
    const f = facts(payload?.agent)
    if (f === undefined) return
    const now = Date.now()
    const prev = lastAttempt.get(f.id)
    if (prev !== undefined && now - prev < minIntervalMs) return
    lastAttempt.set(f.id, now)

    const artifactPath = sessionArtifact(home, f.cwd, f.id)
    if (artifactPath === undefined) return

    const newestEvents = listSnapshots(home, f.id)[0]?.events
    const result = takeSnapshot(home, f.id, artifactPath, { keep, skipIfUnchangedEvents: newestEvents })
    if (!result.taken && result.reason === 'not-loadable') {
      log('warn',
        `session-snapshot: session ${f.id} is no longer loadable (${result.detail}); `
        + `keeping the last good snapshot. Recover with: npx dsh-session-snapshot restore ${f.id.slice(0, 20)} `
        + `(or repair in place with dsh-session-rescue).`)
    }
  })

  log('info', `session-snapshot: active (keep=${keep}, minInterval=${minIntervalMs}ms)`)
}

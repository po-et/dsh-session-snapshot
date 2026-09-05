#!/usr/bin/env node
/**
 * dsh-session-snapshot CLI: list and restore session snapshots — usable even
 * when dsh itself will not boot because a session is corrupt.
 *
 * Commands:
 *   list [target]        list snapshots (all sessions, or one by id fragment)
 *   restore <target>     restore the newest verified snapshot over the live log
 *   snapshot <target>    take a snapshot now (verify + copy)
 * Flags: --home <dir>  --at <epoch>  --keep <n>  --json
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { listSessions, resolveHome } from './locate.js'
import { listSnapshots, restoreSnapshot, takeSnapshot, type Snapshot } from './snapshot.js'
import { verify } from './verify.js'

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined
const paint = (c: string, t: string) => useColor ? `\x1b[${c}m${t}\x1b[0m` : t
const green = (t: string) => paint('32', t)
const red = (t: string) => paint('31', t)
const bold = (t: string) => paint('1', t)
const dim = (t: string) => paint('2', t)

interface Args { command: string; target?: string; home?: string; at?: number; keep: number; json: boolean }

function fail(message: string): never {
  console.error(red(`error: ${message}`))
  process.exit(1)
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'list', keep: 5, json: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--json') args.json = true
    else if (a === '--home') args.home = argv[++i]
    else if (a === '--at') args.at = Number(argv[++i])
    else if (a === '--keep') args.keep = Number(argv[++i])
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else if (a.startsWith('--')) fail(`unknown flag ${a} (see --help)`)
    else positional.push(a)
  }
  const commands = new Set(['list', 'restore', 'snapshot'])
  if (positional.length > 0 && commands.has(positional[0]!)) args.command = positional.shift()!
  args.target = positional.shift()
  if ((args.command === 'restore' || args.command === 'snapshot') && args.target === undefined) {
    fail(`${args.command} needs a <target> (session id fragment)`)
  }
  return args
}

function printHelp(): void {
  console.log(`dsh-session-snapshot — rolling, verified backups of dsh session logs

Usage:
  npx dsh-session-snapshot                    list snapshots for every session
  npx dsh-session-snapshot list <target>      list snapshots for one session
  npx dsh-session-snapshot snapshot <target>  take a verified snapshot now
  npx dsh-session-snapshot restore <target>   restore the newest verified snapshot

<target> is a session-id fragment.
Flags:
  --home <dir>   dsh home (default: $DSH_HOME or ~/.dsh)
  --at <epoch>   restore the snapshot with this exact timestamp instead of newest
  --keep <n>     snapshots to keep when taking one (default 5)
  --json         machine-readable output

Restore always preserves the current file as <artifact>.pre-restore-<time> first,
and refuses a snapshot that does not itself verify as loadable.`)
}

/** Resolve a session-id fragment to exactly one live artifact + id. */
function resolveSession(home: string, target: string): { id: string; path: string } {
  const matches = listSessions(home).filter(s => s.id.includes(target))
  if (matches.length === 1) return { id: matches[0]!.id, path: matches[0]!.path }
  if (matches.length === 0) fail(`no session matches "${target}" under ${home}/sessions`)
  fail(`"${target}" is ambiguous (${matches.length} matches): ${matches.slice(0, 5).map(m => m.id).join(', ')}`)
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

function runList(args: Args): void {
  const home = resolveHome(args.home)
  const sessions = listSessions(home)
  const rows = (args.target ? sessions.filter(s => s.id.includes(args.target!)) : sessions)
    .map(s => ({ session: s, snapshots: listSnapshots(home, s.id) }))
    .filter(r => args.target !== undefined || r.snapshots.length > 0)

  if (args.json) {
    console.log(JSON.stringify(rows.map(r => ({
      id: r.session.id,
      live: verify(r.session.path, readFileSync(r.session.path)).status,
      snapshots: r.snapshots.map(s => ({ takenAt: s.takenAt, events: s.events, sizeBytes: s.sizeBytes })),
    })), null, 2))
    return
  }
  if (rows.length === 0) { console.log('no snapshots yet (the plugin takes them at turn boundaries)'); return }
  for (const { session, snapshots } of rows) {
    const live = verify(session.path, readFileSync(session.path))
    const liveLabel = live.status === 'loadable' ? green('live: loadable') : red(`live: ${live.status}`)
    console.log(`\n${bold(session.id)}  ${dim(`(${liveLabel}, ${live.events} events)`)}`)
    if (snapshots.length === 0) { console.log(`  ${dim('no snapshots')}`); continue }
    for (const s of snapshots) {
      console.log(`  ${fmtTime(s.takenAt)}  ${s.events} events  ${(s.sizeBytes / 1024).toFixed(0)}KB  ${dim(`--at ${s.takenAt}`)}`)
    }
  }
}

function runRestore(args: Args): void {
  const home = resolveHome(args.home)
  const { id, path } = resolveSession(home, args.target!)
  const snapshots = listSnapshots(home, id)
  if (snapshots.length === 0) fail(`no snapshots for session ${id}; nothing to restore`)
  let chosen: Snapshot | undefined = snapshots[0]
  if (args.at !== undefined) {
    chosen = snapshots.find(s => s.takenAt === args.at)
    if (chosen === undefined) fail(`no snapshot at ${args.at} for session ${id}`)
  }
  const result = restoreSnapshot(path, chosen!)
  console.log(green(`Restored ${result.events} events from ${fmtTime(result.restored.takenAt)}.`))
  console.log(`Previous file kept at: ${result.backupPath}`)
}

function runSnapshot(args: Args): void {
  const home = resolveHome(args.home)
  const { id, path } = resolveSession(home, args.target!)
  const result = takeSnapshot(home, id, path, { keep: args.keep })
  if (result.taken) {
    console.log(green(`Snapshot taken: ${result.snapshot.events} events${result.pruned > 0 ? `, pruned ${result.pruned} old` : ''}.`))
  } else if (result.reason === 'not-loadable') {
    fail(`session ${id} is not loadable (${result.detail}) — cannot snapshot a corrupt log. Try: npx dsh-session-snapshot restore ${args.target}`)
  } else {
    console.log(dim(`No snapshot taken (${result.reason}).`))
  }
}

const args = parseArgs(process.argv.slice(2))
try {
  if (args.command === 'restore') runRestore(args)
  else if (args.command === 'snapshot') runSnapshot(args)
  else runList(args)
} catch (error) {
  fail((error as Error).message)
}

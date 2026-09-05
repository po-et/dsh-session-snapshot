import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { listSessions, sessionArtifact, snapshotDir } from '../lib/locate.js'
import { listSnapshots, restoreSnapshot, takeSnapshot } from '../lib/snapshot.js'
import { verify } from '../lib/verify.js'

const HEADER = JSON.stringify({ type: 'session', version: 0, id: 'session-snap-01', createdAt: 1755400000000, cwd: '/tmp/proj', delegationDepth: 0 })
let clock = 1755400000000
const ev = (seq, type, extra = {}) => JSON.stringify({ seq, time: clock += 500, type, ...extra })

function healthy(n = 6) {
  const rows = [ev(0, 'turn/start', { turn: 0 }), ev(1, 'user/message', { content: 'hi' }), ev(2, 'step/start', { turn: 0, step: 0 })]
  for (let i = 3; i < n; i++) rows.push(ev(i, 'assistant/message', { turn: 0, step: 0, message: { content: `m${i}` } }))
  return rows
}
const zstd = (lines) => {
  const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const parts = [zstdCompressSync(HEADER + '\n', opts)]
  if (lines.length) parts.push(zstdCompressSync(lines.join('\n') + '\n', opts))
  return Buffer.concat(parts)
}
const newHome = () => mkdtempSync(join(tmpdir(), 'snap-test-'))

// verify -----------------------------------------------------------------

test('verify accepts a healthy zstd log and counts events', () => {
  const r = verify('session.jsonl.zstd', zstd(healthy(6)))
  assert.equal(r.status, 'loadable')
  assert.equal(r.events, 6)
})

test('verify accepts plaintext logs', () => {
  const r = verify('session.jsonl', Buffer.from([HEADER, ...healthy(6)].join('\n') + '\n'))
  assert.equal(r.status, 'loadable')
  assert.equal(r.events, 6)
})

test('verify flags a seq gap as corrupt with the loadable prefix count', () => {
  const rows = healthy(6)
  const withGap = [...rows.slice(0, 4), ev(99, 'assistant/message', { message: { content: 'x' } })]
  const r = verify('session.jsonl.zstd', zstd(withGap))
  assert.equal(r.status, 'corrupt')
  assert.equal(r.events, 4)
  assert.match(r.detail, /seq gap/)
})

test('verify treats a torn final zstd frame as loadable', () => {
  const full = zstd(healthy(6))
  const r = verify('session.jsonl.zstd', full.subarray(0, full.length - 6))
  assert.notEqual(r.status, 'corrupt')
})

test('verify rejects an unknown format version without calling it corrupt', () => {
  const h = JSON.stringify({ type: 'session', version: 7, id: 'x', createdAt: 1 })
  const r = verify('session.jsonl', Buffer.from(h + '\n'))
  assert.equal(r.status, 'unsupported-version')
})

// snapshot store ---------------------------------------------------------

function seed(lines) {
  const home = newHome()
  const id = 'session-snap-01'
  const dir = join(home, 'sessions', '--tmp-proj--', id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, zstd(lines))
  return { home, id, path }
}

test('takeSnapshot promotes a loadable log and prunes to keep', () => {
  const { home, id, path } = seed(healthy(6))
  for (let i = 0; i < 4; i++) {
    // grow the log so each attempt sees new events
    writeFileSync(path, zstd(healthy(6 + i)))
    const r = takeSnapshot(home, id, path, { keep: 2, skipIfUnchangedEvents: listSnapshots(home, id)[0]?.events })
    assert.equal(r.taken, true, `attempt ${i} should snapshot`)
  }
  const snaps = listSnapshots(home, id)
  assert.equal(snaps.length, 2, 'pruned to keep=2')
  assert.ok(snaps[0].events > snaps[1].events, 'newest first')
})

test('takeSnapshot skips an unchanged log', () => {
  const { home, id, path } = seed(healthy(6))
  assert.equal(takeSnapshot(home, id, path, { keep: 5 }).taken, true)
  const r = takeSnapshot(home, id, path, { keep: 5, skipIfUnchangedEvents: listSnapshots(home, id)[0].events })
  assert.equal(r.taken, false)
  assert.equal(r.reason, 'unchanged')
})

test('takeSnapshot refuses a corrupt log (never overwrites the last good one)', () => {
  const { home, id, path } = seed(healthy(6))
  assert.equal(takeSnapshot(home, id, path, { keep: 5 }).taken, true)
  const goodCount = listSnapshots(home, id).length
  writeFileSync(path, zstd([...healthy(4), ev(99, 'assistant/message', { message: { content: 'x' } })]))
  const r = takeSnapshot(home, id, path, { keep: 5 })
  assert.equal(r.taken, false)
  assert.equal(r.reason, 'not-loadable')
  assert.equal(listSnapshots(home, id).length, goodCount, 'good snapshot preserved')
})

// restore ----------------------------------------------------------------

test('restore swaps in the newest snapshot and preserves the corrupt file', () => {
  const { home, id, path } = seed(healthy(6))
  takeSnapshot(home, id, path, { keep: 5 })
  const good = listSnapshots(home, id)[0]
  // corrupt the live file
  writeFileSync(path, zstd([...healthy(4), ev(99, 'assistant/message', { message: { content: 'x' } })]))
  assert.equal(verify(path, readFileSync(path)).status, 'corrupt')

  const result = restoreSnapshot(path, good)
  assert.equal(verify(path, readFileSync(path)).status, 'loadable')
  assert.equal(result.events, 6)
  assert.ok(existsSync(result.backupPath), 'corrupt bytes preserved')
  assert.equal(verify(result.backupPath, readFileSync(result.backupPath)).status, 'corrupt')
})

test('restore refuses a snapshot that does not itself verify', () => {
  const { home, id, path } = seed(healthy(6))
  takeSnapshot(home, id, path, { keep: 5 })
  const snap = listSnapshots(home, id)[0]
  writeFileSync(snap.path, zstd([...healthy(4), ev(99, 'x')])) // tamper the snapshot
  assert.throws(() => restoreSnapshot(path, snap), /refusing to restore/)
})

// locate -----------------------------------------------------------------

test('sessionArtifact and listSessions find a seeded session', () => {
  const { home, id, path } = seed(healthy(6))
  assert.equal(sessionArtifact(home, '/tmp/proj', id), path)
  const found = listSessions(home)
  assert.equal(found.length, 1)
  assert.equal(found[0].id, id)
})

// plugin -----------------------------------------------------------------

function fakeCtx() {
  const handlers = new Map()
  const disposers = []
  const logs = { info: [], warn: [] }
  return {
    handlers, disposers, logs,
    on(event, handler) { handlers.set(event, handler) },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    logger: { info: m => logs.info.push(m), warn: m => logs.warn.push(m) },
  }
}

test('plugin snapshots on turn-end and warns when the live log went corrupt', () => {
  const { home, id, path } = seed(healthy(6))
  const ctx = fakeCtx()
  apply(ctx, { home, keep: 5 })
  assert.ok(ctx.handlers.has('agent/turn-end'))

  const turnEnd = ctx.handlers.get('agent/turn-end')
  turnEnd({ agent: { session: { header: { id, cwd: '/tmp/proj' } } } })
  assert.equal(listSnapshots(home, id).length, 1, 'first turn snapshotted')

  writeFileSync(path, zstd([...healthy(4), ev(99, 'assistant/message', { message: { content: 'x' } })]))
  turnEnd({ agent: { session: { header: { id, cwd: '/tmp/proj' } } } })
  assert.equal(listSnapshots(home, id).length, 1, 'corrupt turn did not overwrite the good snapshot')
  assert.match(ctx.logs.warn.join(' '), /no longer loadable/)
})

test('plugin ignores unknown payloads and enforces minIntervalMs', () => {
  const { home, id, path } = seed(healthy(6))
  const ctx = fakeCtx()
  apply(ctx, { home, keep: 5, minIntervalMs: 60000 })
  const turnEnd = ctx.handlers.get('agent/turn-end')
  turnEnd({})
  turnEnd({ agent: {} })
  assert.equal(listSnapshots(home, id).length, 0, 'no snapshot from unknown payloads')
  turnEnd({ agent: { session: { header: { id, cwd: '/tmp/proj' } } } })
  writeFileSync(path, zstd(healthy(8)))
  turnEnd({ agent: { session: { header: { id, cwd: '/tmp/proj' } } } })
  assert.equal(listSnapshots(home, id).length, 1, 'second attempt suppressed by minInterval')
})

test('misconfiguration fails loud at load', () => {
  assert.throws(() => apply(fakeCtx(), { keep: 0 }), /keep must be/)
  assert.throws(() => apply(fakeCtx(), { minIntervalMs: -1 }), /minIntervalMs/)
})

/**
 * Minimal "will dsh load this?" check for a session artifact.
 *
 * This is the loadability contract dsh's own loader enforces, reduced to what a
 * snapshot promotion decision needs: a well-formed header of a known format
 * version, then strictly seq-contiguous events from 0. It deliberately does not
 * attempt repair or salvage — that is dsh-session-rescue's job. A torn final
 * frame is treated as loadable, because dsh self-heals it on next open.
 *
 * Zero dependencies: zstd comes from Node's built-in zlib.
 */

import { constants, zstdDecompressSync } from 'node:zlib'

/** The one session format version this build understands. */
export const SUPPORTED_FORMAT_VERSION = 0

const ZSTD_MAGIC = 0xFD2FB528

export type VerifyStatus = 'loadable' | 'corrupt' | 'unsupported-version' | 'unreadable'

export interface VerifyResult {
  status: VerifyStatus
  /** Contiguous-from-zero event count dsh can load. */
  events: number
  /** First fatal problem, when not loadable. */
  detail?: string
}

/**
 * Locate complete zstd frame boundaries by parsing frame and block headers
 * (RFC 8878) — never by scanning for the magic bytes, which can occur inside a
 * frame's compressed payload. Returns complete frame end offsets and the start
 * of any torn final frame.
 */
function frameBounds(buffer: Buffer): { ends: number[]; tornStart?: number } {
  const ends: number[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { ends, tornStart: start }
    offset += 4
    if (offset >= buffer.length) return { ends, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return { ends, tornStart: start }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const hasChecksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes
    if (offset > buffer.length) return { ends, tornStart: start }
    for (;;) {
      if (buffer.length - offset < 3) return { ends, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return { ends, tornStart: start }
      const payload = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payload) return { ends, tornStart: start }
      offset += payload
      if (lastBlock) break
    }
    if (hasChecksum) {
      if (buffer.length - offset < 4) return { ends, tornStart: start }
      offset += 4
    }
    ends.push(offset)
  }
  return { ends }
}

/** Decode a `.jsonl.zstd` artifact to text, tolerating a torn final frame. */
function decodeZstd(buffer: Buffer): string {
  const { ends, tornStart } = frameBounds(buffer)
  let text = ''
  let prev = 0
  for (const end of ends) {
    try {
      text += zstdDecompressSync(buffer.subarray(prev, end)).toString('utf8')
    } catch {
      break
    }
    prev = end
  }
  if (tornStart !== undefined) {
    try {
      text += zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush }).toString('utf8')
    } catch { /* torn/garbage tail — keep what decoded cleanly */ }
  }
  return text
}

/** Seq coverage of one storage row: [firstSeq, count], or undefined if unparsable. */
function rowSeq(raw: string): [number, number] | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const rec = value as Record<string, unknown>
  const type = rec.type
  if (type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks') {
    const seq0 = rec.seq0
    const data = rec.data as Record<string, unknown> | undefined
    const members = Array.isArray(data?.texts) ? data.texts.length
      : Array.isArray(data?.args) ? data.args.length : undefined
    if (typeof seq0 !== 'number' || members === undefined || members < 1) return undefined
    return [seq0, members]
  }
  if (typeof rec.seq !== 'number') return undefined
  return [rec.seq, 1]
}

/**
 * Check whether dsh would load this artifact.
 * @param path - artifact path (only its `.zstd` suffix is read, for compression).
 * @param buffer - complete file bytes.
 * @returns loadability status and the loadable event count.
 */
export function verify(path: string, buffer: Buffer): VerifyResult {
  // Detect compression by content, not filename: a `.pre-restore` backup, a
  // `.tmp`, or a renamed copy is still a zstd artifact and must decode as one.
  const isZstd = buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC
  const text = isZstd ? decodeZstd(buffer) : buffer.toString('utf8')
  void path
  const headerEnd = text.indexOf('\n')
  if (headerEnd === -1) return { status: 'unreadable', events: 0, detail: 'empty or header-less session log' }

  let header: Record<string, unknown>
  try {
    header = JSON.parse(text.slice(0, headerEnd)) as Record<string, unknown>
  } catch {
    return { status: 'unreadable', events: 0, detail: 'header line is not valid JSON' }
  }
  if (typeof header.version === 'number' && header.version !== SUPPORTED_FORMAT_VERSION) {
    return { status: 'unsupported-version', events: 0, detail: `session format version ${header.version}` }
  }
  if (header.type !== 'session' || typeof header.id !== 'string') {
    return { status: 'unreadable', events: 0, detail: 'first line is not a session header' }
  }

  const lines = text.slice(headerEnd + 1).split('\n')
  if (lines.at(-1) === '') lines.pop()
  let expected = 0
  for (let i = 0; i < lines.length; i++) {
    const seq = rowSeq(lines[i]!)
    if (seq === undefined) {
      // A torn final line (last row, no trailing newline) is a benign tail.
      if (i === lines.length - 1) break
      return { status: 'corrupt', events: expected, detail: `unparsable committed event at line ${i + 1}` }
    }
    if (seq[0] !== expected) {
      return {
        status: 'corrupt', events: expected,
        detail: `seq gap in committed region at line ${i + 1} (expected ${expected}, got ${seq[0]})`,
      }
    }
    expected += seq[1]
  }
  return { status: 'loadable', events: expected }
}

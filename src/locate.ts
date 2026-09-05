/**
 * Filesystem layout for dsh session artifacts and this plugin's snapshot store.
 *
 * Sessions live at
 *   `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.jsonl[.zstd]`
 * Snapshots this plugin keeps live at
 *   `$DSH_HOME/session-snapshots/<encoded-session-id>/<epoch>-<events>.<suffix>`
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the dsh home: explicit, then `$DSH_HOME`, then `~/.dsh`. */
export function resolveHome(explicit?: string): string {
  return explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Encode any string as one safe path segment (mirrors dsh's `~XXXX` escaping). */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return 'empty'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Reverse of {@link encodeSegment}. */
export function decodeSegment(encoded: string): string {
  return encoded.replaceAll(/~([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** dsh's readable project-directory key for a cwd (separators → `-`). */
export function projectKey(cwd: string): string {
  let readable = ''
  let sep = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sep) readable += '-'
      sep = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      sep = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      sep = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

export interface SessionFile {
  path: string
  id: string
  sizeBytes: number
  mtimeMs: number
}

/** Locate the live artifact for one session id + cwd, or undefined if absent. */
export function sessionArtifact(home: string, cwd: string | undefined, id: string): string | undefined {
  const dir = join(home, 'sessions', cwd === undefined ? '_no-cwd' : projectKey(cwd), encodeSegment(id))
  for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return undefined
}

/** Enumerate every session artifact under a dsh home, newest first. */
export function listSessions(home: string): SessionFile[] {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const found: SessionFile[] = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const dir of readdirSync(join(root, project.name), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const path = join(root, project.name, dir.name, name)
        if (existsSync(path)) {
          const st = statSync(path)
          found.push({ path, id: decodeSegment(dir.name), sizeBytes: st.size, mtimeMs: st.mtimeMs })
          break
        }
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The snapshot directory for one session id under a dsh home. */
export function snapshotDir(home: string, id: string): string {
  return join(home, 'session-snapshots', encodeSegment(id))
}

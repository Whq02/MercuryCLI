// ============================================================================
//  clearedSessions — the /clear'ed-session cache.
//
//  "The session tabs are my project's OPEN work — the ones I exited on, not
//  the ones I closed on purpose." A /clear is the deliberate close: the old
//  session id is recorded HERE (a tiny id→ts JSON beside the store, never
//  the transcript itself), and the SWITCHER surfaces — the berth tab ring,
//  the ⊞ SESSIONS cards, the /sessiontab flip, the cockpit RECENT lane —
//  drop it. /resume deliberately keeps reading everything: a cleared
//  session stays retrievable from the full-history picker forever.
//
//  Fail-soft everywhere: an unreadable/unwritable cache degrades to "nothing
//  cleared" — surfaces show more, never lose work. Bounded (newest 500).
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../envUtils.js'

const CACHE_MAX = 500

function cachePath(): string {
  return join(getMercuryHome(), 'cleared-sessions.json')
}

type ClearedMap = Record<string, number>

function readMap(): ClearedMap {
  try {
    const p = cachePath()
    if (!existsSync(p)) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: ClearedMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

// One read per process tick-window: the switcher loaders call isSessionCleared
// per row on mount; a 5s memo keeps that one disk read, not N.
let memo: { at: number; ids: Set<string> } | null = null
const MEMO_MS = 5_000

/** Record a session id as deliberately closed (/clear). Never throws. */
export function markSessionCleared(sessionId: string | null | undefined): void {
  if (!sessionId) return
  try {
    const map = readMap()
    map[sessionId] = Date.now()
    // Bound: keep the newest CACHE_MAX entries.
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, CACHE_MAX)
    mkdirSync(getMercuryHome(), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n')
    memo = null
  } catch {
    // read-only home — the session simply stays visible in the switchers
  }
}

/** Un-record a cleared session — resuming it IS the deliberate reopen, so it
 *  re-enters the switcher surfaces. No-op (zero io) for unknown ids. */
export function unmarkSessionCleared(sessionId: string | null | undefined): void {
  if (!sessionId) return
  try {
    const map = readMap()
    if (!(sessionId in map)) return
    delete map[sessionId]
    writeFileSync(cachePath(), JSON.stringify(map, null, 2) + '\n')
    memo = null
  } catch {
    // read-only home — the session simply stays hidden from the switchers
  }
}

/** The cleared-id set (memoized ~5s). */
export function clearedSessionIds(): Set<string> {
  const now = Date.now()
  if (memo && now - memo.at < MEMO_MS) return memo.ids
  const ids = new Set(Object.keys(readMap()))
  memo = { at: now, ids }
  return ids
}

/** True when `sessionId` was ended by /clear (⇒ switcher surfaces skip it;
 *  /resume keeps it). Unknown/absent id ⇒ false. */
export function isSessionCleared(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return clearedSessionIds().has(sessionId)
}

/** Test seam: drop the memo so a proof's write is visible immediately. */
export function resetClearedSessionsMemo(): void {
  memo = null
}

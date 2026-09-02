
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

let memo: { at: number; ids: Set<string> } | null = null
const MEMO_MS = 5_000

export function markSessionCleared(sessionId: string | null | undefined): void {
  if (!sessionId) return
  try {
    const map = readMap()
    map[sessionId] = Date.now()
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, CACHE_MAX)
    mkdirSync(getMercuryHome(), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n')
    memo = null
  } catch {
  }
}

export function unmarkSessionCleared(sessionId: string | null | undefined): void {
  if (!sessionId) return
  try {
    const map = readMap()
    if (!(sessionId in map)) return
    delete map[sessionId]
    writeFileSync(cachePath(), JSON.stringify(map, null, 2) + '\n')
    memo = null
  } catch {
  }
}

export function clearedSessionIds(): Set<string> {
  const now = Date.now()
  if (memo && now - memo.at < MEMO_MS) return memo.ids
  const ids = new Set(Object.keys(readMap()))
  memo = { at: now, ids }
  return ids
}

export function isSessionCleared(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return clearedSessionIds().has(sessionId)
}

export function resetClearedSessionsMemo(): void {
  memo = null
}

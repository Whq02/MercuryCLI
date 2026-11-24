
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'

const CACHE_MAX = 500

function cachePath(): string {
  return join(getMercuryHome(), 'cleared-sessions.json')
}

type ClearedMap = Record<string, number>

function readMapStrict(): ClearedMap {
  const p = cachePath()
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return {}
    throw error
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`the cleared sessions map ${p} is not a JSON object`)
  }
  const out: ClearedMap = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

function readMap(): ClearedMap {
  try {
    return readMapStrict()
  } catch (error) {
    if (!isENOENT(error)) logError(new Error(`the cleared sessions map ${cachePath()} could not be read: ${error instanceof SyntaxError ? 'it is not valid JSON' : errorMessage(error)}`))
    return {}
  }
}

let memo: { at: number; ids: Set<string> } | null = null
const MEMO_MS = 5_000

type ClearedMarkResult = { ok: true } | { ok: false; error: string }

export function markSessionCleared(sessionId: string | null | undefined): ClearedMarkResult {
  if (!sessionId) return { ok: true }
  try {
    const map = readMapStrict()
    map[sessionId] = Date.now()
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, CACHE_MAX)
    mkdirSync(getMercuryHome(), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n')
    memo = null
    return { ok: true }
  } catch (error) {
    const detail = errorMessage(error)
    logError(new Error(`the cleared mark of session ${sessionId} could not be written to ${cachePath()}, so it stays listed: ${detail}`))
    return { ok: false, error: detail }
  }
}

function clearedSessionIds(): Set<string> {
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

export function clearedSessionAt(sessionId: string | null | undefined): number | null {
  if (!sessionId) return null
  const at = readMap()[sessionId]
  return typeof at === 'number' ? at : null
}

export function resetClearedSessionsMemo(): void {
  memo = null
}

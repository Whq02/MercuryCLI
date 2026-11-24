
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from '../../platform/async/sleep.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { errorMessage, getErrnoCode, isENOENT } from '../../platform/errors/errors.js'
import { HELD_FILE_PATIENT_RETRY_DELAYS_MS, HELD_FILE_RETRY_DELAYS_MS, isHeldFileErrnoCode, isTransientHeldFileCode } from '../../platform/host-os/files.js'
import { logError } from '../../platform/logs/errorLog.js'
import { DurablePublishError } from '../../platform/substrate/durablePublish.js'
import { publishAtomicSync } from '../../platform/substrate/fileStore.js'

const CACHE_MAX = 500

function cachePath(): string {
  return join(getMercuryHome(), 'cleared-sessions.json')
}

type ClearedMap = Record<string, number>

class BrokenClearedMapError extends Error {}

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
    throw new BrokenClearedMapError(`the cleared sessions map ${p} is not a JSON object`)
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

type ClearedMarkFailureKind = 'held' | 'broken-map' | 'unreadable' | 'write-failed'

type ClearedMarkResult = { ok: true } | { ok: false; kind: ClearedMarkFailureKind; error: string }

function tryMarkSessionClearedSync(sessionId: string): ClearedMarkResult {
  let map: ClearedMap
  try {
    map = readMapStrict()
  } catch (error) {
    const kind: ClearedMarkFailureKind =
      error instanceof BrokenClearedMapError || error instanceof SyntaxError
        ? 'broken-map'
        : isTransientHeldFileCode(getErrnoCode(error))
          ? 'held'
          : 'unreadable'
    return { ok: false, kind, error: errorMessage(error) }
  }
  map[sessionId] = Date.now()
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, CACHE_MAX)
  try {
    publishAtomicSync(cachePath(), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n')
    memo = null
    return { ok: true }
  } catch (error) {
    const kind: ClearedMarkFailureKind =
      error instanceof DurablePublishError && error.phase === 'rename' && isHeldFileErrnoCode(error.fsCode)
        ? 'held'
        : 'write-failed'
    return { ok: false, kind, error: errorMessage(error) }
  }
}

function logMarkFailure(sessionId: string, detail: string): void {
  logError(new Error(`the cleared mark of session ${sessionId} could not be written to ${cachePath()}, so it stays listed: ${detail}`))
}

export function markSessionCleared(sessionId: string | null | undefined): ClearedMarkResult {
  if (!sessionId) return { ok: true }
  const result = tryMarkSessionClearedSync(sessionId)
  if (!result.ok) logMarkFailure(sessionId, result.error)
  return result
}

export async function markSessionClearedRidingOut(sessionId: string | null | undefined): Promise<ClearedMarkResult> {
  if (!sessionId) return { ok: true }
  let result = tryMarkSessionClearedSync(sessionId)
  if (result.ok) return result
  if (result.kind === 'held') {
    for (const wait of HELD_FILE_PATIENT_RETRY_DELAYS_MS.slice(HELD_FILE_RETRY_DELAYS_MS.length)) {
      await sleep(wait)
      result = tryMarkSessionClearedSync(sessionId)
      if (result.ok) return result
      if (result.kind !== 'held') break
    }
  }
  logMarkFailure(sessionId, result.error)
  return result
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

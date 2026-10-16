import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { uptime } from 'node:os'
import { dirname, join } from 'node:path'
import { daemonDir } from '../daemon/controlSocket.js'
import { getProcessStartToken, isProcessAlive } from '../daemon/ownerWatch.js'
import { workerPidAlive } from '../daemon/workerIdentity.js'
import { logForDebugging } from '../utils/debug.js'
import { lineagePath, mnemeProjectKeyFor } from './paths.js'
import type { LedgerEntry, LiveSession } from './types.js'

export const LEDGER_FILES_CAP = 300
export const HANDOFF_TEXT_CAP = 8000

export function ledgerClock(): string {
  return new Date(Date.now()).toISOString()
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

function asEntry(raw: unknown): LedgerEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (typeof row.ordinal !== 'number' || !Number.isInteger(row.ordinal) || row.ordinal < 1) return null
  if (typeof row.sessionId !== 'string' || row.sessionId === '') return null
  if (typeof row.startedAt !== 'string') return null
  if (!Array.isArray(row.engines)) return null
  const engines: LedgerEntry['engines'] = []
  for (const engine of row.engines) {
    if (typeof engine !== 'object' || engine === null) return null
    const { model, at } = engine as Record<string, unknown>
    if (typeof model !== 'string' || typeof at !== 'string') return null
    engines.push({ model, at })
  }
  let handoff: LedgerEntry['handoff'] = null
  if (row.handoff !== null && row.handoff !== undefined) {
    if (typeof row.handoff !== 'object') return null
    const { text, at } = row.handoff as Record<string, unknown>
    if (typeof text !== 'string' || typeof at !== 'string') return null
    handoff = { text, at }
  }
  return {
    ordinal: row.ordinal,
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    endedAt: typeof row.endedAt === 'string' ? row.endedAt : null,
    engines,
    rulings: isStringList(row.rulings) ? row.rulings : [],
    retained: isStringList(row.retained) ? row.retained : [],
    corrected: isStringList(row.corrected) ? row.corrected : [],
    files: isStringList(row.files) ? row.files : [],
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    handoff,
    ...(typeof row.pid === 'number' && Number.isInteger(row.pid) && row.pid > 0 ? { pid: row.pid } : {}),
    ...(typeof row.procStart === 'string' && row.procStart !== '' ? { procStart: row.procStart } : {}),
  }
}

function ownProcessFields(): { pid: number; procStart?: string } {
  const pid = process.pid
  const token = process.platform === 'win32' ? null : getProcessStartToken(pid)
  return token === null || token === '' ? { pid } : { pid, procStart: token }
}

function rowProcessAlive(entry: LedgerEntry): boolean | null {
  if (entry.pid === undefined) return null
  if (!isProcessAlive(entry.pid)) return false
  if (entry.procStart === undefined) return true
  const current = getProcessStartToken(entry.pid)
  return current === null || current === entry.procStart
}

export interface LedgerFile {
  entries: LedgerEntry[]
  skipped: number
}

export function readLedgerFile(projectKey: string): LedgerFile {
  let raw: string
  try {
    raw = readFileSync(lineagePath(projectKey), 'utf8')
  } catch {
    return { entries: [], skipped: 0 }
  }
  const bySession = new Map<string, LedgerEntry>()
  let skipped = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let entry: LedgerEntry | null = null
    try {
      entry = asEntry(JSON.parse(line))
    } catch {
      entry = null
    }
    if (entry === null) {
      skipped++
      continue
    }
    bySession.delete(entry.sessionId)
    bySession.set(entry.sessionId, entry)
  }
  const entries = [...bySession.values()]
  entries.sort((a, b) => a.ordinal - b.ordinal)
  if (skipped > 0) logForDebugging(`lineage ledger for ${projectKey}: ${skipped} unreadable line(s) skipped`)
  return { entries, skipped }
}

export function readLedger(projectKey: string): LedgerEntry[] {
  return readLedgerFile(projectKey).entries
}

export function ledgerEntryOf(projectKey: string, sessionId: string): LedgerEntry | null {
  return readLedger(projectKey).find(entry => entry.sessionId === sessionId) ?? null
}

function appendLine(projectKey: string, entry: LedgerEntry): void {
  const path = lineagePath(projectKey)
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a+')
  try {
    const size = fstatSync(fd).size
    const last = Buffer.alloc(1)
    const separator = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10 ? '\n' : ''
    appendFileSync(fd, `${separator}${JSON.stringify(entry)}\n`, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function update(projectKey: string, sessionId: string, change: (entry: LedgerEntry, now: string) => LedgerEntry | null): LedgerEntry | null {
  const current = ledgerEntryOf(projectKey, sessionId)
  if (current === null) return null
  const next = change(current, ledgerClock())
  if (next === null) return current
  try {
    appendLine(projectKey, next)
  } catch (error) {
    logForDebugging(`lineage ledger write failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    return current
  }
  return next
}

export function openEntry(projectKey: string, session: { sessionId: string; model: string }): LedgerEntry {
  const existing = ledgerEntryOf(projectKey, session.sessionId)
  const now = ledgerClock()
  const { pid, procStart } = ownProcessFields()
  const entry: LedgerEntry =
    existing !== null
      ? {
          ...existing,
          endedAt: null,
          outcome: null,
          engines:
            existing.engines[existing.engines.length - 1]?.model === session.model
              ? existing.engines
              : [...existing.engines, { model: session.model, at: now }],
          pid,
          procStart,
        }
      : {
          ordinal: readLedger(projectKey).length + 1,
          sessionId: session.sessionId,
          startedAt: now,
          endedAt: null,
          engines: [{ model: session.model, at: now }],
          rulings: [],
          retained: [],
          corrected: [],
          files: [],
          outcome: null,
          handoff: null,
          pid,
          procStart,
        }
  try {
    appendLine(projectKey, entry)
  } catch (error) {
    logForDebugging(`lineage ledger open failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return entry
}

export function recordEngine(projectKey: string, sessionId: string, model: string): LedgerEntry | null {
  return update(projectKey, sessionId, (entry, now) => {
    if (entry.engines[entry.engines.length - 1]?.model === model) return null
    return { ...entry, engines: [...entry.engines, { model, at: now }] }
  })
}

export function recordRuling(projectKey: string, sessionId: string, rulingId: string): LedgerEntry | null {
  return update(projectKey, sessionId, entry => (entry.rulings.includes(rulingId) ? null : { ...entry, rulings: [...entry.rulings, rulingId] }))
}

export function recordFact(projectKey: string, sessionId: string, factId: string, kind: 'retained' | 'corrected'): LedgerEntry | null {
  return update(projectKey, sessionId, entry => {
    const list = entry[kind]
    if (list.includes(factId)) return null
    return { ...entry, [kind]: [...list, factId] }
  })
}

export function recordFile(projectKey: string, sessionId: string, path: string): LedgerEntry | null {
  return update(projectKey, sessionId, entry => {
    if (entry.files.includes(path) || entry.files.length >= LEDGER_FILES_CAP) return null
    return { ...entry, files: [...entry.files, path] }
  })
}

const clipHandoff = (text: string): string => (text.length > HANDOFF_TEXT_CAP ? text.slice(0, HANDOFF_TEXT_CAP) : text)

export function recordHandoff(projectKey: string, sessionId: string, text: string): LedgerEntry | null {
  if (text.trim() === '') return ledgerEntryOf(projectKey, sessionId)
  return update(projectKey, sessionId, (entry, now) => ({ ...entry, handoff: { text: clipHandoff(text), at: now } }))
}

export function closeEntry(projectKey: string, sessionId: string, close: { outcome: string; handoff?: string }): LedgerEntry | null {
  return update(projectKey, sessionId, (entry, now) => {
    const text = close.handoff ?? ''
    return {
      ...entry,
      endedAt: now,
      outcome: close.outcome,
      handoff: text.trim() !== '' ? { text: clipHandoff(text), at: now } : entry.handoff,
    }
  })
}

export const INTERRUPTED_OUTCOME = 'interrupted'

export function reconcileInterruptedEntries(projectKey: string, currentSessionId: string, cutAt: (sessionId: string) => string | null): LedgerEntry[] {
  const live = new Set(liveSessions(projectKey).map(session => session.sessionId))
  const bootAt = Date.now() - uptime() * 1000
  const reconciled: LedgerEntry[] = []
  for (const entry of readLedger(projectKey)) {
    if (entry.endedAt !== null || entry.sessionId === currentSessionId || live.has(entry.sessionId)) continue
    const alive = rowProcessAlive(entry)
    if (alive === true) continue
    const at = cutAt(entry.sessionId)
    if (at === null) continue
    if (alive === null && !(Date.parse(at) < bootAt)) continue
    const next = update(projectKey, entry.sessionId, current => (current.endedAt !== null ? null : { ...current, endedAt: at, outcome: INTERRUPTED_OUTCOME }))
    if (next !== null && next.outcome === INTERRUPTED_OUTCOME && next.endedAt === at) reconciled.push(next)
  }
  return reconciled
}

interface WorkerRow {
  sessionId?: unknown
  workspaceId?: unknown
  pid?: unknown
  procStart?: unknown
  spawnedAt?: unknown
  endedAt?: unknown
  attachedAt?: unknown
}

export function sessionWorkersFile(): string {
  return join(daemonDir(), 'concourse-workers.json')
}

export function liveSessions(projectKey: string): LiveSession[] {
  let workers: Record<string, WorkerRow>
  try {
    const parsed = JSON.parse(readFileSync(sessionWorkersFile(), 'utf8')) as { version?: unknown; workers?: unknown }
    if (parsed?.version !== 1 || typeof parsed.workers !== 'object' || parsed.workers === null) return []
    workers = parsed.workers as Record<string, WorkerRow>
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const row of Object.values(workers)) {
    if (typeof row.sessionId !== 'string' || typeof row.workspaceId !== 'string') continue
    if (row.endedAt !== undefined || row.attachedAt !== undefined) continue
    if (typeof row.pid !== 'number' || !workerPidAlive({ pid: row.pid, procStart: typeof row.procStart === 'string' ? row.procStart : undefined })) continue
    if (mnemeProjectKeyFor(row.workspaceId) !== projectKey) continue
    const spawnedAt = typeof row.spawnedAt === 'number' ? new Date(row.spawnedAt).toISOString() : ''
    out.push({ sessionId: row.sessionId, startedAt: spawnedAt })
  }
  out.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return out
}

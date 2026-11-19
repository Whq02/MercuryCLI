import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonHomeStands, publishInDaemonHome } from '../daemonHome.js'
import { observeSessionStates } from '../sessionStateHooks.js'
import { daemonDir } from '../controlSocket.js'
import { type ConcourseWorkerRecordV1, sessionActivityOf, turnInFlightOf } from './record.js'
import { canonicalWorkspaceId } from './admission.js'
import { withDaemonStoreLock } from './storeLock.js'

interface ConcourseWorkerFileV1 {
  version: 1
  workers: Record<string, ConcourseWorkerRecordV1>
}

export function concourseWorkersPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-workers.json')
}

export function readSessionWorkers(dir?: string): Record<string, ConcourseWorkerRecordV1> {
  const snapshot = readSessionWorkersSnapshot(dir)
  return snapshot.state === 'known' ? snapshot.workers : {}
}

export type SessionWorkersSnapshot =
  | { state: 'known'; workers: Record<string, ConcourseWorkerRecordV1> }
  | { state: 'unavailable' }

function freezeWorkersDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeWorkersDeep(child)
  }
  return value
}

const EMPTY_SESSION_WORKERS: SessionWorkersSnapshot = freezeWorkersDeep({ state: 'known', workers: {} })

const UNAVAILABLE_SESSION_WORKERS: SessionWorkersSnapshot = freezeWorkersDeep({ state: 'unavailable' })

const workersSnapshotMemo = new Map<string, { fp: string; snapshot: SessionWorkersSnapshot }>()

function workersStatFingerprint(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent'
    return null
  }
}

function readMutableSessionWorkersFromDisk(
  path: string,
): { kind: 'known'; workers: Record<string, ConcourseWorkerRecordV1> } | { kind: 'absent' } | { kind: 'unavailable'; why: string } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ConcourseWorkerFileV1
    if (!raw || raw.version !== 1 || typeof raw.workers !== 'object' || raw.workers === null || Array.isArray(raw.workers)) {
      return { kind: 'unavailable', why: 'it is not a version 1 session file' }
    }
    for (const rec of Object.values(raw.workers)) {
      const legacy = rec as ConcourseWorkerRecordV1 & { workerId?: string }
      if (legacy.runnerId === undefined && typeof legacy.workerId === 'string') {
        legacy.runnerId = legacy.workerId
      }
      delete legacy.workerId
      if (typeof rec.workspaceId === 'string') rec.workspaceId = canonicalWorkspaceId(rec.workspaceId)
    }
    return { kind: 'known', workers: raw.workers }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unavailable', why: error instanceof SyntaxError ? 'it is not valid JSON' : (code ?? (error instanceof Error ? error.message : String(error))) }
  }
}

export function readSessionWorkersSnapshot(dir?: string): SessionWorkersSnapshot {
  const path = concourseWorkersPath(dir)
  const fp = workersStatFingerprint(path)
  if (fp === null) {
    workersSnapshotMemo.delete(path)
    return UNAVAILABLE_SESSION_WORKERS
  }
  const hit = workersSnapshotMemo.get(path)
  if (hit !== undefined && hit.fp === fp) return hit.snapshot
  if (fp === 'absent') {
    workersSnapshotMemo.set(path, { fp: 'absent', snapshot: EMPTY_SESSION_WORKERS })
    return EMPTY_SESSION_WORKERS
  }
  const parsed = readMutableSessionWorkersFromDisk(path)
  if (parsed.kind === 'absent') {
    workersSnapshotMemo.delete(path)
    return EMPTY_SESSION_WORKERS
  }
  if (parsed.kind === 'unavailable') {
    workersSnapshotMemo.delete(path)
    return UNAVAILABLE_SESSION_WORKERS
  }
  const snapshot: SessionWorkersSnapshot = freezeWorkersDeep({ state: 'known', workers: parsed.workers })
  workersSnapshotMemo.set(path, { fp, snapshot })
  return snapshot
}

export function concourseDeltaPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-delta.json')
}

export interface ConcourseDeltaStampV1 {
  version: 1
  revision: number
  pid: number
  at: number
}

let concourseDeltaRevision = 0

function stampConcourseDelta(dir?: string): void {
  try {
    if (!daemonHomeStands('the delta stamp', dir)) return
    concourseDeltaRevision += 1
    publishInDaemonHome(
      'the delta stamp',
      concourseDeltaPath(dir),
      `${JSON.stringify({ version: 1, revision: concourseDeltaRevision, pid: process.pid, at: Date.now() } satisfies ConcourseDeltaStampV1)}\n`,
      { dir },
    )
  } catch {
  }
}

function publishConcourseWorkers(workers: Record<string, ConcourseWorkerRecordV1>, dir?: string): void {
  for (const rec of Object.values(workers)) {
    if (rec.activity === undefined) rec.activity = sessionActivityOf(turnInFlightOf(rec), undefined, 0, rec.lastTurnSettledAt ?? null)
    if (rec.endedAt !== undefined || rec.stoppedAt !== undefined || rec.parkedAt !== undefined || (rec.crash !== undefined && !rec.crash.respawning)) {
      rec.activity = sessionActivityOf(false, [], 0, rec.activity.lastTurnAt)
    }
  }
  if (!daemonHomeStands('the session records', dir)) return
  publishInDaemonHome(
    'the session records',
    concourseWorkersPath(dir),
    `${JSON.stringify({ version: 1, workers } satisfies ConcourseWorkerFileV1, null, 1)}\n`,
    { dir },
  )
  stampConcourseDelta(dir)
}

let sessionRecordsInFlight: { path: string; workers: Record<string, ConcourseWorkerRecordV1> } | null = null

const sessionRecordsUnread = new Map<string, { why: string; refused: number }>()

function sessionRecordsRefusal(path: string, why: string): Error {
  const unread = sessionRecordsUnread.get(path)
  if (unread === undefined || unread.why !== why) {
    console.error(`[daemon] ${path}: the session records are there and could not be read (${why}), so changes to them are refused and the file is left as it stands — make it readable, or move it away and the next change writes a new one`)
  }
  sessionRecordsUnread.set(path, { why, refused: (unread?.refused ?? 0) + 1 })
  return new Error(`the session records at ${path} were not updated: the file is there and could not be read (${why}); nothing was written`)
}

function noteSessionRecordsRead(path: string): void {
  const unread = sessionRecordsUnread.get(path)
  if (unread === undefined) return
  sessionRecordsUnread.delete(path)
  console.error(`[daemon] ${path}: the session records read again; ${unread.refused} change(s) were refused meanwhile`)
}

export function updateConcourseWorkers(
  mutate: (workers: Record<string, ConcourseWorkerRecordV1>) => void,
  dir?: string,
): Record<string, ConcourseWorkerRecordV1> {
  const path = concourseWorkersPath(dir)
  if (sessionRecordsInFlight !== null && sessionRecordsInFlight.path === path) {
    mutate(sessionRecordsInFlight.workers)
    return sessionRecordsInFlight.workers
  }
  const workers = withDaemonStoreLock('the session records', path, dir, ({ assertStillHeld }) => {
    const fresh = readMutableSessionWorkersFromDisk(path)
    if (fresh.kind === 'unavailable') throw sessionRecordsRefusal(path, fresh.why)
    noteSessionRecordsRead(path)
    const next = fresh.kind === 'known' ? fresh.workers : {}
    const outer = sessionRecordsInFlight
    sessionRecordsInFlight = { path, workers: next }
    try {
      mutate(next)
    } finally {
      sessionRecordsInFlight = outer
    }
    assertStillHeld()
    publishConcourseWorkers(next, dir)
    return next
  })
  observeSessionStates(workers)
  return workers
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonHomeStands, publishInDaemonHome } from '../control/daemonHome.js'
import { observeSessionStates } from '../session-seat/sessionStateHooks.js'
import { daemonDir } from '../control/controlSocket.js'
import { type ConcourseWorkerRecordV1, sessionActivityOf, turnInFlightOf } from './record.js'
import { canonicalWorkspaceId } from './admission.js'
import { withDaemonStoreLock } from './storeLock.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { sleep } from '../../platform/async/sleep.js'
import { HELD_FILE_PATIENT_RETRY_DELAYS_MS, HELD_FILE_RETRY_DELAYS_MS } from '../../platform/host-os/files.js'
import { DurablePublishError } from '../../platform/substrate/durablePublish.js'
import { defineStore } from '../../platform/substrate/fileStore.js'
import { statFingerprint } from '../../platform/substrate/startupMenu.js'

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

function readMutableSessionWorkersFromDisk(
  path: string,
): { kind: 'known'; workers: Record<string, ConcourseWorkerRecordV1> } | { kind: 'absent' } | { kind: 'unavailable'; why: string } | { kind: 'unusable'; why: string } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ConcourseWorkerFileV1
    if (!raw || raw.version !== 1 || typeof raw.workers !== 'object' || raw.workers === null || Array.isArray(raw.workers) || Object.values(raw.workers).some(rec => typeof rec !== 'object' || rec === null)) {
      return { kind: 'unusable', why: 'it is not a version 1 session file' }
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
    if (error instanceof SyntaxError) return { kind: 'unusable', why: 'it is not valid JSON' }
    return { kind: 'unavailable', why: code ?? (error instanceof Error ? error.message : String(error)) }
  }
}

export function readSessionWorkersSnapshot(dir?: string): SessionWorkersSnapshot {
  const path = concourseWorkersPath(dir)
  const fp = statFingerprint(path)
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
  if (parsed.kind === 'unavailable' || parsed.kind === 'unusable') {
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

const concourseWorkersStore = defineStore<ConcourseWorkerFileV1, [dir?: string]>({
  name: 'concourse-workers',
  path: (dir?: string) => concourseWorkersPath(dir),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const file = raw as Partial<ConcourseWorkerFileV1>
    if (file.version !== 1 || typeof file.workers !== 'object' || file.workers === null || Array.isArray(file.workers)) {
      return null
    }
    return file as ConcourseWorkerFileV1
  },
  empty: () => ({ version: 1, workers: {} }),
  onReadFailure: 'empty',
})

const concourseDeltaStore = defineStore<ConcourseDeltaStampV1, [dir?: string]>({
  name: 'concourse-delta',
  path: (dir?: string) => concourseDeltaPath(dir),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const stamp = raw as Partial<ConcourseDeltaStampV1>
    if (stamp.version !== 1 || typeof stamp.revision !== 'number' || typeof stamp.pid !== 'number') return null
    return stamp as ConcourseDeltaStampV1
  },
  empty: () => ({ version: 1, revision: 0, pid: 0, at: 0 }),
  onReadFailure: 'empty',
})

export function subscribeConcourseWorkers(cb: () => void, dir?: string): () => void {
  return concourseWorkersStore(dir).subscribe(() => cb(), { immediate: false })
}

export function subscribeConcourseDelta(cb: () => void, dir?: string): () => void {
  return concourseDeltaStore(dir).subscribe(() => cb(), { immediate: false })
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
  } catch (error) {
    passedOver(error)
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
  const path = concourseWorkersPath(dir)
  const text = `${JSON.stringify({ version: 1, workers } satisfies ConcourseWorkerFileV1, null, 1)}\n`
  if (publishInDaemonHome('the session records', path, text, { dir }) === 'published') sessionRecordsLastPublished.set(path, text)
  stampConcourseDelta(dir)
}

const sessionRecordsLastPublished = new Map<string, string>()

const unstampedRunnerPids = new Map<string, Map<string, { pid: number; procStart?: string }>>()

export function rememberUnstampedRunnerPid(runnerId: string, fields: { pid?: number; procStart?: string }, dir?: string): void {
  if (fields.pid === undefined) return
  const path = concourseWorkersPath(dir)
  const pending = unstampedRunnerPids.get(path) ?? new Map<string, { pid: number; procStart?: string }>()
  pending.set(runnerId, { pid: fields.pid, ...(fields.procStart !== undefined ? { procStart: fields.procStart } : {}) })
  unstampedRunnerPids.set(path, pending)
}

function stampRememberedRunnerPids(path: string, workers: Record<string, ConcourseWorkerRecordV1>): void {
  const pending = unstampedRunnerPids.get(path)
  if (pending === undefined) return
  const { workerPidAlive } = require('./workerIdentity.js') as typeof import('./workerIdentity.js')
  for (const [runnerId, fields] of pending) {
    const rec = workers[runnerId]
    if (rec === undefined || rec.endedAt !== undefined || !workerPidAlive(fields)) continue
    rec.pid = fields.pid
    if (fields.procStart !== undefined) rec.procStart = fields.procStart
    else delete rec.procStart
    rec.lastLiveAt = Date.now()
  }
}

function liveSessionRecordsLastPublished(path: string): Record<string, ConcourseWorkerRecordV1> {
  const text = sessionRecordsLastPublished.get(path)
  if (text === undefined) return {}
  const { workerPidAlive } = require('./workerIdentity.js') as typeof import('./workerIdentity.js')
  const held = (JSON.parse(text) as ConcourseWorkerFileV1).workers
  stampRememberedRunnerPids(path, held)
  const live: Record<string, ConcourseWorkerRecordV1> = {}
  for (const [runnerId, rec] of Object.entries(held)) {
    if (rec.endedAt === undefined && (rec.attachedAt !== undefined || workerPidAlive(rec))) live[runnerId] = rec
  }
  return live
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

export function unreadSessionRecordsRefusal(dir?: string): Error | null {
  const path = concourseWorkersPath(dir)
  const fresh = readMutableSessionWorkersFromDisk(path)
  return fresh.kind === 'unavailable' ? sessionRecordsRefusal(path, fresh.why) : null
}

const sessionRecordsUnwritten = new Set<string>()

export function unwrittenSessionRecordsRefusal(dir?: string): Error | null {
  const path = concourseWorkersPath(dir)
  const fresh = readMutableSessionWorkersFromDisk(path)
  if (fresh.kind === 'unavailable') return sessionRecordsRefusal(path, fresh.why)
  if (fresh.kind !== 'unusable' && !sessionRecordsUnwritten.has(path)) return null
  try {
    updateConcourseWorkers(() => {}, dir)
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

function keepUnusedSessionRecordsAside(path: string, why: string): Record<string, ConcourseWorkerRecordV1> {
  const { keepDamagedFileAsideSync } = require('../../platform/substrate/storeRecovery.js') as typeof import('../../platform/substrate/storeRecovery.js')
  let aside: string
  try {
    aside = keepDamagedFileAsideSync({ store: 'concourse-workers', path, reason: why, by: 'rename', asideAt: stamp => `${path}.corrupt.${stamp}` })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))
    throw new Error(`the session records at ${path} were not updated: the file could not be used (${why}) and could not be kept aside (${code}); nothing was written`)
  }
  const live = liveSessionRecordsLastPublished(path)
  const held = Object.keys(live)
  console.error(
    held.length === 0
      ? `[daemon] ${path}: the session records could not be used (${why}); the file is kept aside at ${aside} as it stood, and the new file starts with no session, no live session's record being held in memory; what the file held is in the kept file only`
      : `[daemon] ${path}: the session records could not be used (${why}); the file is kept aside at ${aside} as it stood, and the new file starts from the records held in memory of the ${held.length} live session(s) (${held.join(', ')}); what the file held of any other session is in the kept file only`,
  )
  return live
}

function noteSessionRecordsRead(path: string): void {
  const unread = sessionRecordsUnread.get(path)
  if (unread === undefined) return
  sessionRecordsUnread.delete(path)
  console.error(`[daemon] ${path}: the session records read again; changes to them were refused ${unread.refused} time(s) meanwhile`)
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
  sessionRecordsUnwritten.add(path)
  const workers = withDaemonStoreLock('the session records', path, dir, ({ assertStillHeld }) => {
    const fresh = readMutableSessionWorkersFromDisk(path)
    if (fresh.kind === 'unavailable') throw sessionRecordsRefusal(path, fresh.why)
    const next = fresh.kind === 'known' ? fresh.workers : fresh.kind === 'unusable' ? keepUnusedSessionRecordsAside(path, fresh.why) : {}
    if (fresh.kind === 'known') stampRememberedRunnerPids(path, next)
    noteSessionRecordsRead(path)
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
  sessionRecordsUnwritten.delete(path)
  unstampedRunnerPids.delete(path)
  observeSessionStates(workers)
  return workers
}

async function rideOutRefusedSave(
  mutate: (workers: Record<string, ConcourseWorkerRecordV1>) => void,
  dir: string | undefined,
  refused: DurablePublishError,
): Promise<void> {
  let last = refused
  for (const wait of HELD_FILE_PATIENT_RETRY_DELAYS_MS.slice(HELD_FILE_RETRY_DELAYS_MS.length)) {
    await sleep(wait)
    try {
      updateConcourseWorkers(mutate, dir)
      return
    } catch (error) {
      if (!(error instanceof DurablePublishError)) throw error
      last = error
    }
  }
  throw last
}

export async function updateConcourseWorkersRidingOut(
  mutate: (workers: Record<string, ConcourseWorkerRecordV1>) => void,
  dir?: string,
): Promise<void> {
  try {
    updateConcourseWorkers(mutate, dir)
  } catch (error) {
    if (!(error instanceof DurablePublishError)) throw error
    await rideOutRefusedSave(mutate, dir, error)
  }
}

export function updateConcourseWorkersOrHold(
  mutate: (workers: Record<string, ConcourseWorkerRecordV1>) => void,
  dir?: string,
): void {
  try {
    updateConcourseWorkers(mutate, dir)
  } catch (error) {
    if (!(error instanceof DurablePublishError)) throw error
    void rideOutRefusedSave(mutate, dir, error).catch(lost => {
      console.error(`[daemon] ${concourseWorkersPath(dir)}: a change to the session records was held in memory and never saved, so the records keep what they said before it: ${errorMessage(lost)}`)
    })
  }
}

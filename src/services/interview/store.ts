
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'
import {
  emptyInterviewState,
  foldInterviewShared,
  rebuildInterview,
  rebuildInterviewFrom,
  INTERVIEW_SCHEMA_VERSION,
  type InterviewEvent,
  type InterviewSessionId,
  type InterviewSessionState,
} from './contracts.js'

const MAX_SESSIONS = 10
const SAVE_DEBOUNCE_MS = 150

const SESSION_EVENT_COMPACT_THRESHOLD = 400
const SESSION_COMPACT_TAIL_KEEP = 100

type SerializedInterviewState = Omit<InterviewSessionState, 'seenEventIds'> & {
  seenEventIds: string[]
}

interface SessionCheckpoint {
  v: 1
  state: SerializedInterviewState
  sealedCount: number
}

interface SessionEntry {
  events: InterviewEvent[]
  updatedAtMs: number
  checkpoint?: SessionCheckpoint
}

interface InterviewLogFile {
  sessions: Record<string, SessionEntry>
}

function serializeSealedState(s: InterviewSessionState): SerializedInterviewState {
  return { ...s, seenEventIds: [] }
}

function stateFromCheckpoint(cp: SessionCheckpoint): InterviewSessionState {
  return { ...cp.state, seenEventIds: new Set(cp.state.seenEventIds) }
}

function rebuildEntry(entry: SessionEntry): InterviewSessionState {
  return entry.checkpoint
    ? rebuildInterviewFrom(stateFromCheckpoint(entry.checkpoint), entry.events)
    : rebuildInterview(entry.events)
}

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

const interviewStore = defineStore<InterviewLogFile>({
  name: 'interview-sessions',
  path: () => join(getMercuryHome(), 'interview', `${projectKey()}.json`),
  schemaVersion: INTERVIEW_SCHEMA_VERSION,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const sessions = (raw as { sessions?: unknown }).sessions
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return { sessions: {} }
    const out: InterviewLogFile = { sessions: {} }
    for (const [id, entry] of Object.entries(sessions as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as { events?: unknown; updatedAtMs?: unknown; checkpoint?: unknown }
      if (!Array.isArray(e.events)) continue
      const cp = e.checkpoint as SessionCheckpoint | undefined
      out.sessions[id] = {
        events: e.events as InterviewEvent[],
        updatedAtMs: typeof e.updatedAtMs === 'number' ? e.updatedAtMs : 0,
        ...(cp && typeof cp === 'object' && cp.v === 1 && cp.state ? { checkpoint: cp } : {}),
      }
    }
    return out
  },
  empty: () => ({ sessions: {} }),
  onReadFailure: 'empty',
})


let liveEvents: InterviewEvent[] = []
let liveState: InterviewSessionState = emptyInterviewState()
const listeners = new Set<() => void>()


export interface InterviewSettlement {
  sessionId: InterviewSessionId
  generation: number
  state: 'settled' | 'degraded'
  error?: string
  atMs: number
}

export interface InterviewFlushReceipt {
  drained: number
  settlements: InterviewSettlement[]
  allSettled: boolean
}

interface PendingPersist {
  timer: ReturnType<typeof setTimeout> | null
  events: InterviewEvent[]
  generation: number
  degraded?: InterviewSettlement
  inflight?: Promise<InterviewSettlement>
}

const pendingBySession = new Map<InterviewSessionId, PendingPersist>()
let lastDegradedSettlement: InterviewSettlement | null = null
let adoptDegradeRecorded = false

const liveCheckpoints = new Map<InterviewSessionId, SessionCheckpoint>()
function noteLiveCheckpoint(sessionId: InterviewSessionId, cp: SessionCheckpoint): void {
  liveCheckpoints.delete(sessionId)
  liveCheckpoints.set(sessionId, cp)
  if (liveCheckpoints.size > MAX_SESSIONS) {
    for (const key of liveCheckpoints.keys()) {
      if (key === sessionId || pendingBySession.has(key)) continue
      liveCheckpoints.delete(key)
      break
    }
  }
}

function pendingStateFor(sessionId: InterviewSessionId, events: readonly InterviewEvent[]): InterviewSessionState {
  const base = liveCheckpoints.get(sessionId)
  return base ? rebuildInterviewFrom(stateFromCheckpoint(base), events) : rebuildInterview(events)
}

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch (e) {
      logError(`interview listener threw: ${e}`)
    }
  }
}

let cleanupRegistered = false
function ensureFlushOnShutdown(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  registerCleanup(async () => {
    const receipt = await flushInterviewLog()
    if (!receipt.allSettled) {
      const degraded = receipt.settlements.filter(s => s.state === 'degraded')
      logError(
        `interview shutdown drain DEGRADED for ${degraded.length}/${receipt.drained} identit${degraded.length === 1 ? 'y' : 'ies'}: ${degraded.map(s => `${s.sessionId}@g${s.generation} (${s.error})`).join('; ')}`,
      )
    }
  })
}

function scheduleSave(): void {
  const sessionId = liveState.sessionId
  if (!sessionId) return
  ensureFlushOnShutdown()
  const entry: PendingPersist = pendingBySession.get(sessionId) ?? {
    timer: null,
    events: liveEvents,
    generation: 0,
  }
  if (entry.timer) clearTimeout(entry.timer)
  entry.events = liveEvents
  entry.generation += 1
  entry.timer = setTimeout(() => {
    entry.timer = null
    void persistEntry(sessionId, entry)
  }, SAVE_DEBOUNCE_MS)
  entry.timer.unref?.()
  pendingBySession.set(sessionId, entry)
  if (pendingBySession.size > MAX_SESSIONS) {
    const oldest = [...pendingBySession.entries()]
      .filter(([id, e]) => id !== sessionId && e.timer === null && e.degraded)
      .sort((a, b) => (a[1].degraded?.atMs ?? 0) - (b[1].degraded?.atMs ?? 0))[0]
    if (oldest) {
      pendingBySession.delete(oldest[0])
      logError(
        `interview pending-persist cap: evicted the oldest degraded identity ${oldest[0]}@g${oldest[1].generation} (${oldest[1].degraded?.error})`,
      )
    }
  }
}

function persistEntry(sessionId: InterviewSessionId, entry: PendingPersist): Promise<InterviewSettlement> {
  const prev = entry.inflight ?? Promise.resolve(null)
  const run = prev.then(async (): Promise<InterviewSettlement> => {
    const generation = entry.generation
    const events = entry.events
    try {
      let sealedNow = 0
      let newCheckpoint: SessionCheckpoint | undefined
      await interviewStore().mutate(current => {
        const prior = current.sessions[sessionId]
        let checkpoint = prior?.checkpoint
        let retained = events
        if (events.length > SESSION_EVENT_COMPACT_THRESHOLD) {
          const sealCount = events.length - SESSION_COMPACT_TAIL_KEEP
          const base = checkpoint ? stateFromCheckpoint(checkpoint) : emptyInterviewState()
          const sealedState = rebuildInterviewFrom(base, events.slice(0, sealCount))
          checkpoint = {
            v: 1,
            state: serializeSealedState(sealedState),
            sealedCount: (checkpoint?.sealedCount ?? 0) + sealCount,
          }
          newCheckpoint = checkpoint
          retained = events.slice(sealCount)
          sealedNow = sealCount
        }
        const entryOut: SessionEntry = {
          events: retained,
          updatedAtMs: Date.now(),
          ...(checkpoint ? { checkpoint } : {}),
        }
        const sessions = { ...current.sessions, [sessionId]: entryOut }
        const ids = Object.keys(sessions).sort(
          (a, b) => (sessions[b]?.updatedAtMs ?? 0) - (sessions[a]?.updatedAtMs ?? 0),
        )
        for (const stale of ids.slice(MAX_SESSIONS)) delete sessions[stale]
        return { sessions }
      })
      if (sealedNow > 0) {
        events.splice(0, sealedNow)
        if (newCheckpoint) noteLiveCheckpoint(sessionId, newCheckpoint)
      }
      const settlement: InterviewSettlement = { sessionId, generation, state: 'settled', atMs: Date.now() }
      const cur = pendingBySession.get(sessionId)
      if (cur === entry) {
        if (cur.generation === generation && cur.timer === null) pendingBySession.delete(sessionId)
        else delete cur.degraded
      }
      return settlement
    } catch (e) {
      const settlement: InterviewSettlement = {
        sessionId,
        generation,
        state: 'degraded',
        error: String(e),
        atMs: Date.now(),
      }
      const cur = pendingBySession.get(sessionId)
      if (cur === entry) cur.degraded = settlement
      lastDegradedSettlement = settlement
      logError(`interview persist degraded (${sessionId}@g${generation}): ${e}`)
      return settlement
    } finally {
      if (entry.inflight === run) entry.inflight = undefined
    }
  })
  entry.inflight = run
  return run
}

export async function flushInterviewLog(): Promise<InterviewFlushReceipt> {
  const jobs: Array<Promise<InterviewSettlement>> = []
  for (const [sessionId, entry] of [...pendingBySession]) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    jobs.push(persistEntry(sessionId, entry))
  }
  const settlements = await Promise.all(jobs)
  return {
    drained: settlements.length,
    settlements,
    allSettled: settlements.every(s => s.state === 'settled'),
  }
}

export function interviewPersistenceHealth(): {
  pendingIdentities: number
  degradedIdentities: number
  lastDegraded: InterviewSettlement | null
} {
  let degraded = 0
  for (const entry of pendingBySession.values()) if (entry.degraded) degraded++
  return {
    pendingIdentities: pendingBySession.size,
    degradedIdentities: degraded,
    lastDegraded: lastDegradedSettlement,
  }
}


export function mintInterviewId(prefix: 'is' | 'iq' | 'id' | 'io' | 'ie' | 'ir'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}


export function appendInterviewEvent(event: InterviewEvent): InterviewSessionState {
  const next = foldInterviewShared(liveState, event, liveState.seenEventIds as Set<string>)
  if (next !== liveState) {
    liveEvents.push(event)
    liveState = next
    scheduleSave()
    notify()
  }
  return liveState
}

export function openInterviewSession(init: {
  mission: string
  sessionId?: InterviewSessionId
  toolUseId?: string
  atMs?: number
}): InterviewSessionId {
  const sessionId = init.sessionId ?? mintInterviewId('is')
  liveEvents = []
  liveState = emptyInterviewState()
  appendInterviewEvent({
    kind: 'session-opened',
    eventId: mintInterviewId('ie'),
    atMs: init.atMs ?? Date.now(),
    sessionId,
    mission: init.mission,
    toolUseId: init.toolUseId,
  })
  return sessionId
}

export function interviewSnapshot(): InterviewSessionState {
  return liveState
}

export function currentInterviewRef(): string | null {
  const s = liveState
  if (s.sessionId === null || s.phase === 'completed' || s.phase === 'cancelled') return null
  const focusedQid = s.discussing ?? (s.focus && s.focus !== 'review' ? s.focus : null)
  const decisionId = focusedQid ? s.questions[focusedQid]?.question.decisionId : undefined
  return decisionId
    ? `mercury://interview/${s.sessionId}/${decisionId}`
    : `mercury://interview/${s.sessionId}`
}

export function interviewEvents(): readonly InterviewEvent[] {
  return liveEvents
}

export function subscribeInterview(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function adoptDurableSessionSync(keys: {
  toolUseId?: string
  declaredIds?: readonly string[]
}): boolean {
  if (liveState.sessionId !== null) return false
  if (!keys.toolUseId && !(keys.declaredIds && keys.declaredIds.length > 0)) return false
  {
    const declared = new Set(keys.declaredIds ?? [])
    for (const [pendingId, entry] of pendingBySession) {
      if (entry.inflight) continue
      const state = pendingStateFor(pendingId, entry.events)
      const open =
        state.phase === 'asking' || state.phase === 'discussing' || state.phase === 'reviewing'
      if (!open) continue
      const byToolUse = keys.toolUseId !== undefined && state.toolUseId === keys.toolUseId
      const byDeclared =
        declared.size > 0 &&
        state.questionOrder.some(qid => {
          const q = state.questions[qid]?.question
          return !!q && (declared.has(q.id) || declared.has(q.decisionId))
        })
      if (!byToolUse && !byDeclared) continue
      liveEvents = [...entry.events]
      liveState = state
      notify()
      return true
    }
  }
  let file: InterviewLogFile
  const adoptPath = join(getMercuryHome(), 'interview', `${projectKey()}.json`)
  try {
    const raw = JSON.parse(readFileSync(adoptPath, 'utf8')) as { data?: unknown }
    const decoded =
      (raw && typeof raw === 'object' && 'sessions' in raw ? raw : (raw.data ?? null)) ?? null
    const sessions = (decoded as { sessions?: unknown } | null)?.sessions
    if (!sessions || typeof sessions !== 'object') return false
    file = { sessions: {} }
    for (const [id, entry] of Object.entries(sessions as Record<string, unknown>)) {
      const e = entry as { events?: unknown; updatedAtMs?: unknown }
      if (!Array.isArray(e?.events)) continue
      const cp = (e as { checkpoint?: unknown }).checkpoint as SessionCheckpoint | undefined
      file.sessions[id] = {
        events: e.events as InterviewEvent[],
        updatedAtMs: typeof e.updatedAtMs === 'number' ? e.updatedAtMs : 0,
        ...(cp && typeof cp === 'object' && cp.v === 1 && cp.state ? { checkpoint: cp } : {}),
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT' && !adoptDegradeRecorded) {
      adoptDegradeRecorded = true
      void import('../../substrate/storeRecovery.js')
        .then(m =>
          m.recordStoreReadDegradation({
            store: 'interview-sessions',
            path: adoptPath,
            reason: String(e),
          }),
        )
        .catch(() => {})
    }
    return false
  }
  const candidates = Object.entries(file.sessions).sort(
    (a, b) => b[1].updatedAtMs - a[1].updatedAtMs,
  )
  const declared = new Set(keys.declaredIds ?? [])
  for (const [adoptId, entry] of candidates) {
    const state = rebuildEntry(entry)
    const open =
      state.phase === 'asking' || state.phase === 'discussing' || state.phase === 'reviewing'
    if (!open) continue
    const byToolUse = keys.toolUseId !== undefined && state.toolUseId === keys.toolUseId
    const byDeclared =
      declared.size > 0 &&
      state.questionOrder.some(qid => {
        const q = state.questions[qid]?.question
        return !!q && (declared.has(q.id) || declared.has(q.decisionId))
      })
    if (!byToolUse && !byDeclared) continue
    if (entry.checkpoint) noteLiveCheckpoint(adoptId, entry.checkpoint)
    liveEvents = [...entry.events]
    liveState = state
    notify()
    return true
  }
  return false
}

export async function resumeInterviewSession(sessionId: InterviewSessionId): Promise<boolean> {
  const inflight = pendingBySession.get(sessionId)?.inflight
  if (inflight) await inflight
  const pending = pendingBySession.get(sessionId)
  if (pending) {
    liveEvents = [...pending.events]
    liveState = pendingStateFor(sessionId, liveEvents)
    notify()
    return true
  }
  const file = await interviewStore().read()
  const entry = file.sessions[sessionId]
  if (!entry) return false
  if (entry.checkpoint) noteLiveCheckpoint(sessionId, entry.checkpoint)
  else liveCheckpoints.delete(sessionId)
  liveEvents = [...entry.events]
  liveState = rebuildEntry({ ...entry, events: liveEvents })
  notify()
  return true
}

export async function listInterviewSessions(): Promise<
  { sessionId: string; updatedAtMs: number; state: InterviewSessionState }[]
> {
  const file = await interviewStore().read()
  return Object.entries(file.sessions)
    .map(([sessionId, e]) => ({
      sessionId,
      updatedAtMs: e.updatedAtMs,
      state: rebuildEntry(e),
    }))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

export function _resetInterviewForProofs(): void {
  for (const entry of pendingBySession.values()) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
  }
  pendingBySession.clear()
  liveCheckpoints.clear()
  lastDegradedSettlement = null
  adoptDegradeRecorded = false
  liveEvents = []
  liveState = emptyInterviewState()
  listeners.clear()
}

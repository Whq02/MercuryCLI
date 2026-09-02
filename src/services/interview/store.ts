/**
 * The ONE live interview-session authority — the pure fold (contracts.ts)
 * behind a stable-reference snapshot, with a durable per-project event log.
 *
 * ARCHITECTURE (the attention-store idiom, adapted):
 *   - IN-PROCESS LIVE STATE: the interactive process that presented the
 *     interview owns the live session. Reads return the SAME snapshot object
 *     until an event actually folded (useSyncExternalStore-safe, never an
 *     await). Cross-process readers rebuild from the durable log — nothing
 *     arms this store in a bridge process.
 *   - DURABLE EVENT LOG: every appended event write-throughs (debounced) to
 *     the substrate fileStore (atomic publish, locking, recovery) under
 *     interview/<projectKey>.json, capped to the most recent sessions.
 *     Restart-safe by construction: state is always rebuildInterview(log).
 *   - IDENTITY MINTING: ids are minted HERE, once, at presentation — or
 *     adopted verbatim when the asking side declares them. Nothing ever
 *     derives identity from display text.
 */

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

/** Most-recent interview sessions retained per project. */
const MAX_SESSIONS = 10
const SAVE_DEBOUNCE_MS = 150

// ── the per-session event bound ─────────────────────────
// MAX_SESSIONS caps sessions; THESE cap events WITHIN a session: once a
// session's retained tail exceeds the threshold, the prefix folds into a
// versioned CHECKPOINT (the folded state itself — decision identity,
// committed history, priorCommits, notes and context all preserved by
// construction) and only the tail stays as events. Rebuild = fold(checkpoint
// state, tail) — O(tail). The checkpoint seals the prefix's event identities
// (their ids leave the live receipt set with it; the controller mints fresh
// ids and never re-emits sealed ones — recorded boundary).
const SESSION_EVENT_COMPACT_THRESHOLD = 400
const SESSION_COMPACT_TAIL_KEEP = 100

/** The serialized checkpoint state (the receipt set rides as an array). */
type SerializedInterviewState = Omit<InterviewSessionState, 'seenEventIds'> & {
  seenEventIds: string[]
}

interface SessionCheckpoint {
  v: 1
  state: SerializedInterviewState
  /** Total events sealed across all compactions (accounting). */
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

/** Checkpoints persist an EMPTY receipt set (THE SEAL LAW): the sealed
 *  prefix's event-identity space is CLOSED — the controller mints fresh ids
 *  and never re-emits sealed ones — so carrying every sealed id forward
 *  would grow the checkpoint unboundedly for a receipt nobody can ever
 *  need. The tail's own ids dedupe through the fold as usual. */
function serializeSealedState(s: InterviewSessionState): SerializedInterviewState {
  return { ...s, seenEventIds: [] }
}

function stateFromCheckpoint(cp: SessionCheckpoint): InterviewSessionState {
  return { ...cp.state, seenEventIds: new Set(cp.state.seenEventIds) }
}

/** Rebuild a durable entry's full state: fold the tail onto the sealed
 *  checkpoint state (or from empty for a v1 entry). */
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

// ── live in-process session ─────────────────────────────────────────────────

let liveEvents: InterviewEvent[] = []
let liveState: InterviewSessionState = emptyInterviewState()
const listeners = new Set<() => void>()

// ── per-identity durable settlement ────────────────
//
// THE LAW: a timer may BATCH an identity's accepted writes, never erase them;
// switching identity never touches another identity's pending state; shutdown
// drains EVERY pending identity; every required publication settles
// observably (accepted generation → publishing → settled | degraded).

/** One durable publication outcome for one session identity. */
export interface InterviewSettlement {
  sessionId: InterviewSessionId
  /** The monotonic per-identity accepted generation this settlement covers. */
  generation: number
  state: 'settled' | 'degraded'
  /** Present on degraded settlements — the retained failure. */
  error?: string
  atMs: number
}

/** The drain receipt callers (and the shutdown cleanup) can observe. */
export interface InterviewFlushReceipt {
  /** Identities with a pending accepted generation at flush time. */
  drained: number
  settlements: InterviewSettlement[]
  allSettled: boolean
}

interface PendingPersist {
  timer: ReturnType<typeof setTimeout> | null
  /** The latest accepted full event log for this identity. */
  events: InterviewEvent[]
  /** Monotonic accepted generation (bumps per accepted append batch). */
  generation: number
  /** The last degraded settlement, retained for retry + health. */
  degraded?: InterviewSettlement
  /** Per-identity publication chain — writes for ONE identity never reorder. */
  inflight?: Promise<InterviewSettlement>
}

/** Every identity with unsettled (or last-degraded) state. Settled entries
 *  are reaped on settlement; degraded entries are retried by the next flush
 *  or accepted append and capped at MAX_SESSIONS (oldest evicted, loudly). */
const pendingBySession = new Map<InterviewSessionId, PendingPersist>()
let lastDegradedSettlement: InterviewSettlement | null = null
let adoptDegradeRecorded = false

/** The in-memory checkpoint bases for compacted sessions THIS process has
 *  seen (persist-compactions + disk resumes). Pending-first rebuilds fold
 *  the pending TAIL onto this base — a compacted live tail alone would
 *  rebuild the wrong state. Bounded at MAX_SESSIONS (oldest evicted). */
const liveCheckpoints = new Map<InterviewSessionId, SessionCheckpoint>()
function noteLiveCheckpoint(sessionId: InterviewSessionId, cp: SessionCheckpoint): void {
  liveCheckpoints.delete(sessionId)
  liveCheckpoints.set(sessionId, cp)
  if (liveCheckpoints.size > MAX_SESSIONS) {
    // Evict the oldest base whose identity has NO pending entry (the close
    // review's find: evicting a base a retained-degraded pending tail still
    // needs would truncate its pending-first rebuild). Identities with
    // pending state keep their bases; total stays bounded by
    // 2×MAX_SESSIONS (this map's cap + the pending map's own cap).
    for (const key of liveCheckpoints.keys()) {
      if (key === sessionId || pendingBySession.has(key)) continue
      liveCheckpoints.delete(key)
      break
    }
  }
}

/** Rebuild a PENDING identity's full state: its tail folds onto the known
 *  checkpoint base when one exists. */
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

/** One-time shutdown hook: every identity's pending tail (≤150 ms) must not
 *  be lost to a prompt exit — the graceful-shutdown cleanup drains ALL
 *  pending identities and logs any degradation (observable, never silent). */
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

/** Schedule the LIVE identity's debounced publication. Batching is
 *  per-identity: rescheduling clears only THIS identity's timer — another
 *  identity's pending write is never cancelled (P0-1). */
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
    // Bound + reaper: only degraded leftovers can accumulate (settled entries
    // reap themselves) — evict the oldest degraded one, loudly.
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

/** Publish one identity's latest accepted log. Chained per identity so one
 *  identity's writes can never reorder; distinct identities publish
 *  independently. Every outcome is a typed settlement (P0-2). */
function persistEntry(sessionId: InterviewSessionId, entry: PendingPersist): Promise<InterviewSettlement> {
  const prev = entry.inflight ?? Promise.resolve(null)
  const run = prev.then(async (): Promise<InterviewSettlement> => {
    const generation = entry.generation
    const events = entry.events
    try {
      let sealedNow = 0
      let newCheckpoint: SessionCheckpoint | undefined
      await interviewStore().mutate(current => {
        // Per-session compaction: past the threshold, fold the
        // prefix onto the (possibly existing) checkpoint and retain the tail.
        // Lengths are read HERE (the cb runs synchronously under the lane)
        // so appends racing the awaited publish land in the tail coherently.
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
      // Trim the sealed prefix from the LIVE log IN PLACE (same array
      // identity — captured references stay coherent). The live fold state
      // already contains the sealed effects; only the retained tail remains
      // as replayable events. The checkpoint base is noted for
      // pending-first rebuilds.
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

/** Drain EVERY pending identity NOW (shutdown / handoff seams) and report
 *  the typed settlement of each — the caller can observe degradation. */
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

/** The bounded persistence-health receipt (consumed by the doctor
 *  certificate; never interrupts foreground work). */
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

// ── identity minting ────────────────────────────────────────────────────────

export function mintInterviewId(prefix: 'is' | 'iq' | 'id' | 'io' | 'ie' | 'ir'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

// ── the authority API ───────────────────────────────────────────────────────

/** Append one event to the live session: fold → snapshot swap → notify →
 *  debounced durable write-through. Idempotent by eventId (fold law).
 *  Near-O(1) per append: the live state's own receipt set is
 *  the shared fold arm's mutable set, and the live log GROWS IN PLACE. */
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

/** Open a fresh live session (replacing any prior live one — the prior stays
 *  durable and resumable). Returns the session id. */
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

/** The stable-reference live snapshot (null session ⇒ the empty state). */
export function interviewSnapshot(): InterviewSessionState {
  return liveState
}

/**
 * The ONE cross-surface identity handle for the live interview:
 * `mercury://interview/<sessionId>/<focused decisionId>`. Minerva briefs,
 * Console side-questions, and the cockpit card all address THIS — no
 * surface keeps a private approximation. Null when no interview is open.
 */
export function currentInterviewRef(): string | null {
  const s = liveState
  if (s.sessionId === null || s.phase === 'completed' || s.phase === 'cancelled') return null
  const focusedQid = s.discussing ?? (s.focus && s.focus !== 'review' ? s.focus : null)
  const decisionId = focusedQid ? s.questions[focusedQid]?.question.decisionId : undefined
  return decisionId
    ? `mercury://interview/${s.sessionId}/${decisionId}`
    : `mercury://interview/${s.sessionId}`
}

/** The live event log — the SAME array reference across a session's life
 *  (it grows in place by append; a session switch/resume swaps in a fresh
 *  array). Callers must treat it as readonly. */
export function interviewEvents(): readonly InterviewEvent[] {
  return liveEvents
}

export function subscribeInterview(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * SYNC durable adoption at presentation time (C3): when a tool call arrives
 * with NO live session — a restarted process re-presenting a pending
 * tool_use, or a declared-id continuation — rebuild the newest still-open
 * durable session that matches by IDENTITY: the same toolUseId, or an
 * overlap with the ids the asking side declared. Synchronous ON PURPOSE —
 * presentToolCall runs during the card's first render and must adopt before
 * it mints; this process is the only writer. A pending (accepted, not yet
 * settled) identity OUTRANKS the durable file — adoption can never roll a
 * newer accepted truth back to an older snapshot. Never
 * text-matching.
 */
export function adoptDurableSessionSync(keys: {
  toolUseId?: string
  declaredIds?: readonly string[]
}): boolean {
  if (liveState.sessionId !== null) return false
  if (!keys.toolUseId && !(keys.declaredIds && keys.declaredIds.length > 0)) return false
  // Pending-first: an identity whose accepted generation has not settled yet
  // is NEWER than anything on disk — match it from memory before the file.
  // SYNC caveat (the close review's material find): an identity mid-flight
  // in a COMPACTING persist may hold the unspliced full log; this sync API
  // cannot await, so such identities are SKIPPED here and adoption falls
  // through to the durable file — the atomic publish guarantees a coherent
  // earlier or post-compaction read either side of the window. (The branch is
  // production-unreachable today — a nulled live slot and pending entries
  // cannot co-occur in a single-writer process — the guard keeps the settled
  // API safe for the C3 resume pickers regardless.)
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
    // The substrate fileStore wraps payloads; accept both the wrapped and
    // bare shapes through the same decoder the async reader uses.
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
    // ENOENT = genuinely no durable history; declining silently is honest.
    // Anything else is an UNREADABLE log — record the degradation receipt
    // while adoption declines gracefully.
    // Latched per process like the kernel's read path: one row per incident.
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

/** Rebuild a durable session into the live slot (resume/remount). Returns
 *  false when the log has no such session. A pending accepted generation for
 *  the SAME identity outranks the durable snapshot — resume can never roll
 *  newer accepted truth back to an older file. */
export async function resumeInterviewSession(sessionId: InterviewSessionId): Promise<boolean> {
  // AWAIT the identity's in-flight publication first (the close review's
  // material find): inside a compacting persist there is a window between
  // the mutate and the in-place splice where the pending entry still holds
  // the UNSPLICED full log — copying it as a tail would double-apply the
  // sealed prefix on the next persist (the seal law's empty receipt set
  // cannot dedupe it). Settling first makes the entry's array coherent (or
  // reaped, in which case the disk path below has everything).
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

/** Durable sessions for this project, newest first (resume pickers, C3). */
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

/** Proof seam: reset the live slot + the settlement estate (never product
 *  logic). */
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

// ============================================================================
//  daemon/idleRetirement — sweep #2 rider R5 (+ packet 74): the ONE
//  idle-retirement owner. An EMPTY background session — a live worker with
//  no conversation in its transcript, no turn in flight, nothing queued for
//  it, not attached, not paused — that has sat idle past the operator's
//  threshold is STOPPED through the session's ordinary stop verb: the child
//  dies (no parked seat keeps a process alive indefinitely), the record
//  stays on the board in the STOPPED group carrying a typed `retired` fact
//  the session list paints ("retired — empty and idle for 10m"), and the
//  operator releases it with the usual second x. A session WITH state is
//  never retired by idleness alone. Threshold: the registered
//  MERCURY_SESSION_IDLE_RETIRE_MINUTES knob (default 10 — deliberately
//  patient; 0 disables); the reaper retires ANY empty idle session, solo
//  included, so the knob speaks the session estate (Law 9) — the legacy
//  MERCURY_CONCOURSE_IDLE_RETIRE_MINUTES spelling is read one rung below
//  it, dated for removal in the registry. Pure decision + an IO sweep the
//  daemon's minute tick drives.
//
//  THE BIRTH GRACE: a NEWBORN — a
//  session born blank through New Session (the record's bornBlankAt) that
//  has not yet received the operator's first message (no lastDeliveryAt) —
//  is never "empty and idle": it is the chat the operator just opened. The
//  judgment excludes it for the registered MERCURY_SESSION_NEWBORN_GRACE_
//  MINUTES window (the legacy MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES read
//  one rung below it) — unset/0 ⇒ NEVER (the operator's word), a positive
//  value bounds it. The first delivery ends the grace; the poison is today's
//  reap (a chat reaped under the operator's feet ten minutes after ↵).
// ============================================================================
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

import { flagEnv } from '../substrate/flagRegistry.js'
import { formatLimit, minutesKnobToMs } from '../utils/deadline.js'
import { logForDebugging } from '../utils/debug.js'
import { recordToEntry } from '../fabric/entryCodec.js'
import { workerTranscriptPath } from '../services/concourse/workerTranscript.js'
import { readConcourseDispatches } from './concourseDispatch.js'
import {
  readSessionWorkers,
  stopConcourseSession,
  type ConcourseWorkerRecordV1,
} from './concourseSupervisor.js'
import { isProcessAlive } from './ownerWatch.js'

export const DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES = 10

/** The idle threshold in ms: the canonical spelling wins; the legacy
 *  spelling answers only while the canonical one is unset (a registered
 *  rename with a tolerated legacy spelling — the estate's flag law). */
export function concourseIdleRetireMs(): number {
  return minutesKnobToMs(
    flagEnv('MERCURY_SESSION_IDLE_RETIRE_MINUTES') ?? flagEnv('MERCURY_CONCOURSE_IDLE_RETIRE_MINUTES'),
    DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES,
  )
}

/** The birth grace in ms; 0 ⇒ a newborn is never retired by idleness (the
 *  default — the operator's word). */
export function concourseNewbornGraceMs(): number {
  return minutesKnobToMs(
    flagEnv('MERCURY_SESSION_NEWBORN_GRACE_MINUTES') ?? flagEnv('MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES'),
    0,
  )
}

export const DEFAULT_SESSION_PARK_DRAIN_MINUTES = 10

/** THE QUIT PATH's drain ceiling (the reactivation lifecycle, law 3): once
 *  the screen that owned the daemon is gone, a session MID-TURN keeps
 *  running only while its own turn finishes — up to this many minutes,
 *  after which its turn is cut and it parks anyway (the row says so). 0 ⇒
 *  no wait. */
export function sessionParkDrainMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_SESSION_PARK_DRAIN_MINUTES'), DEFAULT_SESSION_PARK_DRAIN_MINUTES)
}

/** The emptiness-proof ceiling: a transcript at or under this size is read
 *  WHOLE and judged line by line; anything larger is by definition not an
 *  empty session (never judged from a truncated window). */
const CONVERSATION_PROBE_BYTES = 256 * 1024

export type IdleRetirementFacts = {
  rec: Pick<
    ConcourseWorkerRecordV1,
    | 'spawnedAt'
    | 'endedAt'
    | 'stoppedAt'
    | 'pausedAt'
    | 'attachedAt'
    | 'attachRequestedAt'
    | 'lastAttachGrantAt'
    | 'lastDeliveryAt'
    | 'lastTurnSettledAt'
    | 'bornBlankAt'
    | 'parkedAt'
  >
  alive: boolean
  hasConversation: boolean
  hasPendingWork: boolean
  nowMs: number
  thresholdMs: number
  /** The birth grace in ms; absent/0 ⇒ a newborn is never retired. */
  newbornGraceMs?: number
}

export type IdleRetirementDecision =
  | { retire: true; idleMs: number }
  | { retire: false; reason: 'disabled' | 'ended' | 'parked' | 'stopped' | 'not-live' | 'paused' | 'attached' | 'turn-in-flight' | 'newborn' | 'has-conversation' | 'pending-work' | 'not-idle-long-enough' }

/** Pure: every condition of the definition, in the order it is cheapest to
 *  refuse. Exported for the parity prover. */
export function decideIdleRetirement(f: IdleRetirementFacts): IdleRetirementDecision {
  const { rec } = f
  if (!(f.thresholdMs > 0)) return { retire: false, reason: 'disabled' }
  if (rec.endedAt !== undefined) return { retire: false, reason: 'ended' }
  // A parked chat is closed, not idle: the reaper never re-states it (parked
  // with no runner is still parked — the row keeps "parked · <age>").
  if (rec.parkedAt !== undefined) return { retire: false, reason: 'parked' }
  if (rec.stoppedAt !== undefined) return { retire: false, reason: 'stopped' }
  if (!f.alive) return { retire: false, reason: 'not-live' }
  if (rec.pausedAt !== undefined) return { retire: false, reason: 'paused' }
  if (rec.attachedAt !== undefined || rec.attachRequestedAt !== undefined) return { retire: false, reason: 'attached' }
  const delivered = rec.lastDeliveryAt ?? 0
  const settled = rec.lastTurnSettledAt ?? 0
  if (delivered > 0 && delivered > settled) return { retire: false, reason: 'turn-in-flight' }
  // THE BIRTH GRACE: born blank and never messaged ⇒ the newborn is the
  // chat the operator just opened, never "empty and idle" — for the grace
  // window, unbounded by default. Read from the record alone (no transcript
  // probe): the two stamps are the whole truth.
  if (rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined) {
    const grace = f.newbornGraceMs ?? 0
    if (!(grace > 0) || f.nowMs - rec.bornBlankAt < grace) return { retire: false, reason: 'newborn' }
  }
  if (f.hasConversation) return { retire: false, reason: 'has-conversation' }
  if (f.hasPendingWork) return { retire: false, reason: 'pending-work' }
  const idleSince = Math.max(rec.spawnedAt, delivered, settled, rec.lastAttachGrantAt ?? 0)
  const idleMs = f.nowMs - idleSince
  if (idleMs < f.thresholdMs) return { retire: false, reason: 'not-idle-long-enough' }
  return { retire: true, idleMs }
}

/** Does a transcript line carry conversation (a user or assistant record)?
 *  Record envelopes project through the fabric's one codec. A parseable
 *  object line OUTSIDE the record format is never proof of emptiness —
 *  it counts as conversation so a file Mercury cannot read is never
 *  retired on an emptiness verdict. */
function lineIsConversation(raw: string): boolean {
  if (raw.length < 8) return false
  let entry: unknown
  try {
    entry = JSON.parse(raw)
  } catch {
    return false
  }
  if (!entry || typeof entry !== 'object') return false
  const env = entry as { schemaVersion?: unknown; payload?: unknown }
  if (!(typeof env.schemaVersion === 'number' && env.payload && typeof env.payload === 'object')) {
    return true // a retired-format line: not provably empty — refuse to judge
  }
  let shape: { type?: unknown }
  try {
    shape = recordToEntry(entry as never) as { type?: unknown }
  } catch {
    return false
  }
  return shape.type === 'user' || shape.type === 'assistant'
}

/** Pure over text: exported for the parity prover. */
export function transcriptTextHasConversation(text: string): boolean {
  for (const line of text.split('\n')) {
    if (lineIsConversation(line)) return true
  }
  return false
}

/** The transcript's head window, or '' when absent/unreadable (an absent
 *  transcript is the emptiest session of all). */
export function transcriptHasConversation(rec: { sessionId: string; workspaceId: string }): boolean {
  const path = workerTranscriptPath(rec)
  if (!existsSync(path)) return false
  try {
    const size = statSync(path).size
    if (size === 0) return false
    // A transcript larger than the probe window is never provably empty: the
    // window would cut the file mid-record, and a parse failure on that torn
    // tail is a truncation artifact, not a content verdict (a >256 KiB first
    // user record classified a REAL session empty). Emptiness is only ever
    // proven over the WHOLE file.
    if (size > CONVERSATION_PROBE_BYTES) return true
    const buf = Buffer.alloc(size)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, size, 0)
    } finally {
      closeSync(fd)
    }
    return transcriptTextHasConversation(buf.toString('utf8'))
  } catch {
    // Unreadable is not provably empty: never retire on a read failure.
    return true
  }
}

/** Pending work: a dispatch row still bound to this session that has not
 *  delivered (held, queued, starting). */
export function sessionHasPendingWork(sessionId: string, dir?: string): boolean {
  for (const row of Object.values(readConcourseDispatches(dir))) {
    if (row.sessionId !== sessionId) continue
    if (row.deliveredAt !== undefined) continue
    if (row.state === 'queued' || row.state === 'starting' || row.state === 'draft') return true
    if (row.heldOp !== undefined || row.heldReason !== undefined) return true
  }
  return false
}

export interface RetiredSession {
  sessionId: string
  runnerId: string
  idleMs: number
}

/**
 * One sweep over the durable records. Returns what it retired; every
 * refusal is a typed reason (logged at debug level, never noise). Safe to
 * re-run at any cadence — a retired session is `stopped` and refuses again.
 */
export function sweepIdleEmptyConcourseSessions(
  roster: { kill(short: string): boolean } | undefined,
  opts: { dir?: string; nowMs?: number; thresholdMs?: number; newbornGraceMs?: number } = {},
): RetiredSession[] {
  const thresholdMs = opts.thresholdMs ?? concourseIdleRetireMs()
  if (!(thresholdMs > 0)) return []
  const nowMs = opts.nowMs ?? Date.now()
  const newbornGraceMs = opts.newbornGraceMs ?? concourseNewbornGraceMs()
  const retired: RetiredSession[] = []
  for (const rec of Object.values(readSessionWorkers(opts.dir))) {
    if (rec.endedAt !== undefined || rec.stoppedAt !== undefined || rec.parkedAt !== undefined) continue
    const alive = rec.pid !== undefined && isProcessAlive(rec.pid)
    const decision = decideIdleRetirement({
      rec,
      alive,
      // The cheap refusals run first inside the decision; the two reads
      // below only matter once a record is live, unpaused and unattached.
      hasConversation: alive ? transcriptHasConversation(rec) : false,
      hasPendingWork: alive ? sessionHasPendingWork(rec.sessionId, opts.dir) : false,
      nowMs,
      thresholdMs,
      newbornGraceMs,
    })
    if (!decision.retire) {
      if (decision.reason !== 'not-idle-long-enough') continue
      logForDebugging(`[daemon] idle retirement: ${rec.runnerId} empty but idle only ${formatLimit(nowMs - rec.spawnedAt)}`)
      continue
    }
    const outcome = stopConcourseSession(
      rec.sessionId,
      `daemon: retired — empty and idle for ${formatLimit(decision.idleMs)}`,
      roster,
      opts.dir,
      { reason: 'idle-empty', idleMs: decision.idleMs, thresholdMs, at: nowMs },
    )
    if (outcome.outcome !== 'applied') continue
    // eslint-disable-next-line no-console
    console.error(
      `[daemon] retired ${rec.runnerId} (${rec.title ?? rec.sessionId}): empty and idle for ${formatLimit(decision.idleMs)} (threshold ${formatLimit(thresholdMs)}, MERCURY_SESSION_IDLE_RETIRE_MINUTES) — the row stays on the board as stopped until released`,
    )
    retired.push({ sessionId: rec.sessionId, runnerId: rec.runnerId, idleMs: decision.idleMs })
  }
  return retired
}

/** The session list's sentence for a retired row — one owner (law 6). */
export function retiredNowLabel(retired: NonNullable<ConcourseWorkerRecordV1['retired']>): string {
  return `retired — empty and idle for ${formatLimit(retired.idleMs)}`
}

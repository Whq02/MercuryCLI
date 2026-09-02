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

export function concourseIdleRetireMs(): number {
  return minutesKnobToMs(
    flagEnv('MERCURY_SESSION_IDLE_RETIRE_MINUTES') ?? flagEnv('MERCURY_CONCOURSE_IDLE_RETIRE_MINUTES'),
    DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES,
  )
}

export function concourseNewbornGraceMs(): number {
  return minutesKnobToMs(
    flagEnv('MERCURY_SESSION_NEWBORN_GRACE_MINUTES') ?? flagEnv('MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES'),
    0,
  )
}

export const DEFAULT_SESSION_PARK_DRAIN_MINUTES = 10

export function sessionParkDrainMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_SESSION_PARK_DRAIN_MINUTES'), DEFAULT_SESSION_PARK_DRAIN_MINUTES)
}

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
  newbornGraceMs?: number
}

export type IdleRetirementDecision =
  | { retire: true; idleMs: number }
  | { retire: false; reason: 'disabled' | 'ended' | 'parked' | 'stopped' | 'not-live' | 'paused' | 'attached' | 'turn-in-flight' | 'newborn' | 'has-conversation' | 'pending-work' | 'not-idle-long-enough' }

export function decideIdleRetirement(f: IdleRetirementFacts): IdleRetirementDecision {
  const { rec } = f
  if (!(f.thresholdMs > 0)) return { retire: false, reason: 'disabled' }
  if (rec.endedAt !== undefined) return { retire: false, reason: 'ended' }
  if (rec.parkedAt !== undefined) return { retire: false, reason: 'parked' }
  if (rec.stoppedAt !== undefined) return { retire: false, reason: 'stopped' }
  if (!f.alive) return { retire: false, reason: 'not-live' }
  if (rec.pausedAt !== undefined) return { retire: false, reason: 'paused' }
  if (rec.attachedAt !== undefined || rec.attachRequestedAt !== undefined) return { retire: false, reason: 'attached' }
  const delivered = rec.lastDeliveryAt ?? 0
  const settled = rec.lastTurnSettledAt ?? 0
  if (delivered > 0 && delivered > settled) return { retire: false, reason: 'turn-in-flight' }
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
    return true
  }
  let shape: { type?: unknown }
  try {
    shape = recordToEntry(entry as never) as { type?: unknown }
  } catch {
    return false
  }
  return shape.type === 'user' || shape.type === 'assistant'
}

export function transcriptTextHasConversation(text: string): boolean {
  for (const line of text.split('\n')) {
    if (lineIsConversation(line)) return true
  }
  return false
}

export function transcriptHasConversation(rec: { sessionId: string; workspaceId: string }): boolean {
  const path = workerTranscriptPath(rec)
  if (!existsSync(path)) return false
  try {
    const size = statSync(path).size
    if (size === 0) return false
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
    return true
  }
}

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

export function retiredNowLabel(retired: NonNullable<ConcourseWorkerRecordV1['retired']>): string {
  return `retired — empty and idle for ${formatLimit(retired.idleMs)}`
}

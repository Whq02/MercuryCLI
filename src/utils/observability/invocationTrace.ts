


import { flagEnv } from '../../substrate/flagRegistry.js'
import { appendFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { getMainThreadAgentType } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { getMercuryHome, isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { isMercurySubstrateProfileOn } from '../config.js'
import {
  deriveCapabilityDescriptor,
  type CapabilityDescriptor,
  type CapabilityProvenance,
  type CapabilityRisk,
} from '../capability/manifest.js'
import type { Tool } from '../../Tool.js'

const TRACE_ENV_VAR = 'MERCURY_TRACE'

const TRACE_FILENAME = 'mercury-trace.jsonl'

export const TRACE_MAX_BYTES = 2_000_000
export const TRACE_KEEP_BYTES = 1_000_000
const CHECK_EVERY = 64
let appendsSinceCheck = 0
let trimInFlight = false

const TRACE_FLUSH_ESCALATION_STREAK = 3
const TRACE_PENDING_CAP = 2_000
let pendingLines: string[] = []
let droppedLines = 0
let flushScheduled = false
let flushInFlight = false
let flushFailureStreak = 0
let lastFlushFailure: { at: number; message: string } | null = null
let lastWriteOkAt: number | null = null
let teardownRegistered = false

export function getTraceFlushHealth(): {
  pending: number
  streak: number
  dropped: number
  lastFailure: { at: number; message: string } | null
  lastWriteOkAt: number | null
} {
  return {
    pending: pendingLines.length,
    streak: flushFailureStreak,
    dropped: droppedLines,
    lastFailure: lastFlushFailure,
    lastWriteOkAt: lastWriteOkAt,
  }
}

export async function flushTraceNow(): Promise<void> {
  if (flushInFlight) return
  flushInFlight = true
  try {
    if (pendingLines.length === 0) return
    const snapshot = pendingLines
    pendingLines = []
    const path = getInvocationTracePath()
    try {
      await appendFile(path, snapshot.join(''), { mode: 0o600 })
      flushFailureStreak = 0
      lastFlushFailure = null
      lastWriteOkAt = Date.now()
      appendsSinceCheck += snapshot.length
      if (appendsSinceCheck >= CHECK_EVERY) {
        appendsSinceCheck = 0
        void maybeTrimTrace(path)
      }
    } catch (error) {
      if (pendingLines !== snapshot) {
        pendingLines = snapshot.concat(pendingLines)
      }
      enforcePendingCap()
      flushFailureStreak++
      lastFlushFailure = { at: Date.now(), message: String(error) }
      logForDebugging(
        `Failed to write invocation trace (streak ${flushFailureStreak}, ${pendingLines.length} pending): ${error}`,
        flushFailureStreak >= TRACE_FLUSH_ESCALATION_STREAK
          ? { level: 'error' }
          : undefined,
      )
    }
  } finally {
    flushInFlight = false
  }
}

function enforcePendingCap(): void {
  if (pendingLines.length > TRACE_PENDING_CAP) {
    const overflow = pendingLines.length - TRACE_PENDING_CAP
    pendingLines.splice(0, overflow)
    droppedLines += overflow
  }
}

function enqueueTraceLine(line: string): void {
  pendingLines.push(line)
  enforcePendingCap()
  if (!teardownRegistered) {
    teardownRegistered = true
    registerCleanup(async () => {
      await flushTraceNow()
      const remaining = pendingLines.length
      if (remaining > 0) {
        logForDebugging(
          `[trace] teardown: ${remaining} invocation-trace record(s) unflushed (streak ${flushFailureStreak}): ${lastFlushFailure?.message ?? 'unknown'}`,
          { level: 'error' },
        )
      }
    })
  }
  if (flushScheduled) return
  flushScheduled = true
  setTimeout(() => {
    flushScheduled = false
    void flushTraceNow()
  }, 0)?.unref?.()
}

export function _resetTraceFlushForTesting(): void {
  pendingLines = []
  droppedLines = 0
  flushScheduled = false
  flushInFlight = false
  flushFailureStreak = 0
  lastFlushFailure = null
  lastWriteOkAt = null
}

export async function maybeTrimTrace(path: string): Promise<void> {
  if (trimInFlight) return
  trimInFlight = true
  try {
    const st = await stat(path)
    if (st.size <= TRACE_MAX_BYTES) return
    const buf = await readFile(path)
    let slice = buf.subarray(buf.length - TRACE_KEEP_BYTES)
    const nl = slice.indexOf(0x0a)
    if (nl >= 0 && nl + 1 < slice.length) slice = slice.subarray(nl + 1)
    await durableAtomicPublish(path, slice)
  } catch {
  } finally {
    trimInFlight = false
  }
}

export type InvocationSurface = CapabilityProvenance

export interface InvocationTrace {
  ts: string
  tool: string
  surface: InvocationSurface
  risk: CapabilityRisk
  agentId?: string
  killed?: boolean
  durationMs?: number
  ok?: boolean
}

export function isInvocationTraceEnabled(): boolean {
  if (isEnvDefinedFalsy(flagEnv(TRACE_ENV_VAR))) return false
  return (
    (isEnvTruthy(flagEnv(TRACE_ENV_VAR)) || isMercurySubstrateProfileOn())
  )
}

export function buildInvocationTrace(
  tool: Tool,
  opts: {
    nowISO?: string
    killed?: boolean
    durationMs?: number
    ok?: boolean
    callReadOnly?: boolean
  } = {},
): InvocationTrace {
  let descriptor: CapabilityDescriptor
  try {
    descriptor = deriveCapabilityDescriptor(tool)
  } catch {
    descriptor = {
      name: typeof tool?.name === 'string' ? tool.name : '',
      category: 'other',
      risk: 'medium',
      provenance: 'builtin',
    }
  }

  const trace: InvocationTrace = {
    ts: typeof opts.nowISO === 'string' ? opts.nowISO : new Date().toISOString(),
    tool: descriptor.name,
    surface: descriptor.provenance,
    risk: opts.callReadOnly === true ? 'low' : descriptor.risk,
  }

  let agentId: string | undefined
  try {
    agentId = getMainThreadAgentType()
  } catch {
    agentId = undefined
  }
  if (typeof agentId === 'string' && agentId) trace.agentId = agentId

  if (opts.killed === true) trace.killed = true
  if (typeof opts.durationMs === 'number' && Number.isFinite(opts.durationMs)) {
    trace.durationMs = Math.max(0, Math.round(opts.durationMs))
  }
  if (typeof opts.ok === 'boolean') trace.ok = opts.ok

  return trace
}

export function getInvocationTracePath(): string {
  return join(getMercuryHome(), TRACE_FILENAME)
}

export function emitInvocationTrace(
  tool: Tool,
  opts: {
    nowISO?: string
    killed?: boolean
    durationMs?: number
    ok?: boolean
  } = {},
): void {
  if (!isInvocationTraceEnabled()) return
  try {
    const trace = buildInvocationTrace(tool, opts)
    enqueueTraceLine(JSON.stringify(trace) + '\n')
  } catch {
  }
}


const COMPACTION_TRACE_OPT_OUT = 'MERCURY_COMPACTION_TRACE'

export type CompactionEvent =
  | 'snip'
  | 'microcompact'
  | 'context-collapse'
  | 'auto-compact'
  | 'reactive-compact'

export interface CompactionTrace {
  ts: string
  kind: 'compaction'
  event: CompactionEvent
  tokensFreed?: number
  messagesBefore?: number
  messagesAfter?: number
  agentId?: string
}

export function isCompactionTraceEnabled(): boolean {
  if (flagEnv(COMPACTION_TRACE_OPT_OUT) === '0') return false
  return isInvocationTraceEnabled()
}

export function buildCompactionTrace(
  event: CompactionEvent,
  opts: {
    nowISO?: string
    tokensFreed?: number
    messagesBefore?: number
    messagesAfter?: number
  } = {},
): CompactionTrace {
  const rec: CompactionTrace = {
    ts: typeof opts.nowISO === 'string' ? opts.nowISO : new Date().toISOString(),
    kind: 'compaction',
    event,
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined
  const tf = num(opts.tokensFreed)
  if (tf !== undefined) rec.tokensFreed = tf
  const mb = num(opts.messagesBefore)
  if (mb !== undefined) rec.messagesBefore = mb
  const ma = num(opts.messagesAfter)
  if (ma !== undefined) rec.messagesAfter = ma
  let agentId: string | undefined
  try {
    agentId = getMainThreadAgentType()
  } catch {
    agentId = undefined
  }
  if (typeof agentId === 'string' && agentId) rec.agentId = agentId
  return rec
}

export function emitCompactionTrace(
  event: CompactionEvent,
  opts: {
    nowISO?: string
    tokensFreed?: number
    messagesBefore?: number
    messagesAfter?: number
  } = {},
): void {
  if (!isCompactionTraceEnabled()) return
  try {
    enqueueTraceLine(JSON.stringify(buildCompactionTrace(event, opts)) + '\n')
  } catch {
  }
}

/* ============================================================================
   observability/invocationTrace — the per-invocation OBSERVABILITY SPINE for
   Mercury (item: invocation trace).
   ----------------------------------------------------------------------------
   Mercury has capability GATES (the kill-switch, MCP policy / trust, the
   capability manifest) but records NOTHING about what actually ran. This module
   is the missing record: at the universal tool-execution chokepoint
   (services/tools/toolExecution.ts checkPermissionsAndCallTool — the same seam
   the capability kill-switch hooks, so builtin + MCP + skill all funnel through
   it) we emit exactly ONE secret-REDACTED record per invocation to a JSONL
   sidecar.

   Shape (one honest line per invocation):
     { ts, tool, surface (builtin|mcp:<server>|skill), risk,
       agentId, killed?, durationMs?, ok? }

   - `surface` + `risk` are derived from the SAME deriveCapabilityDescriptor the
     capability manifest already uses (single source of truth — no second risk
     vocabulary). provenance maps 1:1 onto surface.

   GATING: emit when MERCURY_TRACE is truthy OR the Mercury substrate profile is
   on (isMercurySubstrateProfileOn(), default-ON).
   The trace therefore rides the substrate profile by default; the
   hard opt-out is MERCURY_TRACE=0 (which wins over the profile) or MERCURY_SUBSTRATE=0.
   OFF (substrate off / explicit opt-out) ⇒ this module's emit is a single boolean
   short-circuit: zero overhead, no file ever opened, byte-identical behavior.

   FAIL-SAFE: best-effort, never throws, never blocks the tool. (The K7
   flush-death law, extended from src/history.ts): records land in a BOUNDED
   pending buffer and leave it only on append SUCCESS — a failed/locked
   sidecar requeues the snapshot, counts a consecutive-failure streak
   (error-level log at the escalation mark), keeps collecting, and re-arms on
   the next emit; /doctor's trace probe reads this health, and teardown makes
   one final attempt + one honest notice if records remain. The pre-WI-3
   shape (bare fs.appendFile fire-and-forget, errors swallowed) silently
   LOST every record written while the sidecar was unwritable.
   ============================================================================ */

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

/** The env switch. OFF (unset) ⇒ zero overhead, no file. */
const TRACE_ENV_VAR = 'MERCURY_TRACE'

/** Sidecar filename under the Mercury config home (honors MERCURY_CONFIG_DIR). */
const TRACE_FILENAME = 'mercury-trace.jsonl'

/* ── size-bounded rotation ───────────────────────────────────────────────────
   Now that the trace is LIVE by default for Mercury (one line per tool call),
   an uncapped append would grow the sidecar without bound. We keep it bounded:
   roughly every CHECK_EVERY appends we stat the file, and once it crosses
   TRACE_MAX_BYTES we rewrite it down to its last ~TRACE_KEEP_BYTES (whole lines
   only) via a temp-file + atomic rename. Best-effort and fully async — it never
   blocks the tool path and never throws. */
export const TRACE_MAX_BYTES = 2_000_000
export const TRACE_KEEP_BYTES = 1_000_000
const CHECK_EVERY = 64
let appendsSinceCheck = 0
let trimInFlight = false

/* ── K7 flush-death law ───────────────────────────────────────────────
   Lines leave the pending buffer ONLY on append success; failures requeue the
   snapshot in order, count a streak, and escalate to an error-level log at
   the mark. The buffer is BOUNDED (a dead disk must never grow memory without
   bound): overflow drops the OLDEST lines and counts them honestly. */
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

/** Live flush health for /doctor's trace probe: pending backlog +
 *  consecutive-failure streak + bounded-buffer drops + the last success. */
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

/** Drive exactly ONE flush attempt to completion (deterministic — no retry
 *  chain): the injection prover's seam, mirroring history's flushHistoryNow. */
export async function flushTraceNow(): Promise<void> {
  if (flushInFlight) return
  flushInFlight = true
  try {
    if (pendingLines.length === 0) return
    // Snapshot-and-requeue (the K7 shape): the snapshot leads on failure so
    // order holds; lines enqueued mid-flush follow it.
    const snapshot = pendingLines
    pendingLines = []
    const path = getInvocationTracePath()
    try {
      await appendFile(path, snapshot.join(''), { mode: 0o600 })
      flushFailureStreak = 0
      lastFlushFailure = null
      lastWriteOkAt = Date.now()
      // Amortized size check rides SUCCESSFUL batches only.
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

/** Buffer one serialized record + schedule a flush. Sync, never throws —
 *  the tool path is never blocked and never sees a trace failure. */
function enqueueTraceLine(line: string): void {
  pendingLines.push(line)
  enforcePendingCap()
  if (!teardownRegistered) {
    teardownRegistered = true
    // One teardown-time attempt + ONE honest notice if records remain — a
    // process must never exit having silently dropped its trace tail.
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

/** TEST-ONLY: reset the buffer machinery so proofs run isolated legs. */
export function _resetTraceFlushForTesting(): void {
  pendingLines = []
  droppedLines = 0
  flushScheduled = false
  flushInFlight = false
  flushFailureStreak = 0
  lastFlushFailure = null
  lastWriteOkAt = null
}

/**
 * If the sidecar has grown past TRACE_MAX_BYTES, rewrite it to its last
 * ~TRACE_KEEP_BYTES of WHOLE records (drop the partial leading line) atomically.
 * Guarded against re-entry; swallows every error — trace hygiene must never
 * perturb execution.
 */
export async function maybeTrimTrace(path: string): Promise<void> {
  if (trimInFlight) return
  trimInFlight = true
  try {
    const st = await stat(path)
    if (st.size <= TRACE_MAX_BYTES) return
    const buf = await readFile(path)
    let slice = buf.subarray(buf.length - TRACE_KEEP_BYTES)
    const nl = slice.indexOf(0x0a) // first newline → drop the partial first line
    if (nl >= 0 && nl + 1 < slice.length) slice = slice.subarray(nl + 1)
    // Durable publication: the old `${path}.tmp-${size}` temp name
    // was REUSABLE (same size twice ⇒ same name; two processes trimming ⇒
    // collision) — the owner's temp is collision-free and self-cleaning, and
    // its win32 bounded retry absorbs AV locks on the hot sidecar. Atomic
    // replace; concurrent appends resume on the trimmed file.
    await durableAtomicPublish(path, slice)
  } catch {
    // stat/read/write/rename failure (missing file, race, perms) — leave it; the
    // next check retries. Never throws.
  } finally {
    trimInFlight = false
  }
}

/**
 * The surface a capability came from. Mirrors CapabilityProvenance verbatim
 * ('builtin' | 'skill' | `mcp:${server}`) — the manifest's provenance IS the
 * trust-boundary surface, so we reuse it rather than mint a parallel vocabulary.
 */
export type InvocationSurface = CapabilityProvenance

/** One redacted per-invocation record. Optional fields are present only when
 *  the invocation reached the relevant stage (a killed call has no duration). */
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

/**
 * True for Mercury when MERCURY_TRACE is truthy OR the Mercury substrate
 * profile is on (isMercurySubstrateProfileOn(), default-ON for a fork) — so the
 * trace is live by default on a Mercury build. The hard opt-out is MERCURY_TRACE=0
 * (wins over the profile) or MERCURY_SUBSTRATE=0. Every public entry point
 * short-circuits on this so the off state is a single boolean check with no
 * allocation, no descriptor derivation, and no file access.
 */
export function isInvocationTraceEnabled(): boolean {
  // An explicit MERCURY_TRACE=0 (or false/no/off) is a hard opt-out — it wins
  // over the substrate profile, so the per-flag `=0` is honest (mirrors the
  // `isEnvDefinedFalsy` short-circuit in isMercurySubstrateProfileOn). Without
  // this, `isEnvTruthy('0')` is merely false and the substrate OR kept it ON.
  if (isEnvDefinedFalsy(flagEnv(TRACE_ENV_VAR))) return false
  return (
    (isEnvTruthy(flagEnv(TRACE_ENV_VAR)) || isMercurySubstrateProfileOn())
  )
}

/**
 * Build a redacted InvocationTrace for a tool. Derives surface + risk from the
 * SAME capability descriptor the manifest uses (no second risk classifier).
 * Never throws — a garbage tool degrades to a safe-default descriptor. Does NOT
 * read or carry raw tool input.
 */
export function buildInvocationTrace(
  tool: Tool,
  opts: {
    nowISO?: string
    killed?: boolean
    durationMs?: number
    ok?: boolean
    /** The CALL resolved read-only by the tool's OWN annotation
     *  (tool.isReadOnly(input) at the emit chokepoint — no second
     *  classifier, no input carried here). diagnostic issue 8:
     *  stamping the static exec-class risk on every Bash call made `ls`
     *  read as risk:high — the call truth wins when the tool provides it. */
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

/**
 * Absolute path of the JSONL sidecar (honors MERCURY_CONFIG_DIR). Exported so the
 * /trace viewer reads from the SAME path the emitter writes to — one source of
 * truth for the sidecar location, never a re-derived/drifting copy.
 */
export function getInvocationTracePath(): string {
  return join(getMercuryHome(), TRACE_FILENAME)
}

/**
 * Emit ONE invocation record to the JSONL sidecar — buffered, best-effort,
 * fire-and-forget. Never throws, never blocks the tool: the record joins the
 * bounded pending buffer and a flush is scheduled off the tool path (
 * a failed/locked sidecar requeues instead of silently dropping). When
 * tracing is OFF this is a single boolean short-circuit before any work —
 * zero overhead, no file ever opened.
 */
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
    // Building or serializing the trace must never affect execution.
  }
}

/* ============================================================================
   Compaction-event lane — a sibling record on the SAME sidecar recording the
   harness's most opaque subsystem: the five-layer compaction pipeline, whose
   context collapse operates without user-visible output. The local trace
   recorded every TOOL call but NOTHING
   about when/how much the harness silently compacted the context. We emit ONE
   numeric-only record per meaningful compaction so /trace can show it.

   GATING: piggybacks isInvocationTraceEnabled() (so it never writes when tracing
   is off), with its own MERCURY_COMPACTION_TRACE=0 opt-out. NUMERIC-ONLY by
   construction — no message content, no args, ever; the record carries only an
   event label + token/message counts, so it can never leak a secret.
   ============================================================================ */

const COMPACTION_TRACE_OPT_OUT = 'MERCURY_COMPACTION_TRACE'

/** The compaction layers worth recording. The full union is kept so the
 *  parser/aggregator and this proof vocabulary stay one source of truth.
 *
 *  Reachability on a Mercury build (feature() folds to false at build): the live
 *  emitters are 'microcompact', 'auto-compact', and 'reactive-compact'
 *  (reactive-compact only when REACTIVE_COMPACT is enabled). 'snip' and
 *  'context-collapse' are emitted ONLY inside feature('HISTORY_SNIP') /
 *  feature('CONTEXT_COLLAPSE') blocks in query.ts, so they are UPSTREAM-ONLY —
 *  unreachable on Mercury but retained in the schema (the trace viewer and
 *  tests must still round-trip them). */
export type CompactionEvent =
  | 'snip'
  | 'microcompact'
  | 'context-collapse'
  | 'auto-compact'
  | 'reactive-compact'

/** One numeric-only compaction record. `kind:'compaction'` discriminates it from
 *  an InvocationTrace on the shared sidecar. */
export interface CompactionTrace {
  ts: string
  kind: 'compaction'
  event: CompactionEvent
  tokensFreed?: number
  messagesBefore?: number
  messagesAfter?: number
  agentId?: string
}

/** True only when invocation tracing is on AND MERCURY_COMPACTION_TRACE is not '0'. */
export function isCompactionTraceEnabled(): boolean {
  if (flagEnv(COMPACTION_TRACE_OPT_OUT) === '0') return false
  return isInvocationTraceEnabled()
}

/** Build a numeric-only compaction record. Pure, never throws. */
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

/**
 * Emit ONE compaction record to the shared JSONL sidecar — buffered on the
 * SAME pending buffer as invocation records (order preserved), best-effort,
 * fire-and-forget. Never throws, never blocks the query loop. OFF ⇒ a single
 * boolean short-circuit before any work.
 */
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
    // Observability must never affect the query loop.
  }
}

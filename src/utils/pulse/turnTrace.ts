// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
// the ONE monotonic turn trace.
//
//  Keyed by turn generation (shared with turnPhase — one turn identity), it
//  covers the REAL Enter boundary through settlement: submit capture, the
//  pending SessionStart-hook await, input processing, EVERY attachment
//  producer (not a 5% sample), prompt hooks, context build / request-context
//  plan / autocompact, tool schemas, normalization, client setup, actual HTTP
//  dispatch, headers, first chunk / first thinking / first text, first
//  terminal write, turn_complete.
//
//  Laws (proved in scripts/pulse/):
//  · performance.now() only (the pulseNow seam) — never wall-clock deltas.
//  · One operator turn ⇒ one complete trace. beginPulseTurn abandons an
//    unfinished predecessor explicitly (status 'abandoned') so the invariant
//    survives crashes in the middle of a turn.
//  · Generation-fenced: marks against a stale generation are dropped.
//  · MAIN THREAD ONLY: the trace narrates the operator's turn — subagent
//    streams never write here (fence at the instrumentation call sites).
//  · Bounded: ring of ≤ RING_CAP summaries, ≤ EVENT_CAP events per trace
//    (overflow counted, never grown). Zero idle cost — no timers, no io.
//  · Payload hygiene: numeric timings + enum/label strings ONLY. Never prompt
//    text, file contents, request bodies, hook output, or model output.
// ============================================================================

import {
  beginPhaseGeneration,
  pulseNow,
  resetPhaseForTests,
} from './turnPhase.js'

/** Point events (single stamps). Stage events ride pulseStageStart/End as
 *  `${stage}_start` / `${stage}_end`. */
export type PulsePointName =
  | 'submit_received'
  | 'acknowledgement_state_committed'
  | 'acknowledgement_first_terminal_write'
  | 'query_loop_entered'
  | 'api_request_sent'
  | 'response_headers_received'
  | 'first_stream_chunk_received'
  | 'first_thinking_event'
  | 'first_text_delta'
  | 'first_text_terminal_write'
  | 'turn_complete'

export type PulseStageName =
  | 'pending_session_hooks'
  | 'input_processing'
  | 'attachment_collection'
  | 'user_prompt_hooks'
  | 'before_query_callbacks'
  | 'context_build'
  | 'request_context_plan'
  | 'autocompact'
  | 'tool_schema'
  | 'message_normalization'
  | 'client_setup'
  | 'tool_execution'

/** Enum labels + numbers only — the hygiene law. */
export type PulseEventData = Record<string, number | string | boolean>

export type PulseEvent = {
  name: string
  /** pulseNow() stamp. */
  at: number
  data?: PulseEventData
}

export type PulseProducerOutcome =
  | 'ok'
  | 'empty'
  | 'error'
  | 'timeout'
  /** Optional work whose shared budget was already spent BEFORE it could
   *  start — never begun, recorded loudly (hot-path cadence C1). */
  | 'skipped'

export type PulseProducerRecord = {
  /** The static producer label ('nested_memory', 'changed_files', …). */
  label: string
  ms: number
  outcome: PulseProducerOutcome
  /** Attachments yielded (0 for 'empty'/'error'). */
  count: number
}

export type PulseTurnStatus = 'complete' | 'cancelled' | 'error' | 'abandoned'

export type PulseTurnSummary = {
  key: string
  generation: number
  status: PulseTurnStatus
  /** Model + applied effort of the FIRST model call (null if never dispatched). */
  model: string | null
  effort: string | null
  /** Cold = first turn of the session or > COLD_GAP_MS since the last turn
   *  completed (the cache-TTL-shaped classification; post-idle re-pays). */
  cold: boolean
  /** ms from the previous turn's completion to this submit (null on first). */
  idleGapMs: number | null
  dispatched: boolean
  totalMs: number
  /** submit → acknowledgement_first_terminal_write. */
  ackMs: number | null
  /** submit → api_request_sent (total Mercury-local preparation). */
  localPrepMs: number | null
  /** api_request_sent → first_stream_chunk_received (provider wait). */
  providerWaitMs: number | null
  /** submit → min(first_thinking_event, first_text_terminal_write). */
  firstVisibleMs: number | null
  /** first_text_delta → first_text_terminal_write (token→terminal paint). */
  paintMs: number | null
  slowestStage: { name: string; ms: number } | null
  producerCount: number
  slowestProducer: { label: string; ms: number } | null
}

export type TurnTrace = {
  key: string
  generation: number
  startedAt: number
  events: PulseEvent[]
  /** Events dropped past EVENT_CAP (bounded-growth law). */
  droppedEvents: number
  producers: PulseProducerRecord[]
  meta: {
    querySource?: string
    model?: string
    effort?: string
  }
  done: boolean
  /** ms from the previous turn's settlement to this submit (null on the
   *  session's first turn) — computed at beginPulseTurn, so deferred
   *  finalization can never skew the cold/warm classification. */
  idleGapMs: number | null
  /** Settlement deferred: the turn completed while terminal-write marks were
   *  still armed (a fast turn can settle before the frame carrying its first
   *  text write delivers). The summary/ring/dump finalize when the next
   *  delivered frame stamps them — or immediately, without them, if a new
   *  turn begins first. */
  pendingCompletion?: { status: PulseTurnStatus }
}

const RING_CAP = 64
const EVENT_CAP = 256
const COLD_GAP_MS = 5 * 60 * 1000

let generationCounter = 0
let active: TurnTrace | null = null
const ring: PulseTurnSummary[] = []
/** pulseNow() when the last turn completed — cold/warm classification. */
let lastTurnEndedAt: number | null = null

// ── lifecycle ───────────────────────────────────────────────────────────────

/** Open the turn at the REAL Enter/submit boundary — BEFORE any pending hook
 *  await or input processing. Also opens the phase generation (one turn
 *  identity across trace + phase). Returns the generation used to fence every
 *  later mark. `at` backdates the boundary to a stamp captured earlier in the
 *  same tick (the submit handler captures Enter time before its early-return
 *  branches decide whether a turn actually starts). */
export function beginPulseTurn(meta?: TurnTrace['meta'], at?: number): number {
  if (active && !active.done) {
    completePulseTurn(active.generation, 'abandoned')
  }
  // A predecessor still holding out for its terminal-write stamp finalizes
  // NOW, without it (its armed marks die with the generation change), and
  // every stale-generation arm is purged (bounded-growth law).
  if (active?.pendingCompletion) {
    finalizeTurn(active, active.pendingCompletion.status)
  }
  armedWriteMarks = []
  const generation = ++generationCounter
  const startedAt = at ?? pulseNow()
  active = {
    key: `p${generation}`,
    generation,
    startedAt,
    events: [],
    droppedEvents: 0,
    producers: [],
    meta: meta ?? {},
    done: false,
    idleGapMs:
      lastTurnEndedAt === null ? null : round1(startedAt - lastTurnEndedAt),
  }
  beginPhaseGeneration(generation)
  active.events.push({ name: 'submit_received', at: startedAt })
  return generation
}

function traceFor(generation?: number): TurnTrace | null {
  if (!active || active.done) return null
  if (generation !== undefined && generation !== active.generation) return null
  return active
}

/** Point-event stamp. Stale-generation and no-active-turn calls are silent
 *  no-ops (a late event from a cancelled turn is normal). First-seen point
 *  names latch: a duplicate 'first_*' / point stamp is ignored so retries
 *  can't rewrite history. */
export function pulseMark(
  name: PulsePointName | (string & {}),
  data?: PulseEventData,
  generation?: number,
): void {
  const t = traceFor(generation)
  if (!t) return
  if (t.events.length >= EVENT_CAP) {
    t.droppedEvents++
    return
  }
  if (POINT_LATCH.has(name) && t.events.some(e => e.name === name)) return
  t.events.push(data ? { name, at: pulseNow(), data } : { name, at: pulseNow() })
}

const POINT_LATCH: ReadonlySet<string> = new Set([
  'submit_received',
  'acknowledgement_state_committed',
  'acknowledgement_first_terminal_write',
  'response_headers_received',
  'first_stream_chunk_received',
  'first_thinking_event',
  'first_text_delta',
  'first_text_terminal_write',
  'turn_complete',
])

export function pulseStageStart(
  stage: PulseStageName | (string & {}),
  data?: PulseEventData,
  generation?: number,
): void {
  pulseMark(`${stage}_start`, data, generation)
}

export function pulseStageEnd(
  stage: PulseStageName | (string & {}),
  data?: PulseEventData,
  generation?: number,
): void {
  pulseMark(`${stage}_end`, data, generation)
}

/** Record ONE attachment producer's duration + outcome (every producer, not
 *  a sample). Bounded by the producer count itself (~41). */
export function recordPulseProducer(
  label: string,
  ms: number,
  outcome: PulseProducerOutcome,
  count: number,
  generation?: number,
): void {
  const t = traceFor(generation)
  if (!t) return
  t.producers.push({ label, ms: round1(ms), outcome, count })
}

/** Stamp the model + applied effort of the first model call on the trace. */
export function notePulseModel(
  model: string,
  effort: string | undefined,
  generation?: number,
): void {
  const t = traceFor(generation)
  if (!t) return
  if (!t.meta.model) {
    t.meta.model = model
    if (effort) t.meta.effort = effort
  }
}

/** Settle the trace: compute the summary, append to the bounded ring. The
 *  trace object stays readable as `getLatestPulseTrace()` until the next
 *  turn begins. If terminal-write marks are still ARMED for this generation
 *  (a fast turn settling before the frame carrying its first text write
 *  delivers), finalization DEFERS until the next delivered frame stamps them
 *  — the paint span is real and belongs to this turn — or until a new turn
 *  begins (fallback: finalize without the stamp). `turn_complete` is stamped
 *  NOW either way, so timing stays anchored at the real settlement. */
export function completePulseTurn(
  generation: number,
  status: PulseTurnStatus = 'complete',
): PulseTurnSummary | null {
  const t = traceFor(generation)
  if (!t) return null
  if (status === 'complete') pulseMark('turn_complete', undefined, generation)
  t.done = true
  lastTurnEndedAt = pulseNow()
  if (armedWriteMarks.some(a => a.generation === t.generation)) {
    t.pendingCompletion = { status }
    return null
  }
  return finalizeTurn(t, status)
}

function finalizeTurn(t: TurnTrace, status: PulseTurnStatus): PulseTurnSummary {
  delete t.pendingCompletion
  const summary = summarize(t, status)
  ring.push(summary)
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
  dumpTurn(t, summary)
  return summary
}

/** MERCURY_PULSE_DUMP (test-only observation seam): append one JSON line per
 *  completed turn so PTY scenes can read the trace from outside the process.
 *  Numeric timings + enum labels only — same hygiene law as the trace. */
function dumpTurn(t: TurnTrace, summary: PulseTurnSummary): void {
  const path = flagEnv('MERCURY_PULSE_DUMP')
  if (!path) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    fs.appendFileSync(
      path,
      `${JSON.stringify({
        summary,
        events: t.events,
        producers: t.producers,
        droppedEvents: t.droppedEvents,
      })}\n`,
    )
  } catch {
    // A broken dump path must never break a turn.
  }
}

// ── summaries + accessors ───────────────────────────────────────────────────

function eventAt(t: TurnTrace, name: string): number | null {
  const e = t.events.find(ev => ev.name === name)
  return e ? e.at : null
}

function summarize(t: TurnTrace, status: PulseTurnStatus): PulseTurnSummary {
  const submit = t.startedAt
  const ack = eventAt(t, 'acknowledgement_first_terminal_write')
  const sent = eventAt(t, 'api_request_sent')
  const chunk = eventAt(t, 'first_stream_chunk_received')
  const thinking = eventAt(t, 'first_thinking_event')
  const textDelta = eventAt(t, 'first_text_delta')
  const textWrite = eventAt(t, 'first_text_terminal_write')
  const end = eventAt(t, 'turn_complete') ?? pulseNow()

  // Slowest paired LOCAL stage: match `${x}_start` to the next `${x}_end`.
  // Stages that span provider or tool time are excluded — "slowest local
  // stage" must attribute Mercury-owned work, not the model's.
  const NON_LOCAL_STAGES: ReadonlySet<string> = new Set([
    'model_call_stream',
    'tool_execution',
  ])
  let slowestStage: PulseTurnSummary['slowestStage'] = null
  const starts = new Map<string, number>()
  for (const e of t.events) {
    if (e.name.endsWith('_start')) {
      starts.set(e.name.slice(0, -'_start'.length), e.at)
    } else if (e.name.endsWith('_end')) {
      const stage = e.name.slice(0, -'_end'.length)
      const s = starts.get(stage)
      if (s !== undefined) {
        const ms = e.at - s
        starts.delete(stage)
        if (NON_LOCAL_STAGES.has(stage)) continue
        if (!slowestStage || ms > slowestStage.ms) {
          slowestStage = { name: stage, ms: round1(ms) }
        }
      }
    }
  }

  let slowestProducer: PulseTurnSummary['slowestProducer'] = null
  for (const p of t.producers) {
    if (!slowestProducer || p.ms > slowestProducer.ms) {
      slowestProducer = { label: p.label, ms: p.ms }
    }
  }

  const firstVisible =
    thinking !== null && textWrite !== null
      ? Math.min(thinking, textWrite)
      : (thinking ?? textWrite)

  const idleGapMs = t.idleGapMs

  return {
    key: t.key,
    generation: t.generation,
    status,
    model: t.meta.model ?? null,
    effort: t.meta.effort ?? null,
    cold: idleGapMs === null || idleGapMs > COLD_GAP_MS,
    idleGapMs,
    dispatched: sent !== null,
    totalMs: round1(end - submit),
    ackMs: ack !== null ? round1(ack - submit) : null,
    localPrepMs: sent !== null ? round1(sent - submit) : null,
    providerWaitMs:
      sent !== null && chunk !== null ? round1(chunk - sent) : null,
    firstVisibleMs: firstVisible !== null ? round1(firstVisible - submit) : null,
    paintMs:
      textDelta !== null && textWrite !== null
        ? round1(textWrite - textDelta)
        : null,
    slowestStage,
    producerCount: t.producers.length,
    slowestProducer,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function getActivePulseTrace(): TurnTrace | null {
  return active && !active.done ? active : null
}

/** The most recent trace (active or settled) — the /trace waterfall source. */
export function getLatestPulseTrace(): TurnTrace | null {
  return active
}

export function getPulseRing(): readonly PulseTurnSummary[] {
  return ring
}

/** Percentile over the ring for a numeric summary field (nulls skipped).
 *  Returns null when no samples exist. p in [0,100]. */
export function pulsePercentile(
  field:
    | 'totalMs'
    | 'ackMs'
    | 'localPrepMs'
    | 'providerWaitMs'
    | 'firstVisibleMs'
    | 'paintMs',
  p: number,
  filter?: (s: PulseTurnSummary) => boolean,
): number | null {
  const xs = ring
    .filter(s => (filter ? filter(s) : true))
    .map(s => s[field])
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  if (xs.length === 0) return null
  const idx = Math.min(
    xs.length - 1,
    Math.max(0, Math.ceil((p / 100) * xs.length) - 1),
  )
  return xs[idx]!
}

// ── terminal-write marks ────────────────────────────────────────────────────
// "acknowledgement_first_terminal_write" / "first_text_terminal_write" are
// stamped by the renderer's ONE frame tail (src/ink/ink.tsx): an arm site
// (REPL ack commit, first text delta) registers a one-shot generation-tagged
// mark; the next DELIVERED frame write stamps it. Undelivered frames (wedged
// reader) don't count — the terminal never showed them. Idle cost: one
// array-length check per frame.

let armedWriteMarks: Array<{ name: string; generation: number }> = []

export function armPulseTerminalWriteMark(
  name: PulsePointName | (string & {}),
  generation?: number,
): void {
  const t = traceFor(generation)
  if (!t) return
  if (armedWriteMarks.some(a => a.name === name && a.generation === t.generation))
    return
  armedWriteMarks.push({ name, generation: t.generation })
}

/** Called from the renderer frame tail after the write settles. Armed marks
 *  stamp into the matching OPEN trace, or into a done-but-PENDING one (the
 *  deferred-settlement path) — a stale generation dies at the fence either
 *  way. Draining the last pending mark finalizes the deferred turn. */
export function notePulseFrameWritten(delivered: boolean): void {
  if (armedWriteMarks.length === 0 || !delivered) return
  const armed = armedWriteMarks
  armedWriteMarks = []
  for (const a of armed) {
    if (!active || active.generation !== a.generation) continue
    if (!active.done) {
      pulseMark(a.name, undefined, a.generation)
    } else if (active.pendingCompletion) {
      if (
        active.events.length < EVENT_CAP &&
        !(POINT_LATCH.has(a.name) && active.events.some(e => e.name === a.name))
      ) {
        active.events.push({ name: a.name, at: pulseNow() })
      }
    }
  }
  if (active?.pendingCompletion) {
    finalizeTurn(active, active.pendingCompletion.status)
  }
}

// ── the main-source fence ───────────────────────────────────────────────────

/** True when a query belongs to the OPERATOR's turn — the only streams that
 *  may write the trace/phase. Subagents carry an agentId; service queries
 *  (compact, classifiers, side questions) carry their own querySource. */
export function isPulseMainSource(
  querySource: string,
  agentId: string | undefined,
): boolean {
  return (
    !agentId &&
    (querySource === 'sdk' || querySource.startsWith('repl_main_thread'))
  )
}

/** Test seam: wipe the module state (deterministic proofs only) — BOTH
 *  stores (trace + phase), so a proof starts from a clean generation. */
export function resetPulseForTests(): void {
  active = null
  ring.length = 0
  lastTurnEndedAt = null
  generationCounter = 0
  armedWriteMarks = []
  resetPhaseForTests()
}

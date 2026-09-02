import { flagEnv } from '../../substrate/flagRegistry.js'

import {
  beginPhaseGeneration,
  pulseNow,
  resetPhaseForTests,
} from './turnPhase.js'

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

export type PulseEventData = Record<string, number | string | boolean>

export type PulseEvent = {
  name: string
  at: number
  data?: PulseEventData
}

export type PulseProducerOutcome =
  | 'ok'
  | 'empty'
  | 'error'
  | 'timeout'
  | 'skipped'

export type PulseProducerRecord = {
  label: string
  ms: number
  outcome: PulseProducerOutcome
  count: number
}

export type PulseTurnStatus = 'complete' | 'cancelled' | 'error' | 'abandoned'

export type PulseTurnSummary = {
  key: string
  generation: number
  status: PulseTurnStatus
  model: string | null
  effort: string | null
  cold: boolean
  idleGapMs: number | null
  dispatched: boolean
  totalMs: number
  ackMs: number | null
  localPrepMs: number | null
  providerWaitMs: number | null
  firstVisibleMs: number | null
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
  droppedEvents: number
  producers: PulseProducerRecord[]
  meta: {
    querySource?: string
    model?: string
    effort?: string
  }
  done: boolean
  idleGapMs: number | null
  pendingCompletion?: { status: PulseTurnStatus }
}

const RING_CAP = 64
const EVENT_CAP = 256
const COLD_GAP_MS = 5 * 60 * 1000

let generationCounter = 0
let active: TurnTrace | null = null
const ring: PulseTurnSummary[] = []
let lastTurnEndedAt: number | null = null


export function beginPulseTurn(meta?: TurnTrace['meta'], at?: number): number {
  if (active && !active.done) {
    completePulseTurn(active.generation, 'abandoned')
  }
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
  }
}


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

export function getLatestPulseTrace(): TurnTrace | null {
  return active
}

export function getPulseRing(): readonly PulseTurnSummary[] {
  return ring
}

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


export function isPulseMainSource(
  querySource: string,
  agentId: string | undefined,
): boolean {
  return (
    !agentId &&
    (querySource === 'sdk' || querySource.startsWith('repl_main_thread'))
  )
}

export function resetPulseForTests(): void {
  active = null
  ring.length = 0
  lastTurnEndedAt = null
  generationCounter = 0
  armedWriteMarks = []
  resetPhaseForTests()
}

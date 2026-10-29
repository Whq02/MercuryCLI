
import type { WorkflowProgressEvent } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

export const WORKFLOW_QUIET_MS = 120_000

export type WorkflowPulse = {
  phaseTitle?: string
  running: number
  settled: number
  maxAttempt: number
  lastEventAt: number
  quietMs: number
  moving: boolean
}

export type WorkflowPulseFacts = Pick<
  WorkflowPulse,
  'phaseTitle' | 'running' | 'settled' | 'maxAttempt' | 'lastEventAt'
>

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function workflowPulseAt(facts: WorkflowPulseFacts, nowMs: number): WorkflowPulse {
  const quietMs = Math.max(0, nowMs - facts.lastEventAt)
  return {
    phaseTitle: facts.phaseTitle,
    running: facts.running,
    settled: facts.settled,
    maxAttempt: facts.maxAttempt,
    lastEventAt: facts.lastEventAt,
    quietMs,
    moving: quietMs < WORKFLOW_QUIET_MS,
  }
}

export function workflowPulse(
  events: readonly WorkflowProgressEvent[],
  startTime: number,
  nowMs: number,
): WorkflowPulse {
  return workflowPulseAt(workflowPulseFacts(events, startTime), nowMs)
}

export function workflowPulseFacts(
  events: readonly WorkflowProgressEvent[],
  startTime: number,
): WorkflowPulseFacts {
  let phaseTitle: string | undefined
  let newestAgentAt = 0
  let newestAgentPhase: string | undefined
  let running = 0
  let settled = 0
  let maxAttempt = 0
  let lastEventAt = startTime
  for (const ev of events) {
    if (ev.type === 'workflow_phase') {
      phaseTitle = ev.title
      continue
    }
    if (ev.type !== 'workflow_agent') continue
    const t =
      num(ev['lastProgressAt']) ?? num(ev['startedAt']) ?? num(ev['queuedAt'])
    if (t !== undefined) {
      if (t > lastEventAt) lastEventAt = t
      if (t > newestAgentAt && ev.phaseTitle) {
        newestAgentAt = t
        newestAgentPhase = ev.phaseTitle
      }
    }
    if (ev.state === 'start' || ev.state === 'progress') {
      running++
      const a = num(ev['attempt'])
      if (a !== undefined && a > maxAttempt) maxAttempt = a
    } else {
      settled++
    }
  }
  if (newestAgentPhase !== undefined) phaseTitle = newestAgentPhase
  return {
    ...(phaseTitle !== undefined ? { phaseTitle } : {}),
    running,
    settled,
    maxAttempt,
    lastEventAt,
  }
}


export type AgentPulseInput = {
  state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
  waiting?: 'prefill' | 'provider-backoff' | 'usage-window' | 'seat' | 'operator'
  waitWords?: string
  retryInMs?: number
  recoveryTimeoutMs?: number
  retryAttempt?: number
  lastProgressAt?: number
  startedAt?: number
  lastToolName?: string
  lastToolSummary?: string
}

export type AgentPulse =
  | { kind: 'queued'; words?: string }
  | { kind: 'first-token'; words?: string }
  | { kind: 'seat'; words: string }
  | {
      kind: 'backoff'
      retryInMs?: number
      recoveryTimeoutMs?: number
      retryAttempt?: number
      words?: string
    }
  | { kind: 'working'; toolLine?: string }
  | { kind: 'usage-window'; words: string }
  | { kind: 'operator-pause'; words: string }
  | { kind: 'quiet'; toolLine?: string; quietMs: number }
  | { kind: 'settled' }

export function agentPulse(a: AgentPulseInput, nowMs: number): AgentPulse {
  if (a.state === 'start') return a.waitWords !== undefined && a.waitWords !== '' ? { kind: 'queued', words: a.waitWords } : { kind: 'queued' }
  if (a.state !== 'progress') return { kind: 'settled' }
  if (a.waiting === 'seat') return { kind: 'seat', words: a.waitWords ?? 'waiting for a seat' }
  if (a.waiting === 'usage-window') return { kind: 'usage-window', words: a.waitWords ?? 'paused — waiting for the usage window' }
  if (a.waiting === 'operator') return { kind: 'operator-pause', words: a.waitWords ?? 'paused by the operator' }
  const toolLine = a.lastToolName
    ? `${a.lastToolName}(${a.lastToolSummary ?? ''})`
    : undefined
  const lastSignal = a.lastProgressAt ?? a.startedAt
  const quietMs = lastSignal !== undefined ? Math.max(0, nowMs - lastSignal) : 0
  if (lastSignal !== undefined && quietMs >= WORKFLOW_QUIET_MS)
    return { kind: 'quiet', toolLine, quietMs }
  if (a.waiting === 'provider-backoff')
    return {
      kind: 'backoff',
      retryInMs: a.retryInMs,
      recoveryTimeoutMs: a.recoveryTimeoutMs,
      retryAttempt: a.retryAttempt,
      ...(a.waitWords !== undefined && a.waitWords !== '' ? { words: a.waitWords } : {}),
    }
  if (a.waiting === 'prefill')
    return a.waitWords !== undefined && a.waitWords !== '' ? { kind: 'first-token', words: a.waitWords } : { kind: 'first-token' }
  return { kind: 'working', toolLine }
}

export function agentPulseWord(p: AgentPulse): string {
  switch (p.kind) {
    case 'queued':
      return p.words ?? 'starting'
    case 'first-token':
      return p.words ?? 'awaiting first token'
    case 'seat':
      return p.words
    case 'backoff': {
      if (p.words !== undefined) return p.words
      if (
        (typeof p.retryInMs !== 'number' || p.retryInMs <= 0) &&
        typeof p.recoveryTimeoutMs === 'number' &&
        p.recoveryTimeoutMs > 0
      ) {
        return `retrying without streaming · ≤${Math.max(1, Math.round(p.recoveryTimeoutMs / 1000))}s`
      }
      const bits = ['provider backoff']
      if (typeof p.retryAttempt === 'number') bits.push(`retry ${p.retryAttempt}`)
      if (typeof p.retryInMs === 'number' && p.retryInMs > 0)
        bits.push(`~${Math.max(1, Math.round(p.retryInMs / 1000))}s`)
      return bits.join(' · ')
    }
    case 'working':
      return p.toolLine ?? 'thinking'
    case 'usage-window':
    case 'operator-pause':
      return p.words
    case 'quiet':
      return `quiet ${formatQuietAge(p.quietMs)}${p.toolLine ? ` · last: ${p.toolLine}` : ''}`
    case 'settled':
      return 'settled'
  }
}

export function formatQuietAge(quietMs: number): string {
  const s = Math.floor(quietMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h${rem}m` : `${h}h`
}

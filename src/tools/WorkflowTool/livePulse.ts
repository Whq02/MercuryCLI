
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

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function workflowPulse(
  events: readonly WorkflowProgressEvent[],
  startTime: number,
  nowMs: number,
): WorkflowPulse {
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
  const quietMs = Math.max(0, nowMs - lastEventAt)
  return {
    phaseTitle,
    running,
    settled,
    maxAttempt,
    lastEventAt,
    quietMs,
    moving: quietMs < WORKFLOW_QUIET_MS,
  }
}


export type AgentPulseInput = {
  state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
  waiting?: 'prefill' | 'provider-backoff'
  retryInMs?: number
  recoveryTimeoutMs?: number
  retryAttempt?: number
  lastProgressAt?: number
  startedAt?: number
  lastToolName?: string
  lastToolSummary?: string
}

export type AgentPulse =
  | { kind: 'queued' }
  | { kind: 'first-token' }
  | {
      kind: 'backoff'
      retryInMs?: number
      recoveryTimeoutMs?: number
      retryAttempt?: number
    }
  | { kind: 'working'; toolLine?: string }
  | { kind: 'quiet'; toolLine?: string; quietMs: number }
  | { kind: 'settled' }

export function agentPulse(a: AgentPulseInput, nowMs: number): AgentPulse {
  if (a.state === 'start') return { kind: 'queued' }
  if (a.state !== 'progress') return { kind: 'settled' }
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
    }
  if (a.waiting === 'prefill') return { kind: 'first-token' }
  return { kind: 'working', toolLine }
}

export function agentPulseWord(p: AgentPulse): string {
  switch (p.kind) {
    case 'queued':
      return 'queued'
    case 'first-token':
      return 'awaiting first token'
    case 'backoff': {
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

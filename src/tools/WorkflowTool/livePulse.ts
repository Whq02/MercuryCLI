// =============================================================================
// WorkflowTool/livePulse.ts — the shared "is it stuck?" pulse projector.
//
// ONE pure function all the liveness surfaces read — the transcript result
// line (workflowToolRenderers), the statusbar heartbeat chip (MercuryFrame),
// and the /tasks detail probe row (WorkflowDetailDialog) — so they can never
// disagree about what a background run is doing. AVS friction audit
// the operator killed a HEALTHY morning run ("i suspected it
// might be stuck?") and later trusted a dead one — nothing answered
// "is it stuck?" without spelunking raw JSONL.
//
// Deliberately LEAF + bun-loadable (a type-only import) so
// scripts/workflows/prove-live-pulse.ts exercises the real function.
// =============================================================================

import type { WorkflowProgressEvent } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

/**
 * Age past which a silent run reads as QUIET (the amber look-at-me cue).
 * Agent turns legitimately take minutes — quiet is a prompt to inspect,
 * never a death verdict (the runner's stall watchdog owns that call).
 */
export const WORKFLOW_QUIET_MS = 120_000

export type WorkflowPulse = {
  /** The newest phase any signal reported (live beats planned). */
  phaseTitle?: string
  /** Agents currently started/progressing (events coalesce last-write-wins). */
  running: number
  /** Agents settled done/error. */
  settled: number
  /** Highest attempt among LIVE agents (>1 ⇒ the retry ladder re-ran one). */
  maxAttempt: number
  /** Wall-clock of the newest signal any agent emitted (floor: startTime). */
  lastEventAt: number
  /** nowMs − lastEventAt, floored at 0. */
  quietMs: number
  /** quietMs < WORKFLOW_QUIET_MS — the one-glance verdict word. */
  moving: boolean
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function workflowPulse(
  events: readonly WorkflowProgressEvent[],
  startTime: number,
  nowMs: number,
): WorkflowPulse {
  // Events are coalesced by index (last-write-wins), so array order is INDEX
  // order, not chronology — recency must come from the events' own stamps.
  let phaseTitle: string | undefined
  let newestAgentAt = 0
  let newestAgentPhase: string | undefined
  let running = 0
  let settled = 0
  let maxAttempt = 0
  let lastEventAt = startTime
  for (const ev of events) {
    if (ev.type === 'workflow_phase') {
      // Phase indexes allocate monotonically, so the last phase event in
      // index order IS the newest declared phase.
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
  // An agent actively reporting under a phase is fresher truth than the last
  // declared phase header (pipeline stages overlap phases by design).
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

// ── the per-AGENT pulse ──────────────────────────────────────────
// ONE derivation of "what is this agent doing right now", read by the run
// view's lanes + dossier, the agent inspector, and the mercury://workflow
// ref — so a long provider wait can never render as "thinking" and a stale
// tool line can never present as current on any of them.

/** The producer's liveness fields, as the manifest summary carries them. */
export type AgentPulseInput = {
  state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
  waiting?: 'prefill' | 'provider-backoff'
  retryInMs?: number
  /** /H-01: a blocking recovery call's ceiling (the non-streaming
   *  fallback) — distinct from a real scheduled retry delay. */
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
  /** No signal for over WORKFLOW_QUIET_MS — the last tool line is HISTORY,
   *  not current activity. */
  | { kind: 'quiet'; toolLine?: string; quietMs: number }
  | { kind: 'settled' }

export function agentPulse(a: AgentPulseInput, nowMs: number): AgentPulse {
  if (a.state === 'start') return { kind: 'queued' }
  if (a.state !== 'progress') return { kind: 'settled' }
  const toolLine = a.lastToolName
    ? `${a.lastToolName}(${a.lastToolSummary ?? ''})`
    : undefined
  // Staleness outranks `waiting`: a LIVE backoff re-emits its frame on the
  // recovery heartbeat (agentHooks), so a stale lastProgressAt means the
  // producer stopped talking — the honest word is quiet, never an
  // eternally-current wait.
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

/** The compact display word every consumer shares for a pulse. */
export function agentPulseWord(p: AgentPulse): string {
  switch (p.kind) {
    case 'queued':
      return 'queued'
    case 'first-token':
      return 'awaiting first token'
    case 'backoff': {
      // /H-01: a recovery ceiling is not a backoff countdown — say so.
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

/** `8s` / `4m` / `1h12m` — the compact age word the pulse surfaces share. */
export function formatQuietAge(quietMs: number): string {
  const s = Math.floor(quietMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h${rem}m` : `${h}h`
}

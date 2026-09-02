// ============================================================================
//  agentResults/lifecycle — THE subagent lifecycle vocabulary (spec 03-C2):
//  running → idle → parked, aborted beside them — DERIVED from the facts the
//  existing owners already hold (task status, completion stamp, transcript),
//  never a second store.
//
//  RECONCILIATION (keep-not-chase, never-reduce): Mercury's resume law is
//  MORE capable than the parity source's aborted-is-terminal — SendMessage
//  revives a stopped/killed agent from its transcript WITH the new message,
//  and that stays. The vocabulary still NAMES the aborted state so rosters
//  can say it; `revivable` carries Mercury's truth per state. The
//  idle/parked split is a TTL bucket over the same revival path: 'idle'
//  marks the provider-cache-warm window where a revival replays cheaply;
//  'parked' marks the cold, transcript-backed state. A held-open child
//  session ("attached idle") is a future optimization behind the same
//  vocabulary — the states are the contract, the heat is an implementation.
//
//  Consumers: rosters/monitor rows, SendMessage surfaces, provers.
// ============================================================================

/** The cache-warm revival window: matches the provider prompt-cache
 *  lifetime, so 'idle' honestly means "a revival replays warm". */
export const IDLE_TTL_MS = 5 * 60 * 1000

export type AgentLifecycleState = 'running' | 'idle' | 'parked' | 'aborted'

export interface AgentLifecycle {
  state: AgentLifecycleState
  /** Mercury's revival truth for THIS state (messaging is the one resume
   *  primitive; aborted agents stay revivable — the documented divergence). */
  revivable: boolean
  /** One honest sentence a roster row or refusal can print verbatim. */
  basis: string
}

export interface AgentLifecycleFacts {
  /** The task status from the task registry (the owning store), or
   *  undefined when only the on-disk transcript remains. */
  taskStatus?: string
  /** When the run reached a terminal status (ms epoch); undefined while
   *  running or when the registry no longer holds the row. */
  finishedAtMs?: number
  /** A persisted transcript exists (the revival substrate). */
  transcriptExists: boolean
  now?: number
}

const TERMINAL_ABORTED = new Set(['killed', 'failed'])
const LIVE = new Set(['pending', 'running'])

/** The ONE derivation every roster and refusal reads. */
export function deriveAgentLifecycle(facts: AgentLifecycleFacts): AgentLifecycle {
  const now = facts.now ?? Date.now()
  if (facts.taskStatus !== undefined && LIVE.has(facts.taskStatus)) {
    return {
      state: 'running',
      revivable: false,
      basis: 'running — messages queue and deliver at its next tool round',
    }
  }
  if (facts.taskStatus !== undefined && TERMINAL_ABORTED.has(facts.taskStatus)) {
    return {
      state: 'aborted',
      revivable: facts.transcriptExists,
      basis: facts.transcriptExists
        ? `aborted (${facts.taskStatus}) — a SendMessage revives it from its transcript with your message`
        : `aborted (${facts.taskStatus}) — no transcript persisted; nothing to revive`,
    }
  }
  if (!facts.transcriptExists) {
    return {
      state: 'aborted',
      revivable: false,
      basis: 'no transcript persisted; nothing to revive',
    }
  }
  const age = facts.finishedAtMs !== undefined ? now - facts.finishedAtMs : Number.POSITIVE_INFINITY
  if (age <= IDLE_TTL_MS) {
    return {
      state: 'idle',
      revivable: true,
      basis: 'finished moments ago — a SendMessage revives it warm (the prompt cache still holds its prefix)',
    }
  }
  return {
    state: 'parked',
    revivable: true,
    basis: 'parked — the transcript is retained; a SendMessage revives it (cold replay)',
  }
}


export const IDLE_TTL_MS = 5 * 60 * 1000

export type AgentLifecycleState = 'running' | 'idle' | 'parked' | 'aborted'

export interface AgentLifecycle {
  state: AgentLifecycleState
  revivable: boolean
  basis: string
}

export interface AgentLifecycleFacts {
  taskStatus?: string
  finishedAtMs?: number
  transcriptExists: boolean
  now?: number
}

const TERMINAL_ABORTED = new Set(['killed', 'failed'])
const LIVE = new Set(['pending', 'running'])

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

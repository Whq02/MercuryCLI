// ============================================================================
//  teamPhases — the REAL lifecycle model for team members.
//  Phases derive from actual task/runner/mailbox state, never from elapsed
//  time; operator-facing vocabulary says "waiting" (ready for more work), not
//  "idle" (which read as stuck). One derivation shared by the Team Center
//  list rows, the detail card, and doctor.
// ============================================================================

import type { TaskStatus } from '../../Task.js'

export type TeamMemberPhase =
  | 'planned'
  | 'spawning'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'handoff-ready'
  | 'done'
  | 'stopping'
  | 'stopped'
  | 'failed'

/** The state slice the derivation needs (structural — accepts the immutable
 *  InProcessTeammateTaskState without importing its full type). */
export type TeammatePhaseInputs = {
  status: TaskStatus
  isIdle: boolean
  shutdownRequested: boolean
  awaitingPlanApproval: boolean
  /** progress is undefined until the first tracked activity lands. */
  hasProgress: boolean
  /** The last assistant action was a handoff message to the lead. */
  lastActionWasLeadHandoff?: boolean
}

export function deriveTeammatePhase(t: TeammatePhaseInputs): TeamMemberPhase {
  // Terminal states first — they outrank every flag.
  if (t.status === 'failed') return 'failed'
  if (t.status === 'killed') return 'stopped'
  if (t.status === 'completed') return 'done'
  if (t.status === 'pending') return 'planned'
  // Running: order matters — a shutdown in flight outranks waiting;
  // a plan-approval gate is genuinely BLOCKED on a decision, never inferred
  // from elapsed time.
  if (t.shutdownRequested) return 'stopping'
  if (t.awaitingPlanApproval) return 'blocked'
  if (t.isIdle) {
    return t.lastActionWasLeadHandoff ? 'handoff-ready' : 'waiting'
  }
  // Running + not idle + nothing tracked yet = still coming up.
  if (!t.hasProgress) return 'spawning'
  return 'working'
}

/** Operator-facing label — the stable vocabulary every surface shares. */
export function teammatePhaseLabel(p: TeamMemberPhase): string {
  switch (p) {
    case 'blocked':
      return 'blocked — awaiting approval'
    case 'handoff-ready':
      return 'handoff ready'
    default:
      return p
  }
}

/**
 * Detect whether the teammate's most recent assistant action was a handoff to
 * the lead (a SendMessage tool_use addressed to it). Structural over the task
 * message mirror; anything unparseable is simply "not a handoff".
 */
export function lastActionWasLeadHandoff(
  messages: ReadonlyArray<unknown> | undefined,
  leadName = 'team-lead',
): boolean {
  if (!messages || messages.length === 0) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      type?: string
      message?: { content?: unknown }
    }
    if (m?.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) return false
    return content.some(block => {
      const b = block as { type?: string; name?: string; input?: { to?: unknown } }
      return (
        b?.type === 'tool_use' &&
        b.name === 'SendMessage' &&
        typeof b.input?.to === 'string' &&
        (b.input.to === leadName || b.input.to === '*')
      )
    })
  }
  return false
}

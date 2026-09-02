
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

export type TeammatePhaseInputs = {
  status: TaskStatus
  isIdle: boolean
  shutdownRequested: boolean
  awaitingPlanApproval: boolean
  hasProgress: boolean
  lastActionWasLeadHandoff?: boolean
}

export function deriveTeammatePhase(t: TeammatePhaseInputs): TeamMemberPhase {
  if (t.status === 'failed') return 'failed'
  if (t.status === 'killed') return 'stopped'
  if (t.status === 'completed') return 'done'
  if (t.status === 'pending') return 'planned'
  if (t.shutdownRequested) return 'stopping'
  if (t.awaitingPlanApproval) return 'blocked'
  if (t.isIdle) {
    return t.lastActionWasLeadHandoff ? 'handoff-ready' : 'waiting'
  }
  if (!t.hasProgress) return 'spawning'
  return 'working'
}

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

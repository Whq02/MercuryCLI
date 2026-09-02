
import { formatDuration, formatTokens } from '../../utils/format.js'
import { GLYPH } from '../mercury-ui/glyphs.js'

export type WorkflowRollupFacts = {
  agentsDone: number
  agentCount: number
  elapsedMs: number
  tokens: number
}

export function workflowRollupLine(f: WorkflowRollupFacts): string {
  const parts: string[] = []
  if (f.agentCount > 0) parts.push(`${f.agentsDone}/${f.agentCount} agents`)
  if (f.tokens > 0) parts.push(`${GLYPH.tokens} ${formatTokens(f.tokens)}`)
  parts.push(formatDuration(Math.max(0, f.elapsedMs)))
  return parts.join(' · ')
}

export function agentsDoneOf(agents: readonly { state: string }[]): number {
  return agents.filter(a => a.state === 'done').length
}

export type WorkflowPhaseTone = 'settled' | 'active' | 'error' | 'pending'

export function phaseTone(g: {
  planned: boolean
  agents: readonly { state: string }[]
}): WorkflowPhaseTone {
  if (g.agents.length > 0) {
    if (g.agents.some(a => a.state === 'error')) return 'error'
    if (g.agents.every(a => a.state === 'done' || a.state === 'skipped'))
      return 'settled'
    if (g.agents.some(a => a.state === 'start' || a.state === 'progress'))
      return 'active'
  }
  return 'pending'
}

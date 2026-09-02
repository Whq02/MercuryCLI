// workflowRollup — the React-free rollup grammar for workflow runs.
//
// ONE source for the compact live-rollup line (`0/3 agents · 1m 1s · ◈ 287.3k`)
// and the per-phase settlement tone, shared by the /workflows board
// (WorkflowsBoard.tsx — header rollup, Phases column, side info pane) and the
// inline transcript rows (WorkflowRunningIndicator.tsx), so the two surfaces
// can never drift on how a run's progress reads. Deliberately a leaf (no Ink,
// no React, no fs): scripts/ui/prove-workflows-board.ts bun-imports it directly
// and pins the grammar as a regression needle (bun-run-proof-loadability).
//
// HONESTY: segments are OMITTED when their datum doesn't exist — a run with no
// registered agents shows no `0/0 agents`, a zero-token run shows no `◈ 0` —
// never a fabricated zero (STATE_STYLE.unavailable is the component-level
// spelling; here the segment simply isn't emitted).

import { formatDuration, formatTokens } from '../../utils/format.js'
import { GLYPH } from '../mercury-ui/glyphs.js'

export type WorkflowRollupFacts = {
  /** Agents that have settled `done` (agentsDoneOf below). */
  agentsDone: number
  /** Agents registered so far (LocalWorkflowTaskState.agentCount / manifest). */
  agentCount: number
  /** Wall-clock runtime (running: now-start · settled: end-start). */
  elapsedMs: number
  /** Total tokens spent across the run's agents. */
  tokens: number
}

/** `{done}/{total} agents · {elapsed} · ◈ {tokens}` with honest omissions. */
export function workflowRollupLine(f: WorkflowRollupFacts): string {
  // Counts first, the clock last: elapsed time is subordinate to what the
  // run has done (the same order every agent row keeps).
  const parts: string[] = []
  if (f.agentCount > 0) parts.push(`${f.agentsDone}/${f.agentCount} agents`)
  if (f.tokens > 0) parts.push(`${GLYPH.tokens} ${formatTokens(f.tokens)}`)
  parts.push(formatDuration(Math.max(0, f.elapsedMs)))
  return parts.join(' · ')
}

/** Count of settled-done agents in any agent rollup list. */
export function agentsDoneOf(agents: readonly { state: string }[]): number {
  return agents.filter(a => a.state === 'done').length
}

// Per-phase settlement tone — the same rule PhaseBlock's head color speaks
// (WorkflowDetailDialog.tsx: errored → CRIMSON, settled → TEAL, in-flight →
// AMBER, planned → SECOND), reduced to a pure token so the board's phase-dot
// strip and its Phases rail agree with the tree view by construction.
export type WorkflowPhaseTone = 'settled' | 'active' | 'error' | 'pending'

export function phaseTone(g: {
  planned: boolean
  agents: readonly { state: string }[]
}): WorkflowPhaseTone {
  if (g.agents.length > 0) {
    if (g.agents.some(a => a.state === 'error')) return 'error'
    if (g.agents.every(a => a.state === 'done' || a.state === 'skipped'))
      return 'settled'
    // 'active' claims motion (amber dot + the board's cursor) — only an agent
    // genuinely in flight earns it. A 'stopped' residue (parent settled
    // mid-flight) mutes to 'pending': nothing is current there.
    if (g.agents.some(a => a.state === 'start' || a.state === 'progress'))
      return 'active'
  }
  return 'pending'
}

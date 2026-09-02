// ============================================================================
//  sessionClass — operator sessions vs ROUTER-CREW sessions (task #73/#75
//  operator ask: "the session manager only shows the dps sessions
//  … proper separation so routers are classed distinctly from sessions").
//
//  Every daemon-hosted seat (party tank/dps, scribe Implementer) runs as a
//  headless child spawned with the --team-name/--agent-name triplet
//  (headlessRun.ts), and the session writer stamps that onto the log
//  (sessionStorage teamName/isTeammate). Those transcripts are real files in
//  the same projects tree, so after one party run the switcher/tab-strip
//  flooded with seat sessions that LOOK like operator work (they pass the
//  substance filter: real prompts, large files).
//
//  Classification is by the STAMPS first (deterministic), with two belt
//  heuristics for logs written before the stamps existed: the executor lane
//  worktree path, and the bus-bridge first-prompt shapes (a seat's first
//  stdin frame is always bridge-formatted: a framed dispatch, [control …],
//  [progress …], [escalate…], or an operator-note label).
// ============================================================================
import type { LogOption } from '../types/logs.js'

export type SessionClass = 'operator' | 'crew'

const LANE_PATH = /[\\/]\.mercury[\\/]party[\\/]lanes[\\/]|[\\/]party_dps\d/
const BRIDGE_FIRST_PROMPT =
  /^(\[control (ack|pause|resume|stop|clear)\]|\[progress |\[escalate\]|\[operator note\]|\[operator broadcast\])/
const FRAMED_DISPATCH_HEAD =
  'Dispatched work, relayed over the bus with the dispatcher'

/** True when the log is a router-crew child session (party seat / scribe
 *  Implementer), not the operator's own work. */
export function isCrewSession(log: LogOption): boolean {
  if (log.isTeammate) return true
  if (log.teamName && log.teamName.trim() !== '') return true
  const p = (log as { projectPath?: string }).projectPath ?? log.fullPath ?? ''
  if (LANE_PATH.test(p)) return true
  const fp = (log.firstPrompt ?? '').trim()
  if (fp.includes(FRAMED_DISPATCH_HEAD)) return true
  return BRIDGE_FIRST_PROMPT.test(fp)
}

/** Short crew tag for display: 'party · dps1', 'scribe · implementer', … */
export function crewTagOf(log: LogOption): string {
  const team = (log.teamName ?? '').trim()
  const agent = (log.agentName ?? '').trim()
  if (team && agent) return `${team} · ${agent}`
  if (team) return team
  if (agent) return agent
  const p = (log as { projectPath?: string }).projectPath ?? log.fullPath ?? ''
  const lane = /party_(dps\d|tank|healer)/.exec(p)?.[1]
  return lane ? `party · ${lane}` : 'crew'
}

// ============================================================================
//  sessionClass — operator sessions vs daemon-CREW sessions (the session
//  manager must class daemon-hosted seats distinctly from the operator's own
//  sessions).
//
//  Every daemon-hosted seat (a crew teammate, a concourse worker) runs as a
//  headless child spawned with the --team-name/--agent-name triplet
//  (headlessRun.ts), and the session writer stamps that onto the log
//  (sessionStorage teamName/isTeammate). Those transcripts are real files in
//  the same projects tree, so without a class the switcher/tab-strip fills
//  with seat sessions that LOOK like operator work (they pass the substance
//  filter: real prompts, large files).
//
//  Classification is by the STAMPS first (deterministic), with one belt
//  heuristic for logs written before the stamps existed: the bus-bridge
//  first-prompt shapes (a seat's first stdin frame is always
//  bridge-formatted: a framed dispatch, [control …], [progress …],
//  [escalate…], or an operator-note label).
// ============================================================================
import type { LogOption } from '../types/logs.js'

export type SessionClass = 'operator' | 'crew'

const BRIDGE_FIRST_PROMPT =
  /^(\[control (ack|pause|resume|stop|clear)\]|\[progress |\[escalate\]|\[operator note\]|\[operator broadcast\])/
const FRAMED_DISPATCH_HEAD =
  'Dispatched work, relayed over the bus with the dispatcher'

/** True when the log is a daemon-crew child session, not the operator's own
 *  work. */
export function isCrewSession(log: LogOption): boolean {
  if (log.isTeammate) return true
  if (log.teamName && log.teamName.trim() !== '') return true
  const fp = (log.firstPrompt ?? '').trim()
  if (fp.includes(FRAMED_DISPATCH_HEAD)) return true
  return BRIDGE_FIRST_PROMPT.test(fp)
}

/** Short crew tag for display: 'crew · scout', … */
export function crewTagOf(log: LogOption): string {
  const team = (log.teamName ?? '').trim()
  const agent = (log.agentName ?? '').trim()
  if (team && agent) return `${team} · ${agent}`
  if (team) return team
  if (agent) return agent
  return 'crew'
}

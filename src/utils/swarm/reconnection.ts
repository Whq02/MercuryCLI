import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getDynamicTeamContext } from '../teammate.js'
import { getTeamFilePath, readTeamFile } from './teamHelpers.js'

/**
 * Computes the session's team context for fresh and resumed teammate
 * sessions.
 */

/**
 * The initial team context, computed synchronously before the first render
 * from the dynamic teammate context set from CLI args. Not a teammate
 * session (no team or agent name) ⇒ undefined.
 */
export function computeInitialTeamContext(): AppState['teamContext'] | undefined {
  const dynamic = getDynamicTeamContext()
  if (!dynamic || !dynamic.teamName || !dynamic.agentName) {
    logForDebugging('team context: no dynamic teammate identity — not a teammate session')
    return undefined
  }
  const roster = readTeamFile(dynamic.teamName)
  if (roster === null) {
    logError(new Error(`team context: the roster for ${dynamic.teamName} is unreadable`))
    return undefined
  }
  return {
    teamName: dynamic.teamName,
    teamFilePath: getTeamFilePath(dynamic.teamName),
    leadAgentId: roster.leadAgentId,
    ...(dynamic.agentId ? { selfAgentId: dynamic.agentId } : {}),
    selfAgentName: dynamic.agentName,
    isLeader: !dynamic.agentId,
    teammates: {},
  }
}

/**
 * Install the team context for a resumed session, from the team and agent
 * name recovered from the transcript. A missing roster member is only a
 * debug log — the agent id is then undefined and the session continues.
 */
export function initializeTeammateContextFromSession(
  setAppState: (updater: (prevState: AppState) => AppState) => void,
  teamName: string,
  agentName: string,
): void {
  const roster = readTeamFile(teamName)
  if (roster === null) {
    logError(
      new Error(`team context: the roster for ${teamName} is missing — resumed team context not restored`),
    )
    return
  }
  const member = roster.members.find(candidate => candidate.name === agentName)
  if (member === undefined) {
    logForDebugging(`team context: resumed member ${agentName} not found in ${teamName}`)
  }
  setAppState(prevState => ({
    ...prevState,
    teamContext: {
      teamName,
      teamFilePath: getTeamFilePath(teamName),
      leadAgentId: roster.leadAgentId,
      ...(member?.agentId ? { selfAgentId: member.agentId } : {}),
      selfAgentName: agentName,
      isLeader: false,
      teammates: {},
    },
  }))
}

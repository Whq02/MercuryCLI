import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getDynamicTeamContext } from '../teammate.js'
import { getTeamFilePath, readTeamFile } from './teamHelpers.js'


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

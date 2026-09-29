import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getDynamicCrewContext } from '../crewmate.js'
import { getCrewFilePath, readCrewFile } from './crewHelpers.js'


export function computeInitialCrewContext(): AppState['crewContext'] | undefined {
  const dynamic = getDynamicCrewContext()
  if (!dynamic || !dynamic.teamName || !dynamic.agentName) {
    logForDebugging('team context: no dynamic teammate identity — not a teammate session')
    return undefined
  }
  const roster = readCrewFile(dynamic.teamName)
  if (roster === null) {
    logError(new Error(`team context: the roster for ${dynamic.teamName} is unreadable`))
    return undefined
  }
  return {
    teamName: dynamic.teamName,
    crewFilePath: getCrewFilePath(dynamic.teamName),
    leadAgentId: roster.leadAgentId,
    ...(dynamic.agentId ? { selfAgentId: dynamic.agentId } : {}),
    selfAgentName: dynamic.agentName,
    isLeader: !dynamic.agentId,
    crewmates: {},
  }
}

export function initializeCrewmateContextFromSession(
  setAppState: (updater: (prevState: AppState) => AppState) => void,
  teamName: string,
  agentName: string,
): void {
  const roster = readCrewFile(teamName)
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
    crewContext: {
      teamName,
      crewFilePath: getCrewFilePath(teamName),
      leadAgentId: roster.leadAgentId,
      ...(member?.agentId ? { selfAgentId: member.agentId } : {}),
      selfAgentName: agentName,
      isLeader: false,
      crewmates: {},
    },
  }))
}

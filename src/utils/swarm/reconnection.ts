import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getDynamicCrewContext } from '../crewmate.js'
import { getCrewFilePath, readCrewFile } from './crewHelpers.js'


export function computeInitialCrewContext(): AppState['crewContext'] | undefined {
  const dynamic = getDynamicCrewContext()
  if (!dynamic || !dynamic.crewName || !dynamic.agentName) {
    logForDebugging('crew context: no dynamic crewmate identity — not a crewmate session')
    return undefined
  }
  const roster = readCrewFile(dynamic.crewName)
  if (roster === null) {
    logError(new Error(`crew context: the roster for ${dynamic.crewName} is unreadable`))
    return undefined
  }
  return {
    crewName: dynamic.crewName,
    crewFilePath: getCrewFilePath(dynamic.crewName),
    leadAgentId: roster.leadAgentId,
    ...(dynamic.agentId ? { selfAgentId: dynamic.agentId } : {}),
    selfAgentName: dynamic.agentName,
    isLeader: !dynamic.agentId,
    crewmates: {},
  }
}

export function initializeCrewmateContextFromSession(
  setAppState: (updater: (prevState: AppState) => AppState) => void,
  crewName: string,
  agentName: string,
): void {
  const roster = readCrewFile(crewName)
  if (roster === null) {
    logError(
      new Error(`crew context: the roster for ${crewName} is missing — resumed crew context not restored`),
    )
    return
  }
  const member = roster.members.find(candidate => candidate.name === agentName)
  if (member === undefined) {
    logForDebugging(`crew context: resumed member ${agentName} not found in ${crewName}`)
  }
  setAppState(prevState => ({
    ...prevState,
    crewContext: {
      crewName,
      crewFilePath: getCrewFilePath(crewName),
      leadAgentId: roster.leadAgentId,
      ...(member?.agentId ? { selfAgentId: member.agentId } : {}),
      selfAgentName: agentName,
      isLeader: false,
      crewmates: {},
    },
  }))
}

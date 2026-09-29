import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppStateStore.js'
import { formatAgentId } from '../agentId.js'
import { getCwd } from '../cwd.js'
import { CREW_LEAD_NAME } from '../swarm/constants.js'
import { getCrewFilePath, type CrewFile } from '../swarm/crewHelpers.js'
import { crewChildName, getLeadCrewFallback, getCrewName, isCrewmate, setLeadCrewFallback } from '../crewmate.js'

export type CrewContext = NonNullable<AppState['crewContext']>

export function sessionCrewName(sessionId: string): string {
  return sessionId
}

export function crewLeadAgentId(crewName: string): string {
  return formatAgentId(CREW_LEAD_NAME, crewName)
}

export function bornCrewContext(sessionId: string): CrewContext {
  const crewName = sessionCrewName(sessionId)
  return {
    crewName,
    crewFilePath: getCrewFilePath(crewName),
    leadAgentId: crewLeadAgentId(crewName),
    isLeader: true,
    crewmates: {},
  }
}

export function bornCrewRoster(sessionId: string, cwd: string): CrewFile {
  const name = sessionCrewName(sessionId)
  const leadAgentId = crewLeadAgentId(name)
  const now = Date.now()
  return {
    name,
    createdAt: now,
    leadAgentId,
    leadSessionId: sessionId,
    members: [
      {
        agentId: leadAgentId,
        name: CREW_LEAD_NAME,
        agentType: CREW_LEAD_NAME,
        joinedAt: now,
        tmuxPaneId: '',
        cwd,
        subscriptions: [],
      },
    ],
  }
}

export function isSessionCrew(crewName: string): boolean {
  return crewName === sessionCrewName(String(getSessionId()))
}

export function foundingRosterFor(crewName: string): CrewFile | null {
  if (!isSessionCrew(crewName)) return null
  return bornCrewRoster(String(getSessionId()), getCwd())
}

export function crewContextFor(crewName: string): CrewContext {
  if (isSessionCrew(crewName)) return bornCrewContext(String(getSessionId()))
  return { crewName, crewFilePath: '', leadAgentId: '', crewmates: {} }
}

export function resolveSpawnCrew(crewContext: { crewName: string } | undefined): string {
  return getCrewName(crewContext) ?? sessionCrewName(String(getSessionId()))
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

export function isBornCrewWithoutCrewmates(crewContext: AppState['crewContext']): boolean {
  return crewContext !== undefined && crewContext.isLeader === true && Object.keys(crewContext.crewmates).length === 0
}

export function birthSessionCrew(sessionId: string, setAppState?: SetAppState): string | null {
  if (isCrewmate() || crewChildName() !== undefined) return null
  if (getLeadCrewFallback() === null) setLeadCrewFallback(sessionCrewName(sessionId))
  setAppState?.(prev => (prev.crewContext !== undefined ? prev : { ...prev, crewContext: bornCrewContext(sessionId) }))
  void import('./crewConvert.js').then(convert => convert.bootCrewConversion())
  return getLeadCrewFallback()
}

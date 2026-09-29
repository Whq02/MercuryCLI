import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppStateStore.js'
import { formatAgentId } from '../agentId.js'
import { getCwd } from '../cwd.js'
import { TEAM_LEAD_NAME } from '../swarm/constants.js'
import { getTeamFilePath, type TeamFile } from '../swarm/teamHelpers.js'
import { getLeadTeamFallback, getTeamName, isTeammate, setLeadTeamFallback } from '../teammate.js'

export type CrewContext = NonNullable<AppState['teamContext']>

export function sessionCrewName(sessionId: string): string {
  return sessionId
}

export function crewLeadAgentId(crewName: string): string {
  return formatAgentId(TEAM_LEAD_NAME, crewName)
}

export function bornCrewContext(sessionId: string): CrewContext {
  const teamName = sessionCrewName(sessionId)
  return {
    teamName,
    teamFilePath: getTeamFilePath(teamName),
    leadAgentId: crewLeadAgentId(teamName),
    isLeader: true,
    teammates: {},
  }
}

export function bornCrewRoster(sessionId: string, cwd: string): TeamFile {
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
        name: TEAM_LEAD_NAME,
        agentType: TEAM_LEAD_NAME,
        joinedAt: now,
        tmuxPaneId: '',
        cwd,
        subscriptions: [],
      },
    ],
  }
}

export function isSessionCrew(teamName: string): boolean {
  return teamName === sessionCrewName(String(getSessionId()))
}

export function foundingRosterFor(teamName: string): TeamFile | null {
  if (!isSessionCrew(teamName)) return null
  return bornCrewRoster(String(getSessionId()), getCwd())
}

export function crewContextFor(teamName: string): CrewContext {
  if (isSessionCrew(teamName)) return bornCrewContext(String(getSessionId()))
  return { teamName, teamFilePath: '', leadAgentId: '', teammates: {} }
}

export function resolveSpawnCrew(teamContext: { teamName: string } | undefined): string {
  return getTeamName(teamContext) ?? sessionCrewName(String(getSessionId()))
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

export function isBornCrewWithoutCrewmates(teamContext: AppState['teamContext']): boolean {
  return teamContext !== undefined && teamContext.isLeader === true && Object.keys(teamContext.teammates).length === 0
}

export function birthSessionCrew(sessionId: string, setAppState?: SetAppState): string | null {
  if (isTeammate()) return null
  if (getLeadTeamFallback() === null) setLeadTeamFallback(sessionCrewName(sessionId))
  setAppState?.(prev => (prev.teamContext !== undefined ? prev : { ...prev, teamContext: bornCrewContext(sessionId) }))
  return getLeadTeamFallback()
}

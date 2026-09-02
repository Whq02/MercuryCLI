import { getTeamFilePath } from '../swarm/teamHelpers.js'
import { getLeadTeamFallback, setLeadTeamFallback } from '../teammate.js'
import { scribeBusLiveEnabled } from './scribeGates.js'
import { armImplementerTelemetryPoll } from './implementerTelemetry.js'

export const SCRIBE_TEAM = 'scribe' as const
export const SCRIBE_LEAD_AGENT_ID = 'scribe@scribe' as const

export type ScribeTeamStore = {
  getState: () => { teamContext?: unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: (updater: (prev: any) => any) => void
}

let priorTeamContext: { value: unknown; leadFallback: string | null } | null = null

export function __resetScribeTeamStash(): void {
  priorTeamContext = null
}

export function buildScribeTeamContext(): Record<string, unknown> {
  return {
    teamName: SCRIBE_TEAM,
    teamFilePath: getTeamFilePath(SCRIBE_TEAM),
    leadAgentId: SCRIBE_LEAD_AGENT_ID,
    isLeader: true,
    selfAgentId: SCRIBE_LEAD_AGENT_ID,
    selfAgentName: 'team-lead',
    teammates: {},
  }
}

export function engageScribeTeam(store: ScribeTeamStore): void {
  if (!scribeBusLiveEnabled()) return
  armImplementerTelemetryPoll()
  if (priorTeamContext !== null) return
  const st = store.getState()
  priorTeamContext = { value: st.teamContext, leadFallback: getLeadTeamFallback() }
  store.setState(prev => ({ ...prev, teamContext: buildScribeTeamContext() }))
  setLeadTeamFallback(SCRIBE_TEAM)
}

export function disengageScribeTeam(store: ScribeTeamStore): void {
  if (!scribeBusLiveEnabled()) return
  if (priorTeamContext === null) return
  const prior = priorTeamContext.value
  setLeadTeamFallback(priorTeamContext.leadFallback)
  priorTeamContext = null
  store.setState(prev => ({ ...prev, teamContext: prior }))
}

export function isScribeTeamEngaged(): boolean {
  return priorTeamContext !== null
}

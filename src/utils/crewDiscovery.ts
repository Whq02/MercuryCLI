import { CREW_LEAD_NAME } from './swarm/constants.js'
import { readCrewFile } from './swarm/crewHelpers.js'


export type CrewSummary = {
  name: string
  memberCount: number
  runningCount: number
  idleCount: number
}

export type CrewmateStatus = {
  name: string
  agentId: string
  agentType?: string
  model?: string
  prompt?: string
  status: 'running' | 'idle' | 'unknown'
  color?: string
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  mode?: string
  isHidden: boolean
  backendType?: 'tmux' | 'iterm2'
  idleSince?: number
}

const RECOGNISED_BACKENDS: ReadonlySet<string> = new Set(['tmux', 'iterm2'])

export function getCrewmateStatuses(teamName: string): CrewmateStatus[] {
  const crewFile = readCrewFile(teamName)
  if (!crewFile) return []
  const hiddenPanes = new Set(crewFile.hiddenPaneIds ?? [])
  return crewFile.members
    .filter(member => member.name !== CREW_LEAD_NAME)
    .map(member => ({
      name: member.name,
      agentId: member.agentId,
      agentType: member.agentType,
      model: member.model,
      prompt: member.prompt,
      status: member.isActive !== false ? ('running' as const) : ('idle' as const),
      color: member.color,
      tmuxPaneId: member.tmuxPaneId,
      cwd: member.cwd,
      worktreePath: member.worktreePath,
      mode: member.mode,
      isHidden: hiddenPanes.has(member.tmuxPaneId),
      ...(member.backendType !== undefined && RECOGNISED_BACKENDS.has(member.backendType)
        ? { backendType: member.backendType as 'tmux' | 'iterm2' }
        : {}),
    }))
}

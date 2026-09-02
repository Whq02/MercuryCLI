import { TEAM_LEAD_NAME } from './swarm/constants.js'
import { readTeamFile } from './swarm/teamHelpers.js'


export type TeamSummary = {
  name: string
  memberCount: number
  runningCount: number
  idleCount: number
}

export type TeammateStatus = {
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

export function getTeammateStatuses(teamName: string): TeammateStatus[] {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return []
  const hiddenPanes = new Set(teamFile.hiddenPaneIds ?? [])
  return teamFile.members
    .filter(member => member.name !== TEAM_LEAD_NAME)
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

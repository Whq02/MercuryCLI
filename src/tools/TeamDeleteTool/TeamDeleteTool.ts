import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { clearLeaderTeamName } from '../../utils/tasks.js'
import { setLeadTeamFallback } from '../../utils/teammate.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { readTeamFile, unregisterTeamForSessionCleanup } from '../../utils/swarm/teamHelpers.js'
import { performTeamDeleteOperation } from '../../utils/swarm/teamOperations.js'
import { clearTeammateColors } from '../../utils/swarm/teammateLayoutManager.js'
import { TEAM_DELETE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'


const inputSchema = z.strictObject({})

export type Input = z.infer<typeof inputSchema>

export type Output = {
  success: boolean
  message: string
  team_name?: string
}

export function liveTeammateOf(tasks: Record<string, unknown>, member: { agentId: string; name: string }): InProcessTeammateTaskState | undefined {
  let found: InProcessTeammateTaskState | undefined
  for (const task of Object.values(tasks ?? {})) {
    if (!isInProcessTeammateTask(task)) continue
    if (task.identity.agentId !== member.agentId && task.identity.agentName !== member.name) continue
    if (task.status === 'running') return task
    found ??= task
  }
  return found
}

export function memberStillWorking(tasks: Record<string, unknown>, member: { agentId: string; name: string; isActive?: boolean }): boolean {
  const live = liveTeammateOf(tasks, member)
  if (live !== undefined) return live.status === 'running' && !live.isIdle
  return member.isActive !== false
}

async function runDelete(context: ToolUseContext): Promise<Output> {
  const teamName = context.getAppState().teamContext?.teamName

  if (teamName) {
    const teamFile = readTeamFile(teamName)
    if (teamFile) {
      const tasks = context.getAppState().tasks ?? {}
      const members = (teamFile.members ?? []).filter(member => member.name !== TEAM_LEAD_NAME)
      const activeMembers = members.filter(member => memberStillWorking(tasks, member))
      if (activeMembers.length > 0) {
        return {
          success: false,
          team_name: teamName,
          message: `Cannot delete team "${teamName}": ${activeMembers.length} teammate(s) still active (${activeMembers
            .map(member => member.name)
            .join(', ')}). Gracefully terminate them first with requestShutdown.`,
        }
      }
      for (const member of members) {
        const live = liveTeammateOf(tasks, member)
        if (live !== undefined && live.status === 'running' && live.isIdle) live.abortController?.abort()
      }
    }

    await performTeamDeleteOperation(teamName)
    unregisterTeamForSessionCleanup(teamName)
    clearTeammateColors()
    clearLeaderTeamName()
    setLeadTeamFallback(null)
  }

  context.setAppState(prevState => ({
    ...prevState,
    teamContext: undefined,
    inbox: { messages: [] },
  }))

  return teamName
    ? {
        success: true,
        team_name: teamName,
        message: `Team "${teamName}" deleted — its directories and worktrees were cleaned up.`,
      }
    : { success: true, message: 'No team name found; nothing to clean up.' }
}

export const TeamDeleteTool = buildTool({
  name: TEAM_DELETE_TOOL_NAME,
  userFacingName: () => '',
  searchHint: 'disbands a swarm team and cleans up',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  isEnabled: () => isAgentSwarmsEnabled(),
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async description(): Promise<string> {
    return 'Clean up the team and task directories when the swarm is complete.'
  },
  async prompt(): Promise<string> {
    return getPrompt()
  },
  async call(_input: Input, context: ToolUseContext) {
    return { data: await runDelete(context) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolResultMessage,
  renderToolUseErrorMessage: () => null,
})

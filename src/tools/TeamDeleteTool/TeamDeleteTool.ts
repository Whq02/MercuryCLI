import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
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

/**
 * Disbands the current team: refuses while any non-lead member is still
 * active, then rolls the durable delete forward (a half-completed delete
 * completes at the next boot — it never resurrects) and clears every
 * leader-side registration.
 */

const inputSchema = z.strictObject({})

export type Input = z.infer<typeof inputSchema>

export type Output = {
  success: boolean
  message: string
  team_name?: string
}

async function runDelete(context: ToolUseContext): Promise<Output> {
  const teamName = context.getAppState().teamContext?.teamName

  if (teamName) {
    const teamFile = readTeamFile(teamName)
    if (teamFile) {
      // A member whose active flag is exactly false is idle or dead and
      // does not block deletion; an absent flag counts as active.
      const activeMembers = (teamFile.members ?? [])
        .filter(member => member.name !== TEAM_LEAD_NAME)
        .filter(member => member.isActive !== false)
      if (activeMembers.length > 0) {
        return {
          success: false,
          team_name: teamName,
          message: `Cannot delete team "${teamName}": ${activeMembers.length} teammate(s) still active (${activeMembers
            .map(member => member.name)
            .join(', ')}). Gracefully terminate them first with requestShutdown.`,
        }
      }
    }

    await performTeamDeleteOperation(teamName)
    // Already cleaned — the session-end cleanup must not try again.
    unregisterTeamForSessionCleanup(teamName)
    // A new team starts with fresh colours; the task list id falls back to
    // the session id; briefs and coordination verbs stop resolving the
    // deleted team.
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
  // The transcript shows no header for this tool.
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

import { z } from 'zod'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { getSessionId } from '../../bootstrap/state.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { formatAgentId } from '../../utils/agentId.js'
import { logError } from '../../utils/log.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from '../../utils/model/model.js'
import { clearLeaderTeamName, setLeaderTeamName } from '../../utils/tasks.js'
import { setLeadTeamFallback } from '../../utils/teammate.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { deriveTeamCharter } from '../../utils/swarm/teamCharter.js'
import {
  cleanupTeamDirectories,
  getTeamFilePath,
  registerTeamForSessionCleanup,
  sanitizeName,
  unregisterTeamForSessionCleanup,
  type TeamFile,
} from '../../utils/swarm/teamHelpers.js'
import {
  performTeamCreateOperation,
  TeamCreateConflictError,
} from '../../utils/swarm/teamOperations.js'
import { assignTeammateColor } from '../../utils/swarm/teammateLayoutManager.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import { TEAM_CREATE_TOOL_NAME } from './constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../TeamDeleteTool/constants.js'
import { evaluateLaunchAuthority } from '../../services/switchboard/launchAuthority.js'
import { getPrompt } from './prompt.js'
import { extractSearchText, renderToolResultMessage, renderToolUseMessage } from './UI.js'


const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const inputSchema = z.strictObject({
  team_name: z
    .string()
    .regex(
      TEAM_NAME_PATTERN,
      'Team names must start with a letter or digit, then letters, digits, underscores, or hyphens, at most 64 characters total.',
    )
    .describe('The team name'),
  description: z.string().optional().describe("The team's purpose"),
  objective: z.string().optional().describe('One sentence stating what the team exists to achieve'),
  success_criteria: z.array(z.string()).optional().describe('Concrete, checkable DONE conditions shown to every teammate'),
  agent_type: z.string().optional().describe("The lead's role (a registered agent type name)"),
})

export type Input = z.infer<typeof inputSchema>

export type Output = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
  objective: string
  charter_version: number
}

export class TeamPreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamPreconditionError'
  }
}

export async function unwindTeamCreation(teamName: string, setAppState: SetAppState): Promise<void> {
  try {
    await cleanupTeamDirectories(teamName)
  } catch (error) {
    logError(error)
  }
  unregisterTeamForSessionCleanup(teamName)
  clearLeaderTeamName()
  setLeadTeamFallback(null)
  setAppState(prevState => {
    if (prevState.teamContext?.teamName !== teamName) return prevState
    return { ...prevState, teamContext: undefined }
  })
}

async function runCreate(input: Input, context: ToolUseContext): Promise<Output> {
  const appState = context.getAppState()
  if (appState.teamContext) {
    throw new TeamPreconditionError(
      `A team already exists ("${appState.teamContext.teamName}"). A leader may manage only one team at a time — use ${TEAM_DELETE_TOOL_NAME} before creating another.`,
    )
  }

  const finalTeamName = input.team_name
  const setAppState = context.setAppState
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName)
  const leadAgentType = input.agent_type ?? TEAM_LEAD_NAME
  const leadModel = parseUserSpecifiedModel(
    appState.mainLoopModelForSession ?? appState.mainLoopModel ?? getDefaultMainLoopModel(),
  )
  const createdAt = Date.now()

  const charter = deriveTeamCharter({
    teamName: finalTeamName,
    description: input.description,
    objective: input.objective,
    successCriteria: input.success_criteria,
    createdAt,
  })

  const teamFile: TeamFile = {
    name: finalTeamName,
    description: input.description,
    createdAt,
    leadAgentId,
    leadSessionId: getSessionId(),
    charter,
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        agentType: leadAgentType,
        model: leadModel,
        joinedAt: createdAt,
        tmuxPaneId: '',
        cwd: getCwd(),
        subscriptions: [],
      },
    ],
  }

  let teamFilePath: string
  try {
    const outcome = await performTeamCreateOperation({ teamName: finalTeamName, teamFile })
    teamFilePath = outcome.result!.teamFilePath
  } catch (error) {
    if (error instanceof TeamCreateConflictError) {
      if (error.conflict === 'exists') {
        throw new TeamPreconditionError(
          `Team "${finalTeamName}" already exists at ${getTeamFilePath(finalTeamName)}. Choose a different team name, or delete the existing team first with ${TEAM_DELETE_TOOL_NAME}.`,
        )
      }
      throw new TeamPreconditionError(error.message)
    }
    throw error
  }

  registerTeamForSessionCleanup(finalTeamName)

  try {
    setLeaderTeamName(sanitizeName(finalTeamName))
    setLeadTeamFallback(finalTeamName)
    setAppState(prevState => ({
      ...prevState,
      teamContext: {
        teamName: finalTeamName,
        teamFilePath,
        leadAgentId,
        teammates: {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: leadAgentType,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: '',
            tmuxPaneId: '',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }))
  } catch (e) {
    await unwindTeamCreation(finalTeamName, setAppState)
    const error = e
    throw new Error(
      `Team "${finalTeamName}" creation failed while projecting the committed state (${
        error instanceof Error ? error.message : String(error)
      }). The team was unwound — no team file, leader registration, or task list remains. Fix the cause and re-run.`,
    )
  }

  return {
    team_name: finalTeamName,
    team_file_path: teamFilePath,
    lead_agent_id: leadAgentId,
    objective: charter.objective,
    charter_version: charter.version,
  }
}

export const TeamCreateTool = buildTool({
  name: TEAM_CREATE_TOOL_NAME,
  userFacingName: () => TEAM_CREATE_TOOL_NAME,
  searchHint: 'creates a multi-agent swarm team',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  isEnabled: () => isAgentSwarmsEnabled() && evaluateLaunchAuthority('subagents').allowed,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async description(): Promise<string> {
    return 'Create a team for coordinating multiple agents.'
  },
  async prompt({ agents, tools }): Promise<string> {
    return getPrompt(agents, new Set(tools.map(tool => tool.name)))
  },
  async validateInput(input: Input) {
    if (!input.team_name || input.team_name.trim().length === 0) {
      return {
        result: false as const,
        message: `The team_name field is required for ${TEAM_CREATE_TOOL_NAME}.`,
        errorCode: 9,
      }
    }
    return { result: true as const }
  },
  toAutoClassifierInput(input: Input): string {
    return input.team_name
  },
  async call(input: Input, context: ToolUseContext) {
    return { data: await runCreate(input, context) }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  extractSearchText,
  renderToolUseProgressMessage: () => null,
  renderToolUseQueuedMessage: () => null,
  renderToolUseRejectedMessage: () => null,
  renderToolUseErrorMessage: () => null,
})

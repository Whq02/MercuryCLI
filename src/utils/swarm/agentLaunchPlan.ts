
import type { ToolPermissionContext } from '../../Tool.js'
import type { EngineDispatch } from './engineDispatch.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../../tools/TeamDeleteTool/constants.js'
import { getAgentModelWithFloorNote } from '../model/agent.js'
import type { ModelAlias } from '../model/aliases.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  filterDeniedAgents,
  getDenyRuleForAgent,
} from '../permissions/permissions.js'
import { decodeAgentType, type ResolvedTeammateRole } from './roleResolver.js'


export type AgentLaunchPlanInput = {
  requestedType?: string
  activeAgents: readonly AgentDefinition[]
  allowedAgentTypes?: readonly string[]
  toolPermissionContext: ToolPermissionContext
  forkGateOn: boolean
  forkAgent: AgentDefinition
  defaultAgentType: string
  mainLoopModel: string
  modelParam?: ModelAlias
  permissionMode?: PermissionMode
  isolationParam?: 'worktree' | 'remote'
  runInBackground?: boolean
  backgroundTasksDisabled: boolean
  forceAsync: boolean
  engineDispatch?: {
    backend: EngineDispatch['backend']
    model: string
  }
}

export type AgentLaunchPlan = {
  agentType: string
  definition: AgentDefinition
  isForkPath: boolean
  model: string
  flooredFrom?: string
  modelNote?: string
  isolation?: string
  shouldRunAsync: boolean
  workerPermissionMode: PermissionMode
  engineBackend?: EngineDispatch['backend']
}

export function buildAgentLaunchPlan(i: AgentLaunchPlanInput): AgentLaunchPlan {
  const requestedType = decodeAgentType(i.requestedType)
  const effectiveType =
    requestedType ?? (i.forkGateOn ? undefined : i.defaultAgentType)
  const isForkPath = effectiveType === undefined

  let definition: AgentDefinition
  if (isForkPath) {
    definition = i.forkAgent
  } else {
    const allAgents = i.activeAgents
    const agents = filterDeniedAgents(
      (i.allowedAgentTypes
        ? allAgents.filter(a => i.allowedAgentTypes!.includes(a.agentType))
        : allAgents) as AgentDefinition[],
      i.toolPermissionContext,
      AGENT_TOOL_NAME,
    )
    const found = agents.find(agent => agent.agentType === effectiveType)
    if (!found) {
      const agentExistsButDenied = allAgents.find(
        agent => agent.agentType === effectiveType,
      )
      if (agentExistsButDenied) {
        const denyRule = getDenyRuleForAgent(
          i.toolPermissionContext,
          AGENT_TOOL_NAME,
          effectiveType,
        )
        throw new Error(
          `Agent type '${effectiveType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${effectiveType})' from ${denyRule?.source ?? 'settings'}.`,
        )
      }
      throw new Error(
        `Agent type '${effectiveType}' not found. Available agents: ${agents.map(a => a.agentType).join(', ')}`,
      )
    }
    definition = found
  }

  if (i.engineDispatch) {
    const backend = i.engineDispatch.backend
    const engineModel = i.engineDispatch.model
    return {
      agentType: definition.agentType,
      definition,
      isForkPath,
      model: engineModel,
      modelNote: `engine: ${providerDisplayName(backend)} (${engineModel}) via the native in-process transport`,
      isolation: i.isolationParam ?? definition.isolation,
      shouldRunAsync:
        (i.runInBackground === true ||
          definition.background === true ||
          i.forceAsync) &&
        !i.backgroundTasksDisabled,
      workerPermissionMode: definition.permissionMode ?? 'implement',
      engineBackend: backend,
    }
  }

  const { model, flooredFrom } = getAgentModelWithFloorNote(
    definition.model,
    i.mainLoopModel,
    isForkPath ? undefined : i.modelParam,
    i.permissionMode,
  )
  const modelNote = flooredFrom
    ? `note: the requested model resolved to '${flooredFrom}', below Mercury's never-Haiku floor — the agent is running on '${model}' (Mercury's agent-model rule).`
    : undefined

  return {
    agentType: definition.agentType,
    definition,
    isForkPath,
    model,
    flooredFrom,
    modelNote,
    isolation: i.isolationParam ?? definition.isolation,
    shouldRunAsync:
      (i.runInBackground === true ||
        definition.background === true ||
        i.forceAsync) &&
      !i.backgroundTasksDisabled,
    workerPermissionMode: definition.permissionMode ?? 'implement',
  }
}

export const TEAM_ESSENTIAL_TOOLS: readonly string[] = [
  SEND_MESSAGE_TOOL_NAME,
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]

export function deriveRunnerAgentDefinition(i: {
  role?: ResolvedTeammateRole
  agentDefinition?: AgentDefinition
  displayName: string
  systemPrompt: string
}): CustomAgentDefinition {
  return {
    agentType:
      i.role?.agentType ?? i.agentDefinition?.agentType ?? i.displayName,
    whenToUse: `In-process teammate: ${i.displayName}`,
    getSystemPrompt: () => i.systemPrompt,
    tools: i.agentDefinition?.tools
      ? [...new Set([...i.agentDefinition.tools, ...TEAM_ESSENTIAL_TOOLS])]
      : ['*'],
    source: 'projectSettings',
    permissionMode: 'default',
    ...(i.agentDefinition?.disallowedTools
      ? { disallowedTools: i.agentDefinition.disallowedTools }
      : {}),
    ...(i.agentDefinition?.model ? { model: i.agentDefinition.model } : {}),
  }
}

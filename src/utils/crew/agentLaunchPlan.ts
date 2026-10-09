
import type { ToolPermissionContext } from '../../Tool.js'
import type { EngineDispatch } from './engineDispatch.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { getAgentModel } from '../model/agent.js'
import type { ModelAlias } from '../model/aliases.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  filterDeniedAgents,
  getDenyRuleForAgent,
} from '../permissions/permissions.js'
import { reasonForRule, refusalWithReason, ruleSentence } from '../permissions/ruleReason.js'

export type AgentLaunchPlanInput = {
  requestedType?: string
  activeAgents: readonly AgentDefinition[]
  allowedAgentTypes?: readonly string[]
  toolPermissionContext: ToolPermissionContext
  defaultAgentType: string
  engineModel: string
  modelParam?: ModelAlias
  resolvedModel?: string
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
  model: string
  modelNote?: string
  isolation?: string
  shouldRunAsync: boolean
  workerPermissionMode: PermissionMode
  engineBackend?: EngineDispatch['backend']
}

export function buildAgentLaunchPlan(i: AgentLaunchPlanInput): AgentLaunchPlan {
  const effectiveType = (i.requestedType || undefined) ?? i.defaultAgentType

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
        refusalWithReason(
          denyRule
            ? ruleSentence(`The ${effectiveType} agent`, 'deny', denyRule)
            : `The ${effectiveType} agent is denied by the rule ${AGENT_TOOL_NAME}(${effectiveType}).`,
          denyRule ? reasonForRule(i.toolPermissionContext, denyRule) : undefined,
        ),
      )
    }
    throw new Error(
      `No agent type named '${effectiveType}'; this session offers: ${agents.map(a => a.agentType).join(', ')}`,
    )
  }
  const definition: AgentDefinition = found

  if (i.engineDispatch) {
    const backend = i.engineDispatch.backend
    const engineModel = i.engineDispatch.model
    return {
      agentType: definition.agentType,
      definition,
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

  const model = i.resolvedModel ?? getAgentModel(
    definition.model,
    i.engineModel,
    i.modelParam,
  )

  return {
    agentType: definition.agentType,
    definition,
    model,
    isolation: i.isolationParam ?? definition.isolation,
    shouldRunAsync:
      (i.runInBackground === true ||
        definition.background === true ||
        i.forceAsync) &&
      !i.backgroundTasksDisabled,
    workerPermissionMode: definition.permissionMode ?? 'implement',
  }
}

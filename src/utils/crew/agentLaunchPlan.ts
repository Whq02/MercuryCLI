
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
  forkGateOn: boolean
  forkAgent: AgentDefinition
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
  isForkPath: boolean
  model: string
  modelNote?: string
  isolation?: string
  shouldRunAsync: boolean
  workerPermissionMode: PermissionMode
  engineBackend?: EngineDispatch['backend']
}

export function buildAgentLaunchPlan(i: AgentLaunchPlanInput): AgentLaunchPlan {
  const requestedType = i.requestedType || undefined
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
          refusalWithReason(
            denyRule
              ? ruleSentence(`The ${effectiveType} agent`, 'deny', denyRule)
              : `The ${effectiveType} agent is denied by the rule ${AGENT_TOOL_NAME}(${effectiveType}).`,
            denyRule ? reasonForRule(i.toolPermissionContext, denyRule) : undefined,
          ),
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

  const model = (!isForkPath ? i.resolvedModel : undefined) ?? getAgentModel(
    definition.model,
    i.engineModel,
    isForkPath ? undefined : i.modelParam,
  )

  return {
    agentType: definition.agentType,
    definition,
    isForkPath,
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

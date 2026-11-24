
import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import type { EngineDispatch } from './engineDispatch.js'
import { classifyModelRoute, laneLabelForVerdict, providerDisplayName } from '../../models/roads/routeLaw.js'
import { CREWMATE_TOOL_NAME } from '../../tools/kit/names/agent.js'
import type { AgentDefinition } from '../agents/agentDefinition.js'
import { getCrewmateModel } from '../../models/catalogue/agentModel.js'
import type { PermissionMode } from '../../permissions/rules/permissionMode.js'
import {
  filterDeniedAgents,
  getDenyRuleForAgent,
} from '../../permissions/rules/permissionDoor.js'
import { reasonForRule, refusalWithReason, ruleSentence } from '../../permissions/rules/ruleReason.js'

export type CrewmateLaunchPlanInput = {
  requestedType?: string
  activeAgents: readonly AgentDefinition[]
  allowedAgentTypes?: readonly string[]
  toolPermissionContext: ToolPermissionContext
  defaultAgentType: string
  engineModel: string
  modelParam?: string
  resolvedModel?: string
  permissionMode?: PermissionMode
  isolationParam?: 'worktree' | 'remote'
  runInBackground?: boolean
  backgroundTasksDisabled: boolean
  forceAsync: boolean
  engineDispatch?: {
    backend: EngineDispatch['backend']
    model: string
    note?: string
  }
}

export type CrewmateLaunchPlan = {
  agentType: string
  definition: AgentDefinition
  model: string
  modelNote?: string
  isolation?: string
  shouldRunAsync: boolean
  crewmatePermissionMode: PermissionMode
  engineBackend?: EngineDispatch['backend']
}

export function buildCrewmateLaunchPlan(i: CrewmateLaunchPlanInput): CrewmateLaunchPlan {
  const effectiveType = (i.requestedType || undefined) ?? i.defaultAgentType

  const allAgents = i.activeAgents
  const agents = filterDeniedAgents(
    (i.allowedAgentTypes
      ? allAgents.filter(a => i.allowedAgentTypes!.includes(a.agentType))
      : allAgents) as AgentDefinition[],
    i.toolPermissionContext,
    CREWMATE_TOOL_NAME,
  )
  const found = agents.find(agent => agent.agentType === effectiveType)
  if (!found) {
    const agentExistsButDenied = allAgents.find(
      agent => agent.agentType === effectiveType,
    )
    if (agentExistsButDenied) {
      const denyRule = getDenyRuleForAgent(
        i.toolPermissionContext,
        CREWMATE_TOOL_NAME,
        effectiveType,
      )
      throw new Error(
        refusalWithReason(
          denyRule
            ? ruleSentence(`The ${effectiveType} crewmate`, 'deny', denyRule)
            : `The ${effectiveType} crewmate is denied by the rule ${CREWMATE_TOOL_NAME}(${effectiveType}).`,
          denyRule ? reasonForRule(i.toolPermissionContext, denyRule) : undefined,
        ),
      )
    }
    throw new Error(
      `No crewmate type named '${effectiveType}'; this session offers: ${agents.map(a => a.agentType).join(', ')}`,
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
      modelNote: `engine: ${providerDisplayName(backend)} (${engineModel}) via the native in-process transport${i.engineDispatch.note !== undefined ? ` — ${i.engineDispatch.note}` : ''}`,
      isolation: i.isolationParam ?? definition.isolation,
      shouldRunAsync:
        (i.runInBackground === true ||
          definition.background === true ||
          i.forceAsync) &&
        !i.backgroundTasksDisabled,
      crewmatePermissionMode: definition.permissionMode ?? 'implement',
      engineBackend: backend,
    }
  }

  const model = i.resolvedModel ?? getCrewmateModel(
    definition.model,
    i.engineModel,
    i.modelParam,
  )

  return {
    agentType: definition.agentType,
    definition,
    model,
    modelNote: `engine: ${laneLabelForVerdict(classifyModelRoute(model), { rode: true })} (${model}) via the native in-process transport`,
    isolation: i.isolationParam ?? definition.isolation,
    shouldRunAsync:
      (i.runInBackground === true ||
        definition.background === true ||
        i.forceAsync) &&
      !i.backgroundTasksDisabled,
    crewmatePermissionMode: definition.permissionMode ?? 'implement',
  }
}

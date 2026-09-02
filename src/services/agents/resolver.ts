import type { Tools } from '../../Tool.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../../tools/AgentTool/loadAgentsDir.js'
import {
  resolveAgentTools,
  type ResolvedAgentTools,
} from '../../tools/AgentTool/agentToolUtils.js'
import {
  type EffortResolution,
  type EffortValue,
  resolveEffortTruth,
} from '../../utils/effort.js'
import {
  getAgentModelWithFloorNote,
  getDefaultSubagentModel,
} from '../../utils/model/agent.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { AgentOverrideProvenance } from './overrides.js'

export type AgentShadowReason =
  | 'scope-precedence'
  | 'nearer-directory'
  | 'duplicate-in-tree'
  | 'disabled'

export type AgentCandidateResolution = {
  agent: AgentDefinition
  winner: boolean
  shadowReason?: AgentShadowReason
}

export type AgentEstateEntry = {
  name: string
  winner?: AgentDefinition
  candidates: AgentCandidateResolution[]
}

function dirDepth(agent: AgentDefinition): number {
  const baseDir = (agent as { baseDir?: string }).baseDir
  if (!baseDir) return -1
  return baseDir.split(/[\\/]/).filter(Boolean).length
}

function shadowReasonFor(
  candidate: AgentDefinition,
  winner: AgentDefinition,
): AgentShadowReason {
  if (candidate.source !== winner.source) return 'scope-precedence'
  const candidateBase = (candidate as { baseDir?: string }).baseDir
  const winnerBase = (winner as { baseDir?: string }).baseDir
  if (candidateBase !== undefined && candidateBase === winnerBase) {
    return 'duplicate-in-tree'
  }
  if (dirDepth(winner) !== dirDepth(candidate)) return 'nearer-directory'
  return 'duplicate-in-tree'
}

export function resolveAgentEstate(
  result: Pick<AgentDefinitionsResult, 'allAgents' | 'activeAgents'>,
): Map<string, AgentEstateEntry> {
  const winners = new Map<string, AgentDefinition>()
  for (const agent of result.activeAgents) {
    winners.set(agent.agentType, agent)
  }
  const entries = new Map<string, AgentEstateEntry>()
  for (const agent of result.allAgents) {
    const name = agent.agentType
    let entry = entries.get(name)
    if (!entry) {
      entry = { name, winner: winners.get(name), candidates: [] }
      entries.set(name, entry)
    }
    const isWinner = winners.get(name) === agent
    const disabled = (agent as { disabled?: boolean }).disabled === true
    entry.candidates.push({
      agent,
      winner: isWinner,
      ...(isWinner
        ? {}
        : {
            shadowReason: disabled
              ? ('disabled' as const)
              : entry.winner
                ? shadowReasonFor(agent, entry.winner)
                : ('disabled' as const),
          }),
    })
  }
  return entries
}

export type EffectiveAgentRuntime = {
  modelIntent: string
  model: string
  flooredFrom?: string
  effortIntent?: EffortValue
  effort: EffortResolution
  tools?: ResolvedAgentTools
  override?: AgentOverrideProvenance
  disabled: boolean
}

export function resolveEffectiveAgentRuntime(
  agent: AgentDefinition,
  ctx: {
    parentModel: string
    sessionEffort: EffortValue | undefined
    tools?: Tools
    permissionMode?: PermissionMode
  },
): EffectiveAgentRuntime {
  const modelIntent = agent.model ?? getDefaultSubagentModel()
  const { model, flooredFrom } = getAgentModelWithFloorNote(
    agent.model,
    ctx.parentModel,
    undefined,
    ctx.permissionMode,
  )
  const effortInput = agent.effort !== undefined ? agent.effort : ctx.sessionEffort
  const effort = resolveEffortTruth(model, effortInput)
  const override = (agent as { operatorOverride?: AgentOverrideProvenance })
    .operatorOverride
  return {
    modelIntent,
    model,
    ...(flooredFrom !== undefined ? { flooredFrom } : {}),
    ...(agent.effort !== undefined ? { effortIntent: agent.effort } : {}),
    effort,
    ...(ctx.tools !== undefined
      ? { tools: resolveAgentTools(agent, ctx.tools, false) }
      : {}),
    ...(override !== undefined ? { override } : {}),
    disabled: (agent as { disabled?: boolean }).disabled === true,
  }
}

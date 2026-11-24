import type { Tools } from '../../tools/kit/tool.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from './agentDefinition.js'
import {
  resolveAgentTools,
  type ResolvedAgentTools,
} from '../../tools/crewmate/crewmateLifecycle.js'
import {
  type EffortResolution,
  type EffortValue,
  resolveEffortTruth,
} from '../../models/effort/effort.js'
import {
  getCrewmateModel,
  getDefaultCrewmateModel,
} from '../../models/catalogue/crewmateModel.js'
import type { AgentOverrideProvenance } from './overrides.js'

type AgentShadowReason =
  | 'scope-precedence'
  | 'nearer-directory'
  | 'duplicate-in-tree'
  | 'disabled'

type AgentCandidateResolution = {
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

type EffectiveAgentRuntime = {
  modelIntent: string
  model: string
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
  },
): EffectiveAgentRuntime {
  const modelIntent = agent.model ?? getDefaultCrewmateModel()
  const model = getCrewmateModel(
    agent.model,
    ctx.parentModel,
  )
  const effortInput = agent.effort !== undefined ? agent.effort : ctx.sessionEffort
  const effort = resolveEffortTruth(model, effortInput)
  const override = (agent as { operatorOverride?: AgentOverrideProvenance })
    .operatorOverride
  return {
    modelIntent,
    model,
    ...(agent.effort !== undefined ? { effortIntent: agent.effort } : {}),
    effort,
    ...(ctx.tools !== undefined
      ? { tools: resolveAgentTools(agent, ctx.tools) }
      : {}),
    ...(override !== undefined ? { override } : {}),
    disabled: (agent as { disabled?: boolean }).disabled === true,
  }
}

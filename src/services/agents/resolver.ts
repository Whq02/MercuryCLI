// ============================================================================
//  resolver — the ONE scope/precedence/shadow/effective-truth owner.
//
//  Two responsibilities, both PROJECTIONS (no I/O, no caches):
//
//  1. resolveAgentEstate — for a loaded AgentDefinitionsResult, the per-name
//     winner + the full shadow chain with REASONS. Nothing disappears: every
//     candidate (shadowed, disabled, invalid) stays addressable for
//     diagnostics. Winner truth comes from getActiveAgentsFromList (the one
//     precedence pass); this module only EXPLAINS it.
//
//  2. resolveEffectiveAgentRuntime — what the agent will ACTUALLY run:
//     · model through the ONE subagent chokepoint (getAgentModelWithFloorNote
//       — never-Haiku floor, tier matching, env override);
//     · effort through resolveEffortTruth on the RESOLVED model
//       (definition effort overrides session effort — runAgent.ts parity);
//     · tools narrowed by the live session catalog (resolveAgentTools).
//     Raw intent and applied result are carried separately so every surface
//     (list, inspector, review, receipt) can show both when they differ.
// ============================================================================
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
  | 'scope-precedence' // a higher-priority scope holds the name
  | 'nearer-directory' // a directory closer to cwd holds the name
  | 'duplicate-in-tree' // same name twice under one root — file order wins
  | 'disabled' // candidate exists but is operator-disabled

export type AgentCandidateResolution = {
  agent: AgentDefinition
  winner: boolean
  shadowReason?: AgentShadowReason
}

export type AgentEstateEntry = {
  name: string
  /** The active definition, when one exists (every candidate disabled ⇒ none). */
  winner?: AgentDefinition
  candidates: AgentCandidateResolution[]
}

/** Directory depth proxy: path segment count of the candidate's baseDir. */
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

/** Explain the estate: per name, the winner + every candidate with its shadow
 *  reason. `activeAgents` is the precedence truth (already computed by the
 *  loader); this projection never re-derives a different winner. */
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
  /** The declared model intent (frontmatter/override input; 'inherit' when
   *  the definition declares none). */
  modelIntent: string
  /** The model the spawn chokepoint resolves — what actually dispatches. */
  model: string
  /** Set when the never-Haiku floor changed the raw resolution. */
  flooredFrom?: string
  /** The declared effort intent (definition), undefined = session effort. */
  effortIntent?: EffortValue
  /** truth on the RESOLVED model — applied/wire/label/selectable. */
  effort: EffortResolution
  /** Tools narrowed by the live catalog (undefined when no catalog given). */
  tools?: ResolvedAgentTools
  /** Operator override provenance, when one applies to this agent. */
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
  // runAgent.ts parity: the definition's effort overrides the session value.
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

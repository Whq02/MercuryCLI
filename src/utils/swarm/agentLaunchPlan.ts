// ============================================================================
//  agentLaunchPlan — the ONE typed launch plan for subagent dispatch
//  (core-ownership Phase 7.2). Before this module, AgentTool.call() resolved
//  its launch decisions inline — including a SECOND copy of the legacy-alias
//  decode (roleResolver.decodeAgentType is the one truth), the model floor
//  note, the isolation override, the async decision, and the worker
//  permission mode. Every subagent launch now resolves through
//  buildAgentLaunchPlan(); the in-process teammate runner's agent-definition
//  product lives here too (deriveRunnerAgentDefinition), so the two launch
//  families (subagents via the plan, teammates via ResolvedTeammateRole)
//  share one home and one decode.
//
//  Pure resolution over injected inputs — no env reads, no context objects.
//  Error messages are model-visible tool surface: byte-identical to the
//  strings AgentTool threw before the extraction.
// ============================================================================

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

// The "specialists never spawn specialists" denial list is RETIRED
// (provider-parity ruling): both engine backends run IN-PROCESS on
// the provider-aware callModel branch, children resolve their own models
// through the one routing law, and the parent's provider never constrains
// the child's — a GPT-backed agent keeps the spawn surfaces exactly like a
// Claude-backed one. (The inherit path never lost them: a child inheriting a
// gpt main's model always kept its full pool — the denial only fired on the
// explicit-dispatch spelling, an asymmetry, not a safety boundary. Each
// spawn remains a visible, billed act.)

export type AgentLaunchPlanInput = {
  /** The raw subagent_type param; legacy aliases decode via the ONE truth
   *  (roleResolver.decodeAgentType). */
  requestedType?: string
  /** The registered agent definitions (already loaded). */
  activeAgents: readonly AgentDefinition[]
  /** Agent(x,y) tool-spec restriction, when present. */
  allowedAgentTypes?: readonly string[]
  toolPermissionContext: ToolPermissionContext
  /** The fork experiment: when on and no type is requested, the injected
   *  fork definition runs (no registry lookup). */
  forkGateOn: boolean
  forkAgent: AgentDefinition
  /** The fallback type when forking is unavailable and no type is requested. */
  defaultAgentType: string
  /** Model resolution inputs (the never-Haiku floor fires inside). */
  mainLoopModel: string
  modelParam?: ModelAlias
  permissionMode?: PermissionMode
  /** Explicit isolation param — wins over the definition's. */
  isolationParam?: 'worktree' | 'remote'
  /** The async decision inputs. */
  runInBackground?: boolean
  backgroundTasksDisabled: boolean
  /** Caller-side force-async gates (fork experiment, proactive, coordinator)
   *  folded to one flag — the plan only owns the combination law. */
  forceAsync: boolean
  /** A resolved engine dispatch (utils/swarm/engineDispatch.ts).
   *  When set, the launch is engine-backed: model rides the dispatch (the
   *  Anthropic never-Haiku floor is that family's rule and does not apply —
   *  engine ids are catalogue-verified), and the specialist denial law fires
   *  below. Both backends run the in-process grammar (real agent definitions,
   *  worktree law, async law) on their native transports. */
  engineDispatch?: {
    backend: EngineDispatch['backend']
    model: string
  }
}

export type AgentLaunchPlan = {
  /** Canonical agent type (aliases decoded); on the fork path this is the
   *  fork definition's type. The display name never substitutes for this. */
  agentType: string
  definition: AgentDefinition
  isForkPath: boolean
  /** The resolved model — never below the never-Haiku floor. */
  model: string
  /** The raw pre-floor resolution, present only when the floor remapped. */
  flooredFrom?: string
  /** The caller-visible floor note — surfaced, never silent. */
  modelNote?: string
  /** Effective isolation: the explicit param wins over the definition. */
  isolation?: string
  /** The final async decision. */
  shouldRunAsync: boolean
  /** The permission mode the WORKER tool pool is assembled under. */
  workerPermissionMode: PermissionMode
  /** Engine launches only. */
  engineBackend?: EngineDispatch['backend']
}

/**
 * Resolve one subagent launch to its frozen plan. Throws with the exact
 * (model-visible) messages AgentTool always used for denial / not-found.
 */
export function buildAgentLaunchPlan(i: AgentLaunchPlanInput): AgentLaunchPlan {
  // Legacy id decode (the ONE migration map, shared with the teammate
  // resolver): old manifests / the wrapper's Explore routing / muscle memory
  // resolve to the Mercury-native roster.
  const requestedType = decodeAgentType(i.requestedType)
  const effectiveType =
    requestedType ?? (i.forkGateOn ? undefined : i.defaultAgentType)
  const isForkPath = effectiveType === undefined

  let definition: AgentDefinition
  if (isForkPath) {
    definition = i.forkAgent
  } else {
    // Filter agents to exclude those denied via Agent(AgentName) syntax;
    // when allowedAgentTypes is set (from an Agent(x,y) tool spec), restrict
    // to those types first.
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
      // Distinguish "denied by rule" from "unknown type".
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

  // Engine-backed launches short-circuit here — the model is
  // the dispatch's catalogue-verified resolution; the never-Haiku floor is
  // the ANTHROPIC-family rule and never fires on engine ids. Both backends
  // ride the normal in-process grammar (real definitions, full worker tool
  // pool incl. the spawn surfaces, worktree law, async law) on their native
  // transports.
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

  // The never-Haiku floor fires on the RESOLVED string; when it remaps, the
  // note says so instead of remapping silently (the public schema no longer
  // offers 'haiku', but legacy frontmatter pins and env overrides bypass it).
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
    // Explicit param overrides the agent definition.
    isolation: i.isolationParam ?? definition.isolation,
    shouldRunAsync:
      (i.runInBackground === true ||
        definition.background === true ||
        i.forceAsync) &&
      !i.backgroundTasksDisabled,
    // Workers always get their tools assembled under their OWN permission
    // mode, independent of the parent's restrictions.
    workerPermissionMode: definition.permissionMode ?? 'implement',
  }
}

/** The tools every teammate keeps regardless of an explicit role tool list,
 *  so it can always respond to shutdown requests, message the lead, and
 *  coordinate via the task list. */
export const TEAM_ESSENTIAL_TOOLS: readonly string[] = [
  SEND_MESSAGE_TOOL_NAME,
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]

/**
 * The in-process teammate runner's agent-definition product — the teammate
 * side of plan assembly. agentType is the CANONICAL role id (roleResolver);
 * the display name never substitutes for role identity. Role tool DENIALS
 * ride too: a read-only role (scout/architect) stays read-only in-process,
 * matching the AgentTool/pane behavior for the same role packet.
 */
export function deriveRunnerAgentDefinition(i: {
  role?: ResolvedTeammateRole
  agentDefinition?: AgentDefinition
  /** The teammate's display name — identity of last resort only. */
  displayName: string
  /** The fully composed teammate system prompt. */
  systemPrompt: string
}): CustomAgentDefinition {
  return {
    agentType:
      i.role?.agentType ?? i.agentDefinition?.agentType ?? i.displayName,
    whenToUse: `In-process teammate: ${i.displayName}`,
    getSystemPrompt: () => i.systemPrompt,
    // Inject team-essential tools even with explicit role tool lists.
    tools: i.agentDefinition?.tools
      ? [...new Set([...i.agentDefinition.tools, ...TEAM_ESSENTIAL_TOOLS])]
      : ['*'],
    source: 'projectSettings',
    // 'default' so teammates get full tool access regardless of the leader's
    // permission mode; the runner overlays the task's live mode per turn.
    permissionMode: 'default',
    ...(i.agentDefinition?.disallowedTools
      ? { disallowedTools: i.agentDefinition.disallowedTools }
      : {}),
    // Propagate the role's model pin so getAgentModel() can use it as the
    // fallback when no tool-level model is specified.
    ...(i.agentDefinition?.model ? { model: i.agentDefinition.model } : {}),
  }
}

import { ASK_ADVISOR_TOOL_NAME } from '../../AskAdvisorTool/constants.js'
import { COMPUTER_TOOL_NAME } from '../../../services/desktop/toolName.js'
import type { InstructionProfile } from '../../../utils/instructions/contracts.js'
import { createSubagentContext } from '../../../services/agents/forkedAgent.js'
import { claimDiagnosticsRoot } from '../../../services/lsp/LSPDiagnosticRegistry.js'
import { processOwnerForLane } from '../../../utils/run/resolveOwner.js'
import type { AgentId } from '../../../types/ids.js'
import type { Tool, ToolUseContext, Tools } from '../../../Tool.js'
import type { MCPServerConnection } from '../../../utils/mcp/types.js'
import { subagentDefaultEffort } from '../../../utils/agentDefaults.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getSchemaBoundStructuredOutputTool } from '../../SyntheticOutputTool/structuredOutputTool.js'
import { recordAtRunStart } from '../../../services/crew/crewmateRecord.js'
import { swarmBrief } from '../../../services/crewBoard/seam.js'
import { type ThinkingConfig, sessionThinkingConfig } from '../../../utils/thinking.js'
import { restrictReviewerTools } from '../reviewerPolicy.js'
import { restrictScoutTools } from '../scoutPolicy.js'
import { composeAgentAppState, definitionModeWithinConsent, resolveAgentPromptPosture } from '../agentPermissionPosture.js'
import type { resolveAgentEffort, RunAgentParams } from '../runAgent.js'

type PostureNeeds = Pick<RunAgentParams, 'toolUseContext' | 'agentDefinition' | 'isAsync' | 'canShowPermissionPrompts' | 'allowedTools' | 'effortOverride' | 'useExactTools'> & {
  resolveAgentEffort: typeof resolveAgentEffort
}

export function agentPostureOf({ toolUseContext, agentDefinition, isAsync, canShowPermissionPrompts, allowedTools, effortOverride, useExactTools, resolveAgentEffort }: PostureNeeds) {
  const parentGetAppState = toolUseContext.getAppState
  const definitionMode = agentDefinition.permissionMode
  const parentPermissionContext = parentGetAppState?.()?.toolPermissionContext
  if (
    definitionMode !== undefined &&
    parentPermissionContext !== undefined &&
    definitionModeWithinConsent(definitionMode, parentPermissionContext) === undefined
  ) {
    logForDebugging(
      `runAgent: ${agentDefinition.agentType} declares permissionMode ${definitionMode} — Sovereign Mode requires launching with --sovereign; the agent keeps the session's posture`,
    )
  }
  const posture = resolveAgentPromptPosture({
    isAsync,
    canShowPermissionPrompts,
    definitionMode,
    parentAvoidsPrompts:
      parentGetAppState?.()?.toolPermissionContext
        .shouldAvoidPermissionPrompts === true,
    parentNonInteractive: toolUseContext.options.isNonInteractiveSession,
    parentHostHoldsAsks: toolUseContext.options.hostHoldsAsks,
  })
  const avoidPrompts = posture.avoidPrompts
  const agentGetAppState: typeof parentGetAppState = () => {
    const state = parentGetAppState()
    return composeAgentAppState(state, {
      definitionMode,
      definitionTools: agentDefinition,
      avoidPrompts,
      isAsync,
      allowedTools,
      effortValue: resolveAgentEffort({
        effortOverride,
        useExactTools,
        definitionEffort: agentDefinition.effort,
        defaultEffort: subagentDefaultEffort(),
      }),
    })
  }
  return { posture, agentGetAppState }
}

type ToolsNeeds = Pick<RunAgentParams, 'availableTools' | 'structuredOutputSpec' | 'worktreePath'> & {
  swarm: boolean
  mcp: { tools: Tool[] }
  reviewReceipt: string | undefined
  readOnlyScout: boolean
}

export function agentToolsOf({
  availableTools,
  structuredOutputSpec,
  worktreePath,
  swarm,
  mcp,
  reviewReceipt,
  readOnlyScout,
}: ToolsNeeds): Tools {
  const seen = new Set<string>()
  const merged: Tool[] = []
  for (const tool of [...availableTools, ...mcp.tools]) {
    if (tool.name === ASK_ADVISOR_TOOL_NAME || tool.name === COMPUTER_TOOL_NAME) continue
    if (!swarm && tool.name === 'CrewBoard') continue
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    merged.push(tool)
  }
  let tools: Tools = merged
  if (reviewReceipt !== undefined && worktreePath !== undefined) {
    tools = restrictReviewerTools(tools, reviewReceipt, worktreePath)
  }
  if (readOnlyScout) {
    tools = restrictScoutTools(tools)
  }
  if (structuredOutputSpec !== undefined) {
    const bound = getSchemaBoundStructuredOutputTool(structuredOutputSpec.schema)
    if (bound.error !== undefined) {
      throw new Error(`output_schema is not a valid JSON Schema: ${bound.error}`)
    }
    tools = [...tools.filter(tool => tool.name !== bound.tool.name), bound.tool]
  }
  return tools
}

type ChildContextNeeds = Pick<RunAgentParams, 'toolUseContext' | 'thinkingConfigOverride' | 'agentDefinition' | 'isAsync' | 'querySource' | 'contentReplacementState' | 'worktreePath' | 'seatHolder' | 'description' | 'onWait' | 'preserveToolUseResults'> & {
  posture: ReturnType<typeof resolveAgentPromptPosture>
  agentId: AgentId
  abortController: AbortController
  agentGetAppState: ToolUseContext['getAppState']
  tools: Tools
  resolvedAgentModel: string
  mcp: { clients: MCPServerConnection[] }
  isFork: boolean
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>
  childContextRef: { current: ToolUseContext | undefined }
  agentKind: NonNullable<RunAgentParams['agentKind']>
}

export function childContextOf({
  toolUseContext,
  posture,
  thinkingConfigOverride,
  agentId,
  agentDefinition,
  abortController,
  agentGetAppState,
  isAsync,
  tools,
  resolvedAgentModel,
  mcp,
  isFork,
  querySource,
  readFileState,
  contentReplacementState,
  childContextRef,
  worktreePath,
  agentKind,
  seatHolder,
  description,
  onWait,
  preserveToolUseResults,
}: ChildContextNeeds): { childContext: ToolUseContext; thinkingOverride: { thinkingConfig: ThinkingConfig } } {
  const thinkingConfig: ThinkingConfig =
    thinkingConfigOverride ?? toolUseContext.options.thinkingConfig ?? sessionThinkingConfig()
  const thinkingOverride = { thinkingConfig }
  const parentOptions = toolUseContext.options
  const childContext = createSubagentContext(toolUseContext, {
    agentId,
    agentType: agentDefinition.agentType,
    abortController,
    getAppState: agentGetAppState,
    shareSetAppState: !isAsync,
    shareSetResponseLength: true,
    options: {
      isNonInteractiveSession: posture.isNonInteractiveSession,
      ...(parentOptions.runDeadline !== undefined ? { runDeadline: parentOptions.runDeadline } : {}),
      ...(posture.hostHoldsAsks ? { hostHoldsAsks: true } : {}),
      ...(parentOptions.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: parentOptions.appendSystemPrompt }
        : {}),
      debug: parentOptions.debug,
      verbose: parentOptions.verbose,
      mcpResources: parentOptions.mcpResources,
      agentDefinitions: parentOptions.agentDefinitions,
      tools,
      commands: [],
      engineModel: resolvedAgentModel,
      thinkingConfig,
      mcpClients: [...(parentOptions.mcpClients ?? []), ...mcp.clients],
      ...(isFork ? { querySource } : {}),
    },
    readFileState,
    ...(agentDefinition.standingRule ? { standingRule: agentDefinition.standingRule } : {}),
    ...(contentReplacementState !== undefined ? { contentReplacementState } : {}),
  })
  childContextRef.current = childContext
  if (worktreePath !== undefined) {
    claimDiagnosticsRoot(processOwnerForLane(agentId), worktreePath)
  }
  childContext.agentKind = agentKind
  childContext.seatHolder = seatHolder ?? description ?? agentDefinition.agentType
  if (onWait !== undefined) {
    childContext.onSeatWait = onWait
  }
  if (preserveToolUseResults) {
    childContext.preserveToolResults = true
  }
  return { childContext, thinkingOverride }
}

type RecordNeeds = Pick<RunAgentParams, 'model' | 'effortOverride' | 'agentDefinition' | 'worktreePath' | 'cwd' | 'description' | 'name' | 'launchedAt' | 'structuredOutputSpec'> & {
  latestRecord: Parameters<typeof recordAtRunStart>[0]
  swarm: boolean
  swarmWords: ReturnType<typeof swarmBrief>
  thinkingOverride: { thinkingConfig: ThinkingConfig }
  instructionCapture: { profile: InstructionProfile; digest?: string | null } | null | undefined
  resolvedAgentModel: string
  resolvedEffort: ReturnType<typeof resolveAgentEffort>
}

export function runStartRecordOf({ latestRecord, model, effortOverride, agentDefinition, swarm, worktreePath, cwd, description, name, launchedAt, swarmWords, thinkingOverride, structuredOutputSpec, instructionCapture, resolvedAgentModel, resolvedEffort }: RecordNeeds) {
  return recordAtRunStart(latestRecord, { model, effortOverride }, {
    fresh: {
      agentType: agentDefinition.agentType,
      swarm,
      ...(worktreePath ? { worktreePath } : {}),
      ...(cwd ? { cwd } : {}),
      ...(description ? { description } : {}),
      ...(name ? { name } : {}),
      ...(launchedAt !== undefined ? { launchedAt } : {}),
      ...(swarmWords !== null ? { swarmBrief: swarmWords } : {}),
      thinkingConfig: thinkingOverride.thinkingConfig,
      ...(structuredOutputSpec ? { structuredOutputSpec } : {}),
      ...(instructionCapture
        ? {
            instructionProfile: instructionCapture.profile,
            ...(instructionCapture.digest
              ? { instructionDigest: instructionCapture.digest }
              : {}),
          }
        : {}),
    },
    model: resolvedAgentModel,
    effortOverride,
    effort: resolvedEffort !== undefined ? String(resolvedEffort) : undefined,
  })
}

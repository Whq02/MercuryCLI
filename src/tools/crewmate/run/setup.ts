import { ASK_ADVISOR_TOOL_NAME } from '../../ask-advisor/constants.js'
import { COMPUTER_TOOL_NAME } from '../../../integrations/desktop/toolName.js'
import type { InstructionProfile } from '../../../sessions/instruction-contracts/contracts.js'
import { createSubagentContext } from '../../../crew/agents/forkedAgent.js'
import { claimDiagnosticsRoot } from '../../../integrations/lsp/LSPDiagnosticRegistry.js'
import { processOwnerForLane } from '../../../engine/run-owner/resolveOwner.js'
import type { AgentId } from '../../../sessions/transcripts/ids.js'
import type { Tool, ToolUseContext, Tools } from '../../kit/tool.js'
import type { MCPServerConnection } from '../../../integrations/mcp-shapes/mcpServerRecords.js'
import { subagentDefaultEffort } from '../../../crew/agents/agentDefaults.js'
import { createFileStateCacheWithSizeLimit } from '../../../platform/files/fileStateCache.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getSchemaBoundStructuredOutputTool } from '../../structured-output/structuredOutputTool.js'
import type { PermissionMode } from '../../../permissions/rules/permissionMode.js'
import { recordAtRunStart } from '../../../crew/crewmates/crewmateRecord.js'
import { swarmBrief } from '../../../crew/board/seam.js'
import { type ThinkingConfig, sessionThinkingConfig } from '../../../models/effort/thinking.js'
import { restrictReviewerTools } from '../reviewerPolicy.js'
import { restrictScoutTools } from '../scoutPolicy.js'
import { composeAgentAppState, definitionModeWithinConsent, resolveAgentPromptPosture } from '../agentPermissionPosture.js'
import type { resolveAgentEffort, RunAgentParams } from '../runCrewmate.js'

type PostureNeeds = Pick<RunAgentParams, 'toolUseContext' | 'agentDefinition' | 'isAsync' | 'canShowPermissionPrompts' | 'allowedTools' | 'effortOverride' | 'useExactTools'> & {
  resolveAgentEffort: typeof resolveAgentEffort
}

export function agentPostureOf({ toolUseContext, agentDefinition, isAsync, canShowPermissionPrompts, allowedTools, effortOverride, useExactTools, resolveAgentEffort }: PostureNeeds) {
  const parentGetAppState = toolUseContext.getAppState
  const definitionMode = agentDefinition.permissionMode as
    | PermissionMode
    | undefined
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

export function agentToolsOf({ availableTools, swarm, mcp, structuredOutputSpec, reviewReceipt, worktreePath, readOnlyScout }: ToolsNeeds): Tools {
  let tools: Tools = availableTools
    .filter(tool => tool.name !== COMPUTER_TOOL_NAME && (swarm || tool.name !== 'CrewBoard'))
    .map(tool => tool.name === 'CrewBoard' ? { ...tool, alwaysLoad: true } : tool)
  if (mcp.tools.length > 0) {
    const merged = [...tools]
    for (const mcpTool of mcp.tools) {
      if (!merged.some(existing => existing.name === mcpTool.name)) {
        merged.push(mcpTool)
      }
    }
    tools = merged
  }

  if (structuredOutputSpec !== undefined) {
    const bound = getSchemaBoundStructuredOutputTool(structuredOutputSpec.schema)
    if (bound.tool !== undefined) {
      tools = [...tools.filter(t => t.name !== bound.tool.name), bound.tool]
    } else {
      logForDebugging(
        `runAgent: structured-output schema failed to bind (${bound.error ?? 'unknown'}) — dispatch proceeds without the tool`,
        { level: 'error' },
      )
    }
  }

  if (reviewReceipt !== undefined) tools = restrictReviewerTools(tools, reviewReceipt, worktreePath!)
  if (readOnlyScout) tools = restrictScoutTools(tools)
  tools = tools.filter(tool => tool.name !== ASK_ADVISOR_TOOL_NAME)
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

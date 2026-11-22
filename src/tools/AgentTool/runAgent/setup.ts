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
import type { PermissionMode } from '../../../utils/permissions/PermissionMode.js'
import { recordAtRunStart } from '../../../services/crew/crewmateRecord.js'
import { swarmBrief } from '../../../services/crewBoard/seam.js'
import { type ThinkingConfig, sessionThinkingConfig } from '../../../utils/thinking.js'
import { restrictReviewerTools } from '../reviewerPolicy.js'
import { restrictScoutTools } from '../scoutPolicy.js'
import { composeAgentAppState, definitionModeWithinConsent, resolveAgentPromptPosture } from '../agentPermissionPosture.js'
import type { resolveAgentEffort, RunAgentParams } from '../runAgent.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

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

export function agentToolsOf(arg0: ToolsNeeds): Tools {
  return notBuilt('src/tools/AgentTool/runAgent/setup.ts:79')
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

export function childContextOf(arg0: ChildContextNeeds): Unbuilt {
  return notBuilt('src/tools/AgentTool/runAgent/setup.ts:125')
}

type RecordNeeds = Unbuilt

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

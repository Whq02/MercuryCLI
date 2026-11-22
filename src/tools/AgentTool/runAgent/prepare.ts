import { getCwd } from '../../../utils/cwd.js'
import { getInstructionSliceForProfile } from '../../../services/instructions/engine.js'
import { isInstructionProfile, resolveRequestedInstructionProfile } from '../../../services/instructions/profile.js'
import type { InstructionProfile } from '../../../utils/instructions/contracts.js'
import { INSTRUCTIONS_CONTEXT_KEY } from '../../../utils/userContextReminder.js'
import type { Message } from '../../../types/message.js'
import type { AgentId } from '../../../types/ids.js'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { MCPServerConnection } from '../../../utils/mcp/types.js'
import { getSystemContext, getUserContext, isInstructionDiscoveryDisabled } from '../../../context.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { registerAgentHooks } from '../../../utils/hooks/registerFrontmatterHooks.js'
import { fireHooks } from '../../../utils/hooks/fire.js'
import { hasHooksFor } from '../../../utils/hooks/matching.js'
import { hookMayMeetCopy, worktreeHoldOf } from '../../../utils/worktreeReadiness.js'
import { HOOK_EVENTS } from '../../../utils/hooks/contract.js'
import { hookRowsOfResult } from '../../../utils/hooks/rows.js'
import { createAttachmentMessage } from '../../../services/attachments.js'
import { logForDebugging } from '../../../utils/debug.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../SyntheticOutputTool/structuredOutputTool.js'
import { errorMessage } from '../../../utils/errors.js'
import { passedOver } from '../../../utils/passedOver.js'
import { createUserMessage, extractTextContent } from '../../../services/messages.js'
import { getAgentTranscriptPath, readAgentMetadata, registerAgentTranscriptDestination, writeAgentMetadata } from '../../../utils/sessionStorage.js'
import { swarmBrief } from '../../../services/crewBoard/seam.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { isRestrictedToExtensionsOnly, isSourceAdminTrusted } from '../../../utils/settings/extensionOnlyPolicy.js'
import type { MercuryAgentSeat } from '../../../prompt/mercuryContract.js'
import type { AgentDefinition } from '../../../types/agent.js'
import { REVIEW_BRIEF } from '../reviewerPolicy.js'
import { agentPostureOf, agentToolsOf, childContextOf, runStartRecordOf } from './setup.js'
import { type AgentRun, sdkStatusOf } from './watch.js'
import type { connectAgentMcpServers, landAgentTranscriptRows, resolveAgentEffort, RecoveryAccountant, RunAgentParams } from '../runAgent.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type PrepareNeeds = Pick<RunAgentParams, 'name' | 'description' | 'override' | 'agentDefinition' | 'instructionProfileOverride' | 'toolUseContext' | 'isAsync' | 'canShowPermissionPrompts' | 'allowedTools' | 'effortOverride' | 'useExactTools' | 'promptMessages' | 'cwd' | 'availableTools' | 'structuredOutputSpec' | 'worktreePath' | 'thinkingConfigOverride' | 'querySource' | 'contentReplacementState' | 'seatHolder' | 'onWait' | 'preserveToolUseResults' | 'onQueryProgress' | 'onCacheSafeParams' | 'model' | 'launchedAt'> & {
  agentId: AgentId
  swarm: boolean
  abortController: AbortController
  slimAgentGateOn: () => boolean
  withoutInstructionBlob: (context: { [k: string]: string }) => { [k: string]: string }
  readOnlyScout: boolean
  resolveAgentEffort: typeof resolveAgentEffort
  hookScope: { sessionId: string; crewmateId: AgentId }
  resolvedAgentModel: string
  rootSetAppState: ToolUseContext['setAppState']
  preloadSkills: (definition: AgentDefinition, toolUseContext: ToolUseContext) => Promise<Message[]>
  connectAgentMcpServers: typeof connectAgentMcpServers
  mcp: { clients: MCPServerConnection[]; tools: Tool[]; cleanup: () => Promise<void> }
  reviewReceipt: string | undefined
  buildAgentSystemPrompt: (definition: AgentDefinition, toolUseContext: ToolUseContext, resolvedAgentModel: string, enabledToolNames: ReadonlySet<string>, agentId: AgentId, seat: MercuryAgentSeat) => Promise<string[]>
  seat: MercuryAgentSeat
  isFork: boolean
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>
  childContextRef: { current: ToolUseContext | undefined }
  agentKind: NonNullable<RunAgentParams['agentKind']>
  run: AgentRun
  accountant: RecoveryAccountant
  touchThrough: (declaredMs: number) => void
  initialMessages: Message[]
  landAgentTranscriptRows: typeof landAgentTranscriptRows
  resolvedEffort: ReturnType<typeof resolveAgentEffort>
}

export async function prepareAgentRun(arg0: PrepareNeeds): Promise<Unbuilt> {
  return notBuilt('src/tools/AgentTool/runAgent/prepare.ts:64')
}

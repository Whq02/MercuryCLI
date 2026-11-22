import { randomUUID } from 'node:crypto'
import type { UUID } from 'node:crypto'

import type { QuerySource } from '../../constants/querySource.js'
import type { Terminal } from '../../query/transitions.js'
import type { CanUseToolFn } from '../../Tool.js'
import { accumulateUsage, updateUsage } from '../providers/anthropic/cacheAndUsage.js'
import { EMPTY_USAGE } from '../../utils/api/emptyUsage.js'
import { rosterOwnerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import type { AppState } from '../../state/AppStateStore.js'
import { advanceToolCallChain, type ToolUseContext } from '../../Tool.js'
import { withAllowedCommandRules } from '../../tools/AgentTool/agentPermissionPosture.js'
import { MERCURY_CREW_AGENT } from '../../tools/AgentTool/built-in/mercuryCrewAgent.js'
import type { AgentDefinition } from '../../types/agent.js'
import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import type { NonNullableUsage } from '../api/logging.js'
import type { ApiMessageDeltaUsage } from '../../types/wire.js'
import type { PromptCommand } from '../../commands.js'
import { logForDebugging } from '../../utils/debug.js'
import { cloneFileStateCache, type FileStateCache } from '../../utils/fileStateCache.js'
import { createChildAbortController } from '../../utils/abortController.js'
import type { TurnAnswerContext } from '../../query/turnAnswerContext.js'
import { createUserMessage, extractTextContent, getLastAssistantMessage } from '../messages.js'
import { parseToolListFromCLI } from '../../utils/permissions/permissionSetup.js'
import { recordSidechainTranscript, writtenChainTail } from '../../utils/sessionStorage.js'
import { settledSidechainMessages } from '../../utils/sessionStorage/settledSidechainMessages.js'
import { closeAgentTranscript } from '../../utils/sessionStorage/writer.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { cloneContentReplacementState, type ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export type CacheSafeParams = Unbuilt

type SubagentContextOverrides = Unbuilt

export type ForkedAgentParams = Unbuilt

type ForkedAgentResult = Unbuilt

type PreparedForkedContext = Unbuilt

export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  return notBuilt('src/services/agents/forkedAgent.ts:94')
}

export function getLastCacheSafeParams(): CacheSafeParams | null {
  return notBuilt('src/services/agents/forkedAgent.ts:98')
}

export function createCacheSafeParams(hookContext: TurnAnswerContext): CacheSafeParams {
  return notBuilt('src/services/agents/forkedAgent.ts:102')
}


const sentRequests = new Map<string, Message[]>()
const SENT_REQUESTS_CAP = 32

export function recordSentRequest(ownerKey: string, messages: readonly Message[]): void {
  sentRequests.delete(ownerKey)
  sentRequests.set(ownerKey, [...messages])
  while (sentRequests.size > SENT_REQUESTS_CAP) {
    const oldest = sentRequests.keys().next().value
    if (oldest === undefined) break
    sentRequests.delete(oldest)
  }
}

export function lastSentRequestFor(ownerKey: string): Message[] | null {
  return sentRequests.get(ownerKey) ?? null
}

export function resetSentRequestsForTests(): void {
  sentRequests.clear()
}

export function continuationOfSentRequest(
  sent: readonly Message[] | null,
  current: readonly Message[],
): { sent: Message[]; tail: Message[] } | null {
  if (sent === null || sent.length === 0) return null
  const present = new Set(current.map(row => row.uuid))
  let index = 0
  for (const row of sent) {
    const head = current[index]
    if (head !== undefined && head.uuid === row.uuid) {
      index++
      continue
    }
    const minted = row.type === 'user' && row.isMeta === true && !present.has(row.uuid)
    if (minted) continue
    return null
  }
  return { sent: [...sent], tail: current.slice(index) }
}


export function createGetAppStateWithAllowedTools(
  baseGetAppState: () => AppState,
  allowedTools: string[],
): () => AppState {
  return notBuilt('src/services/agents/forkedAgent.ts:155')
}


export async function prepareForkedCommandContext(
  command: PromptCommand & { name?: string },
  args: string,
  context: ToolUseContext,
): Promise<PreparedForkedContext> {
  return notBuilt('src/services/agents/forkedAgent.ts:164')
}

export function extractResultText(messages: Message[], defaultText: string = 'Execution completed.'): string {
  const last = getLastAssistantMessage(messages)
  if (!last) return defaultText
  const text = extractTextContent(last.message.content, '\n')
  return text.length > 0 ? text : defaultText
}


export function createSubagentContext(parentContext: ToolUseContext, overrides?: SubagentContextOverrides): ToolUseContext {
  return notBuilt('src/services/agents/forkedAgent.ts:193')
}


function usageOf(event: unknown): ApiMessageDeltaUsage | undefined {
  const usage = (event as { usage?: ApiMessageDeltaUsage } | undefined)?.usage
  return usage && typeof usage === 'object' ? usage : undefined
}

type ForkUsageFold = { total: NonNullableUsage; open: NonNullableUsage | null }
export const EMPTY_FORK_USAGE_FOLD: ForkUsageFold = { total: EMPTY_USAGE, open: null }
export function foldForkUsageEvent(
  fold: ForkUsageFold,
  event: { type?: string; usage?: unknown; message?: { usage?: unknown } },
): ForkUsageFold {
  if (event.type === 'message_start') {
    return { total: fold.total, open: updateUsage(EMPTY_USAGE, usageOf(event.message)) }
  }
  if (event.type === 'message_delta') {
    return { total: fold.total, open: updateUsage(fold.open ?? EMPTY_USAGE, usageOf(event)) }
  }
  if (event.type === 'message_stop') {
    return fold.open === null ? fold : { total: accumulateUsage(fold.total, fold.open), open: null }
  }
  return fold
}
export function settleForkUsageFold(fold: ForkUsageFold): NonNullableUsage {
  return fold.open === null ? fold.total : accumulateUsage(fold.total, fold.open)
}

export async function runForkedAgent(params: ForkedAgentParams): Promise<ForkedAgentResult> {
  return notBuilt('src/services/agents/forkedAgent.ts:276')
}

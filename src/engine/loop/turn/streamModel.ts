import type { EngineLadder } from '../../requests/backupEngines.js'
import { modelSwitchReceipt } from '../../../models/roads/anthropic/thinkingBinding.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { isTurnOwningQuerySource } from '../../../models/effort/effort.js'
import type { Message } from '../../message-shapes/message.js'
import type { MCPServerConnection } from '../../../integrations/mcp-shapes/mcpServerRecords.js'
import type { RequestWaitV1 } from '../../../models/roads/streamIdleBudget.js'
import { createSystemMessage } from '../../messages/messages.js'
import { prependUserContext, firstTurnUserContext } from '../../messages/apiSystemAndToolSchema.js'
import { latestUserContextBody } from '../../attachment-shapes/userContext.js'
import { ownerFromToolUseContext } from '../../run-owner/resolveOwner.js'
import { recordSentRequest } from '../../../crew/agents/forkedAgent.js'
import { buildModelCallReference, type ModelCallReference } from '../call-reference.js'
import type { RunEvent } from '../events.js'
import type { EventMint, IterationState, RunCtx } from './turnState.js'
import { callWithPolicy, streamReceipts, type ModelCall, type StreamOutcome } from './callPolicy.js'
import { readStream } from './readStream.js'

export { emitSyntheticSettlements, modelCallFailed, streamReceipts, waitForModelPermit } from './callPolicy.js'
export { classifyDroppedThinking, settleReply } from './readStream.js'

const switchReceipts = new Set<string>()

type CallTerms = {
  effortValue: IterationState['appState']['effortValue']
  callReference: ModelCallReference
}

type CallSending = {
  ownerKey: string
  sent: Message[]
  onStreamingFallback: () => void
  reachedTheRoad: () => void
}

export function* announceModelCall(iter: IterationState, emit: EventMint, callId: string): Generator<RunEvent, CallTerms> {
  const { toolUseContext } = iter
  const effortValue = iter.appState.effortValue
  const callReference = buildModelCallReference({
    model: iter.currentModel,
    effort: effortValue,
    maxOutputTokensOverride: iter.maxOutputTokensOverride,
    tools: toolUseContext.options.tools,
  })
  yield emit({
    kind: 'model_call_started',
    callId,
    model: iter.currentModel,
    effort: effortValue,
    maxOutputTokensOverride: iter.maxOutputTokensOverride,
    reference: callReference,
  })
  const receipt = modelSwitchReceipt(String(ownerFromToolUseContext(toolUseContext)), iter.messagesForRequest, iter.currentModel)
  if (receipt !== null && !switchReceipts.has(receipt.key)) {
    switchReceipts.add(receipt.key)
    logForDebugging(`preserved thinking: ${receipt.text}`)
    yield emit({ kind: 'notice', message: createSystemMessage(receipt.text, 'suggestion') })
  }
  return { effortValue, callReference }
}

function firstTurnContext(run: RunCtx, iter: IterationState): Promise<Record<string, string>> | null {
  const { toolUseContext } = iter
  return latestUserContextBody(iter.messagesForRequest) === null
    ? firstTurnUserContext(run.userContext, run.systemContext, toolUseContext.options.engineModel, toolUseContext.agentId, iter.messagesForRequest)
    : null
}

function sentMessages(iter: IterationState, firstTurn: Record<string, string> | null): Message[] {
  return firstTurn === null ? iter.messagesForRequest : prependUserContext(iter.messagesForRequest, firstTurn)
}

function openCall(run: RunCtx, iter: IterationState, call: CallTerms & { streamController: AbortController }, backups: EngineLadder, sending: CallSending): ReturnType<RunCtx['deps']['callModel']> {
  const { toolUseContext } = iter
  const { options } = toolUseContext
  const { ownerKey, sent } = sending
  if (isTurnOwningQuerySource(run.querySource)) recordSentRequest(ownerKey, sent)
  return run.deps.callModel({
    messages: sent,
    systemPrompt: iter.fullSystemPrompt,
    thinkingConfig: options.thinkingConfig,
    tools: options.tools,
    signal: call.streamController.signal,
    options: {
      getToolPermissionContext: async () => toolUseContext.getAppState().toolPermissionContext,
      model: iter.currentModel,
      fallbackModel: backups.next(iter.currentModel),
      querySource: run.querySource,
      isNonInteractiveSession: options.isNonInteractiveSession,
      effortValue: call.effortValue,
      maxOutputTokensOverride: iter.maxOutputTokensOverride,
      skipCacheWrite: run.skipCacheWrite,
      callReference: call.callReference,
      callChain: iter.callChain,
      agentId: toolUseContext.agentId,
      ownerKey,
      agents: options.agentDefinitions.activeAgents,
      allowedAgentTypes: options.agentDefinitions.allowedAgentTypes,
      hasAppendSystemPrompt: !!options.appendSystemPrompt,
      mcpTools: iter.appState.mcp.tools,
      hasPendingMcpServers: iter.appState.mcp.clients.some((client: MCPServerConnection) => client.type === 'pending'),
      addNotification: toolUseContext.addNotification,
      toolChoice: iter.closingTurn ? { type: 'none' } : undefined,
      onStreamingFallback: sending.onStreamingFallback,
      onWait: (wait: RequestWaitV1 | null) => toolUseContext.setSDKStatus?.({ wait }),
      onStreamActivity: (atMs: number) => {
        toolUseContext.setSDKStatus?.({ streamActivity: atMs })
        sending.reachedTheRoad()
      },
    },
  })
}

export function streamOneCall(run: RunCtx, iter: IterationState, emit: EventMint, call: ModelCall, backups: EngineLadder): AsyncGenerator<RunEvent> {
  return readStream(run, iter, emit, call, {
    firstTurnContext: () => firstTurnContext(run, iter),
    sent: firstTurn => sentMessages(iter, firstTurn),
    open: sending => openCall(run, iter, call, backups, sending),
    receipts: streamReceipts,
  })
}

export function streamModel(run: RunCtx, iter: IterationState, emit: EventMint): AsyncGenerator<RunEvent, StreamOutcome> {
  return callWithPolicy(run, iter, emit, { announce: announceModelCall, stream: streamOneCall })
}


import type { AnthropicClientOptions as ClientOptions } from './anthropicClient.js'
import { APIUserAbortError } from '../../api/sdkErrors.js'
import type { ContentBlock as BetaContentBlock } from '../../../types/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from './anthropicWire.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import type { AgentId } from 'src/types/ids.js'
import type { NativeWebSearchRequest } from 'src/services/search/nativeSearchRequest.js'
import type { EffortValue } from 'src/utils/effort.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import {
  getEmptyToolPermissionContext,
  type ToolCallChain,
  type ToolPermissionContext,
  type Tools,
} from '../../../Tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import type { ConnectorTextBlock } from '../../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../../types/message.js'
import type {
  ApiToolUnion,
  JsonOutputFormat,
  StreamCapabilityAdvertisement,
} from '../../../types/wire.js'
import { resolveEffortTruth } from '../../../utils/effort.js'
import { effortStampOf } from '../../../utils/effortStamp.js'
import { captureAPIRequest } from '../../../utils/log.js'
import { createUserMessage } from '../../../utils/messages.js'
import { utilityCallFor } from '../../../utils/model/utilityModel.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../../utils/systemPromptType.js'
import { withStreamingVCR, withVCR } from '../../vcr.js'
import { captureModelRefusalRequest, type ModelRefusalRequest } from './modelRefusal.js'
import { EMPTY_USAGE } from '../../api/logging.js'
import type { ModelCallReference } from '../../../run-core/call-reference.js'
import type { HeldBusyRetryWait } from '../busyRetry.js'
import type { RequestWaitV1 } from '../streamIdleBudget.js'
import { anthropicEffortWireFact } from './requestParams.js'
type BetaToolChoiceAuto = Extract<BetaMessageStreamParams['tool_choice'], { type: 'auto' }>
type BetaToolChoiceTool = Extract<BetaMessageStreamParams['tool_choice'], { type: 'tool' }>
type BetaToolChoiceNone = Extract<BetaMessageStreamParams['tool_choice'], { type: 'none' }>
import type { CallState, QueryCtx } from './streamCore/state.js'
import { createCallLedger } from './streamCore/callLedger.js'
import { planRequest } from './streamCore/planRequest.js'
import { requestFailed } from './streamCore/requestFailed.js'
import { closeSucceededRequest, settleAttemptLedger } from './streamCore/settleCall.js'
import { streamPass } from './streamCore/streamPass.js'
import { wireParamsFor } from './streamCore/wireParams.js'

export const ANTHROPIC_STREAM_ADVERTISEMENT: StreamCapabilityAdvertisement = {
  textDelta: true,
  reasoningDelta: true,
  toolArgsDelta: true,
  usage: true,
  timing: true,
}

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | BetaToolChoiceNone | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: ApiToolUnion[]
  nativeWebSearch?: NativeWebSearchRequest
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  onWait?: (wait: RequestWaitV1 | null) => void
  onStreamActivity?: (atMs: number) => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  effortPinned?: boolean
  ridesSessionEffort?: boolean
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  callChain?: ToolCallChain
  agentId?: AgentId
  ownerKey?: string
  outputFormat?: JsonOutputFormat
  addNotification?: (notif: Notification) => void
  callReference?: ModelCallReference
}

export {
  accumulateUsage,
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  cleanupStream,
  updateUsage,
} from './cacheAndUsage.js'

export async function queryModelWithoutStreaming(
  request: CallModelParams,
): Promise<AssistantMessage> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = request
  const settled: AssistantMessage[] = []
  const stream = withStreamingVCR(messages, () =>
    queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options),
  )
  for await (const item of stream) {
    if (item.type === 'assistant') settled.push(item)
  }
  const last = settled.at(-1)
  if (last) return last
  throw signal.aborted ? new APIUserAbortError() : new Error('No assistant message found')
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: CallModelParams): CallModelStream {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

export { executeNonStreamingRequest } from './streamCore/nonStreaming.js'

export { cutToolCallOf } from './streamCore/streamPart.js'

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage,
  void
> {

  const { captureSignInRequest, observeSignInResponse } = require('../../../utils/accounts/signInRefusal.js') as typeof import('../../../utils/accounts/signInRefusal.js')
  const resolvedModel = options.model
  const modelRefusalRequest: { current?: ModelRefusalRequest } = {}
  const effortPinned = options.effortPinned === true
  const effortTruth = resolveEffortTruth(options.model, options.effortValue, { agentId: options.agentId, pinned: effortPinned })
  const effortRides = effortPinned || options.ridesSessionEffort !== false
  const effortAsked = effortRides ? effortTruth.requested : undefined
  const call: CallState = {
    signInRequest: undefined,
    effortOnWire: effortStampOf(effortAsked, effortTruth.supportsEffort ? { kind: 'omitted' } : { kind: 'unsupported' }),
    start: 0,
    stream: undefined,
    streamRequestId: undefined,
    clientRequestId: undefined,
    streamResponse: undefined,
    sentThinkingPrefix: undefined,
    ledgerFirstDifference: null,
    ttftMs: 0,
    partialMessage: undefined,
    usage: EMPTY_USAGE,
    servedModel: undefined,
    stopReason: null,
    ledgerSettled: false,
    didFallBackToNonStreaming: false,
    fallbackMessage: undefined,
    maxOutputTokens: 0,
    preFirstEventStreamRetryUsed: false,
    streamCutRetryUsed: false,
    emptyStreamEnds: 0,
    settledNormally: false,
  }
  const captureModelRequest = (params: BetaMessageStreamParams): void => {
    modelRefusalRequest.current = captureModelRefusalRequest(params.model)
    call.effortOnWire = effortStampOf(effortAsked, anthropicEffortWireFact(params as Parameters<typeof anthropicEffortWireFact>[0], effortTruth.supportsEffort))
    call.signInRequest = captureSignInRequest('anthropic')
    captureAPIRequest(params, options.querySource)
  }

  const planned = await planRequest(messages, systemPrompt, thinkingConfig, tools, options)
  const { rosterOwnerKey, messagesForAPI, prefixKey, turnOwning } = planned
  const paramsFromContext = wireParamsFor(planned, messages, thinkingConfig, options, call, effortRides, effortPinned)

  const startIncludingRetries = Date.now()
  call.start = Date.now()

  const newMessages: AssistantMessage[] = []
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  const stoppedBlockIndices = new Set<number>()
  const ledger = createCallLedger(call, tools, options, resolvedModel, newMessages, contentBlocks, stoppedBlockIndices, observeSignInResponse)

  const heldWaitDoor = options.agentId !== undefined ? (wait: HeldBusyRetryWait): void => options.onWait?.(wait) : undefined
  const ctx: QueryCtx = {
    messages,
    thinkingConfig,
    tools,
    signal,
    options,
    modelRefusalRequest,
    captureModelRequest,
    observeSignInResponse,
    rosterOwnerKey,
    prefixKey,
    turnOwning,
    messagesForAPI,
    startIncludingRetries,
    paramsFromContext,
    heldWaitDoor,
    newMessages,
    contentBlocks,
    stoppedBlockIndices,
    ...ledger,
  }
  try {
    streamingPass: for (;;) {
      const passEnd = yield* streamPass(ctx, call)
      if (passEnd === 'again') continue streamingPass
      if (passEnd === 'return') return
      break
    }
    call.settledNormally = true
  } catch (errorFromRetry) {
    if ((yield* requestFailed(ctx, call, errorFromRetry)) === 'return') return
  } finally {
    settleAttemptLedger(ctx, call)
  }

  closeSucceededRequest(ctx, call)
}

type UtilityOptions = Omit<Options, 'model' | 'getToolPermissionContext' | 'effortValue' | 'effortPinned' | 'ridesSessionEffort'>

export async function queryUtility({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: JsonOutputFormat
  signal: AbortSignal
  options: UtilityOptions
}): Promise<AssistantMessage> {
  const { thinkingConfig, ...call } = utilityCallFor()
  return queryWithModel({
    systemPrompt,
    userPrompt,
    outputFormat,
    signal,
    thinkingConfig,
    options: { ...options, ...call, effortPinned: true },
  })
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

type OneShotQuestion = {
  systemPrompt: SystemPrompt; userPrompt: string; outputFormat?: JsonOutputFormat
  signal: AbortSignal; options: QueryWithModelOptions; thinkingConfig?: ThinkingConfig
}

function sideQuestionParams(question: OneShotQuestion, systemPrompt: SystemPrompt): CallModelParams {
  return {
    messages: [createUserMessage({ content: question.userPrompt })], systemPrompt,
    thinkingConfig: question.thinkingConfig ?? { type: 'disabled' }, tools: [], signal: question.signal,
    options: {
      ridesSessionEffort: false, ...question.options, enablePromptCaching: question.options.enablePromptCaching ?? false,
      outputFormat: question.outputFormat, getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    },
  }
}

export async function queryWithModel(question: OneShotQuestion): Promise<AssistantMessage> {
  const { systemPrompt = asSystemPrompt([]), userPrompt, outputFormat, signal, options, thinkingConfig } = question
  question = { systemPrompt, userPrompt, outputFormat, signal, options, thinkingConfig }
  const { routedCallModel, settleAssistantTurn } = await import('../../providers/callModelRouter.js')
  const recordedInput = [
    createUserMessage({ content: systemPrompt.map(text => ({ type: 'text', text })) }),
    createUserMessage({ content: question.userPrompt }),
  ]
  const answer = async (): Promise<AssistantMessage[]> => {
    const stream = routedCallModel(sideQuestionParams(question, systemPrompt))
    const replies: AssistantMessage[] = []
    for await (const row of stream) if (row.type === 'assistant') replies.push(row)
    return [settleAssistantTurn(replies, question.signal.aborted)]
  }
  const [reply] = await withVCR(recordedInput, answer)
  return reply! as AssistantMessage
}

export { MAX_NON_STREAMING_TOKENS, adjustParamsForNonStreaming } from './streamCore/nonStreaming.js'

export { getMaxOutputTokensForModel } from './streamCore/wireParams.js'

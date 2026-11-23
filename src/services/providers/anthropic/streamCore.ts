import { flagEnv } from '../../../substrate/flagRegistry.js'
import type { AnthropicClientOptions as ClientOptions } from './anthropicClient.js'
import { APIConnectionError, APIError, APIUserAbortError } from '../../../utils/api/sdkErrors.js'
import type {
  AnthropicMessageParams as BetaMessageStreamParams,
} from '../../../types/anthropicWire.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { getEmptyToolPermissionContext, type Tools } from '../../../Tool.js'
import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../../types/message.js'
import type { JsonOutputFormat, StreamCapabilityAdvertisement } from '../../../types/wire.js'
import { createUserMessage } from '../../messages.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import { withStreamingVCR } from '../../vcr.js'
import type { HeldBusyRetryWait } from '../busyRetry.js'
import { emptyStreamSpentWords } from '../emptyStreamRetry.js'
import { toolCallRefusalNote } from '../toolCallGate.js'
import { safeParseJSON } from '../../../utils/json.js'
import type { RefusedToolCall } from '../../../types/message.js'
import type { RequestWaitV1 } from '../streamIdleBudget.js'
import { anthropicEffortWireFact } from './requestParams.js'
type BetaToolChoiceAuto = Extract<BetaMessageStreamParams['tool_choice'], { type: 'auto' }>
type BetaToolChoiceTool = Extract<BetaMessageStreamParams['tool_choice'], { type: 'tool' }>
type BetaToolChoiceNone = Extract<BetaMessageStreamParams['tool_choice'], { type: 'none' }>
import type { CallState, QueryCtx, StreamPass } from './streamCore/state.js'
import { createCallLedger } from './streamCore/callLedger.js'
import { executeNonStreamingRequest } from './streamCore/nonStreaming.js'
import { streamPassRetries, retryWaitOf } from './streamCore/passRetries.js'
import { preEventReissueRow, streamCutReissueRow, oneShotNoticeRow, oneShotAnswerOf, streamCreation404Row } from './streamCore/reissueRows.js'
import { failedRequestRows } from './streamCore/requestFailed.js'
import { messagesBeforeImages, requestBetas, toolRosterOf, wireRequestOf } from './streamCore/requestPlan.js'
import { closeSucceededRequest, settleAttemptLedger } from './streamCore/settleCall.js'
import { openStreamPass, resetStreamAttempt, noteStreamEvent, startMessage, openContentBlock, applyBlockDelta, settleMessageDelta, noteWatchdogCleanExit, observeStreamEnd, noteWatchdogErrorExit, sdkAbortError } from './streamCore/streamEvents.js'
import { watchStream } from './streamCore/watchStream.js'
import { wireParamsFor } from './streamCore/wireParams.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { withVCR } from '../../vcr.js'

export const ANTHROPIC_STREAM_ADVERTISEMENT: StreamCapabilityAdvertisement = {
  textDelta: true,
  reasoningDelta: true,
  toolArgsDelta: true,
  usage: true,
  timing: true,
}

export type Options = Unbuilt

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

export async function* queryModelWithStreaming(arg0: CallModelParams): CallModelStream {
  return notBuilt('src/services/providers/anthropic/streamCore.ts:172')
}

const NO_EVENTS_MESSAGE = 'Stream ended without receiving any events'
const EMPTY_CLOSE_DETAIL = 'closed with no events'

function spokenByProvider(error: unknown): boolean {
  return error instanceof APIError && !(error instanceof APIConnectionError)
}

export { executeNonStreamingRequest } from './streamCore/nonStreaming.js'

export function cutToolCallOf(block: { type: string; id?: string; name?: string; input?: unknown }): RefusedToolCall | null {
  if (block.type !== 'tool_use' || typeof block.input !== 'string' || block.input.length === 0) return null
  if (safeParseJSON(block.input, false) !== null) return null
  return {
    id: block.id ?? '',
    name: block.name ?? '',
    argumentsRaw: block.input,
    argumentsLength: block.input.length,
    code: 'invalid-json',
    reason: `the arguments were not valid JSON (${block.input.length} characters arrived before the reply ended)`,
  }
}

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
  return notBuilt('src/services/providers/anthropic/streamCore.ts:214')
}

type UtilityOptions = Unbuilt

export async function queryUtility(arg0: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: JsonOutputFormat
  signal: AbortSignal
  options: UtilityOptions
}): Promise<AssistantMessage> {
  return notBuilt('src/services/providers/anthropic/streamCore.ts:664')
}

type QueryWithModelOptions = Unbuilt

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

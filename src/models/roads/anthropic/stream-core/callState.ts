import type {
  ApiMessage as BetaMessage,
  ContentBlock as BetaContentBlock,
} from '../../../../engine/message-shapes/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from '../anthropicWire.js'
import type { ThinkingConfig } from 'src/models/effort/thinking.js'
import type { ConnectorTextBlock } from '../connectorText.js'
import type { AnthropicStream } from '../anthropicStream.js'
import type { PrefixMismatch } from '../prefixLedger.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../../../engine/message-shapes/message.js'
import type { EffortStampV1 } from '../../../effort/effortStamp.js'
import type { ModelRefusalRequest } from '../modelRefusal.js'
import type { NonNullableUsage } from '../../../../engine/requests/apiCallLogging.js'
import type { HeldBusyRetryWait } from '../../busyRetry.js'
import type { RequestWaitV1 } from '../../streamIdleBudget.js'
import type { Options } from '../streamCore.js'
import type { createCallLedger } from './callLedger.js'
import type { wireRequestOf } from './requestPlan.js'
import type { wireParamsFor } from './wireParams.js'

export type SignInRefusal = typeof import('../../signInRefusal.js')

type BetaStopReason = NonNullable<BetaMessage['stop_reason']>

export type QueryYield = StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage

export type PlannedRequest = ReturnType<typeof wireRequestOf>

export type CallState = {
  signInRequest: ReturnType<SignInRefusal['captureSignInRequest']>
  effortOnWire: EffortStampV1
  start: number
  stream: AnthropicStream | undefined
  streamRequestId: string | null | undefined
  clientRequestId: string | undefined
  streamResponse: Response | undefined
  sentThinkingPrefix: string | undefined
  ledgerFirstDifference: PrefixMismatch | null
  ttftMs: number
  partialMessage: BetaMessage | undefined
  usage: NonNullableUsage
  servedModel: string | undefined
  stopReason: BetaStopReason | null
  ledgerSettled: boolean
  didFallBackToNonStreaming: boolean
  fallbackMessage: AssistantMessage | undefined
  maxOutputTokens: number
  preFirstEventStreamRetryUsed: boolean
  streamCutRetryUsed: boolean
  emptyStreamEnds: number
  settledNormally: boolean
}

export type QueryCtx = ReturnType<typeof createCallLedger> & {
  messages: Message[]
  thinkingConfig: ThinkingConfig
  signal: AbortSignal
  options: Options
  modelRefusalRequest: { current?: ModelRefusalRequest }
  captureModelRequest: (params: BetaMessageStreamParams) => void
  observeSignInResponse: SignInRefusal['observeSignInResponse']
  rosterOwnerKey: string
  prefixKey: string
  turnOwning: boolean
  messagesForAPI: PlannedRequest['messagesForAPI']
  startIncludingRetries: number
  paramsFromContext: ReturnType<typeof wireParamsFor>
  heldWaitDoor: ((wait: HeldBusyRetryWait) => void) | undefined
  newMessages: AssistantMessage[]
  contentBlocks: (BetaContentBlock | ConnectorTextBlock)[]
  stoppedBlockIndices: Set<number>
}

export type StreamPass = {
  noteTransportActivity: (() => void) | null
  transportSawByte: boolean
  firstByte: { wait: Extract<RequestWaitV1, { kind: 'first-byte' }> | null }
  streamIdleAborted: boolean
  streamedToolUse: boolean
  sawFirstStreamEvent: boolean
  streamEventCount: number
  streamWatchdogFiredAt: number | null
  sawMessageStop: boolean
  isFirstChunk: boolean
  lastEventTime: number | null
  totalStallTime: number
  stallCount: number
}

import type { Tools } from '../../../../tools/kit/tool.js'
import type {
  AssistantMessage,
  Message,
} from '../../../../engine/message-shapes/message.js'
import type { CallModelParams } from '../../callModelContract.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../../engine/requests/apiErrorRows.js'
import { type OverflowSignal } from '../../../../engine/requests/overflowSignal.js'
import type { Options } from '../../anthropic/streamCore.js'
import { type MediaRefusal } from '../../../../engine/request-parts/mediaRefusal.js'
import {
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import {
  type GptCandidate,
  type GptReasoningProfile,
} from '../openaiCatalogue.js'
import { type EffortAdjustedV1 } from '../../../effort/effort.js'
import { retrySeconds } from '../../../../engine/requests/recoveryBudget.js'
import type { TurnRetries } from '../../../../engine/requests/withRetry.js'
import { takesBusyLadder } from '../../busyRetry.js'
import { emptyStreamSpentWords } from '../../emptyStreamRetry.js'
import {
  openaiEffortWireFact,
} from '../responsesBridge.js'
import { effortStampOf, type EffortStampV1 } from '../../../effort/effortStamp.js'
import type {
  OpenaiFault,
  OpenaiResponsesRequest,
} from '../openaiWire.js'
import type { ToolPayloadPlan } from '../../toolEconomy.js'
import type { BehaviourContract } from '../../../../engine/system-prompt/behaviourContract.js'
import type { AttemptOutcome } from './attempt.js'
import type { TurnEffort } from './turnEffort.js'

export type OpenaiTurn = {
  params: CallModelParams
  deferralFormReissued: string | undefined
  resumeTrimReissued: string | undefined
  signal: AbortSignal
  tools: Tools
  options: Options
  conversation4xxKey: string
  messages: Message[]
  prior4xxCode: string | undefined
  modelId: string
  candidate: GptCandidate | undefined
  plan: ToolPayloadPlan
  nativeDeferral: boolean
  requestedEffort: TurnEffort['requestedEffort']
  effortTruth: TurnEffort['effortTruth']
  receiptOf: TurnEffort['receiptOf']
  settlementNotes: string[]
  contract: BehaviourContract
  buildRequest: (wireEffort: string | undefined) => OpenaiResponsesRequest
  turnStartedAtMs: number
  auth: OpenaiRequestAuth
  profile: GptReasoningProfile
  effortAdjusted: EffortAdjustedV1 | undefined
  request: OpenaiResponsesRequest
  recovery: 'retried' | 'no-new-credential' | undefined
  retries: TurnRetries<OpenaiFault>
}

export type AttemptFaultOutcome = Extract<AttemptOutcome, { kind: 'fault' }>

export type AttemptFault = {
  outcome: AttemptFaultOutcome
  typed: NonNullable<AssistantMessage['error']>
  refusedMedia: MediaRefusal | null
  overflow: OverflowSignal | null
}

export function effortOnWire(turn: OpenaiTurn): EffortStampV1 {
  const { effortTruth, request } = turn
  return effortStampOf(effortTruth.requested, openaiEffortWireFact(request, effortTruth.supportsEffort))
}

export function withEffort(turn: OpenaiTurn, message: AssistantMessage): AssistantMessage {
  return { ...message, effort: effortOnWire(turn) }
}

export function busyPrefix(turn: OpenaiTurn, line: string, fault: OpenaiFault): string {
  const { retries: { busy, emptyEnd }, turnStartedAtMs } = turn
  return busy !== undefined && takesBusyLadder(fault)
    ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI stayed busy through ${busy.ladder.waitsMs.length} ${busy.ladder.waitsMs.length === 1 ? 'retry' : 'retries'} over ${retrySeconds(Date.now() - busy.ladder.startedAtMs)} — ${line.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
    : emptyEnd
      ? `${API_ERROR_MESSAGE_PREFIX}: ${emptyStreamSpentWords('OpenAI', Date.now() - turnStartedAtMs)} — ${line.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
      : line
}

import type { Tools } from '../../../../Tool.js'
import type {
  AssistantMessage,
  Message,
} from '../../../../types/message.js'
import type { CallModelParams } from '../../callModelContract.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../api/errors.js'
import { type OverflowSignal } from '../../../api/overflowSignal.js'
import type { Options } from '../../anthropic/streamCore.js'
import { type MediaRefusal } from '../../../api/mediaRefusal.js'
import {
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import {
  type GptCandidate,
  type GptReasoningProfile,
} from '../openaiCatalogue.js'
import { type EffortAdjustedV1 } from '../../../../utils/effort.js'
import { retrySeconds } from '../../../api/recoveryBudget.js'
import { type ReconnectLadder } from '../../../api/reconnectLadder.js'
import { takesBusyLadder, type BusyRetryLadder } from '../../busyRetry.js'
import { emptyStreamSpentWords } from '../../emptyStreamRetry.js'
import {
  openaiEffortWireFact,
} from '../responsesBridge.js'
import { effortStampOf, type EffortStampV1 } from '../../../../utils/effortStamp.js'
import type {
  OpenaiFault,
  OpenaiResponsesRequest,
} from '../openaiWire.js'
import type { ToolPayloadPlan } from '../../toolEconomy.js'
import type { BehaviourContract } from '../../../../prompt/behaviourContract.js'
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
  busy: { ladder: BusyRetryLadder; fault: OpenaiFault } | undefined
  reconnect: ReconnectLadder | undefined
  emptyEnds: number
  emptyEnd: boolean
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

export function busyPrefix(turn: OpenaiTurn, line: string, fault: OpenaiFault, typed: string): string {
  const { busy, emptyEnd, turnStartedAtMs } = turn
  return busy !== undefined && takesBusyLadder(fault, typed)
    ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI stayed busy through ${busy.ladder.waitsMs.length} ${busy.ladder.waitsMs.length === 1 ? 'retry' : 'retries'} over ${retrySeconds(Date.now() - busy.ladder.startedAtMs)} — ${line.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
    : emptyEnd
      ? `${API_ERROR_MESSAGE_PREFIX}: ${emptyStreamSpentWords('OpenAI', Date.now() - turnStartedAtMs)} — ${line.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
      : line
}

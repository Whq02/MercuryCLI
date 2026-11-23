import type {
  Message,
} from '../../../../engine/message-shapes/message.js'
import {
  resolveGptReasoningProfile,
} from '../openaiCatalogue.js'
import { recordWireEffortRefusal } from '../qualificationStore.js'
import {
  OPENAI_FIRST_PARTY_PROBE_KEY,
  OPENAI_NATIVE_DEFERRAL_REFUSAL,
  openaiGatewayProbeKey,
  recordGatewayProbe,
} from '../../deferralProbe.js'
import { openaiGatewayHost } from '../../deferralWire.js'
import { logForDebugging } from '../../../../platform/logs/debugLog.js'
import { MODEL_NOT_FOUND_CODE, OPENAI_MAX_ATTEMPTS, effortVocabularyRefusalOf } from './faults.js'
import { compactTranscriptFor4xxResume, isCompactionSource } from './resumeTrim.js'
import type { AttemptFault, AttemptFaultOutcome, OpenaiTurn } from './turnState.js'

export function reissueTextForm(turn: OpenaiTurn, outcome: AttemptFaultOutcome): string | undefined {
  const { nativeDeferral, deferralFormReissued, auth } = turn
  if (
    nativeDeferral &&
    deferralFormReissued === undefined &&
    outcome.retryEligible &&
    outcome.fault.status === 400 &&
    OPENAI_NATIVE_DEFERRAL_REFUSAL.test(outcome.fault.wireMessage ?? outcome.fault.message)
  ) {
    const endpoint = openaiGatewayHost()
    const key = endpoint.firstParty ? OPENAI_FIRST_PARTY_PROBE_KEY : endpoint.host === null ? null : openaiGatewayProbeKey(endpoint.host)
    if (key !== null) {
      const evidence = `http 400 (${auth.baseUrl}): ${outcome.fault.wireMessage ?? outcome.fault.message}`
      recordGatewayProbe(key, { verdict: 'text', evidence, status: 400, probedAt: new Date().toISOString() })
      const note = `[openai] ${auth.account.label} refused OpenAI's tool-search deferral form (${outcome.fault.wireMessage ?? outcome.fault.message}) — recorded for this endpoint; this call and every later one ride the client-side text form.`
      logForDebugging(note, { level: 'warn' })
      return note
    }
  }
  return undefined
}

export function reissueAtServedEffort(turn: OpenaiTurn, outcome: AttemptFaultOutcome, attempt: number): boolean {
  const { candidate, profile, modelId, auth, requestedEffort, receiptOf, buildRequest } = turn
  const refusal = candidate !== undefined ? effortVocabularyRefusalOf(outcome.fault, profile.wireEffort) : undefined
  const reissueAtServedWord =
    refusal !== undefined && candidate !== undefined && outcome.retryEligible && attempt < OPENAI_MAX_ATTEMPTS
  if (reissueAtServedWord) {
    recordWireEffortRefusal({ modelId, sourceKind: auth.account.kind, refused: refusal.refused, levels: refusal.levels })
    const served = candidate.live.supportedReasoningEfforts.filter(level => refusal.levels.includes(level))
    turn.profile = resolveGptReasoningProfile(requestedEffort, { ...candidate.live, supportedReasoningEfforts: served })
    turn.effortAdjusted = receiptOf(turn.profile, true)
    turn.request = buildRequest(turn.profile.wireEffort)
  }
  return reissueAtServedWord
}

export function trimResumedTranscript(
  turn: OpenaiTurn,
  outcome: AttemptFaultOutcome,
  typed: AttemptFault['typed'],
  reissueAtServedWord: boolean,
  refusedMedia: AttemptFault['refusedMedia'],
  overflow: AttemptFault['overflow'],
): { messages: Message[]; note: string } | null {
  const { resumeTrimReissued, prior4xxCode, options, messages, conversation4xxKey } = turn
  if (
    resumeTrimReissued === undefined &&
    prior4xxCode !== undefined &&
    !isCompactionSource(options.querySource) &&
    !reissueAtServedWord &&
    outcome.retryEligible &&
    outcome.fault.status !== undefined &&
    outcome.fault.status >= 400 &&
    outcome.fault.status < 500 &&
    typed === 'invalid_request' &&
    refusedMedia === null &&
    overflow === null &&
    !MODEL_NOT_FOUND_CODE.test(outcome.fault.code) &&
    (prior4xxCode === '4xx' || prior4xxCode === outcome.fault.code)
  ) {
    const trimmed = compactTranscriptFor4xxResume(messages, options.querySource, outcome.fault, conversation4xxKey)
    if (trimmed !== null) {
      logForDebugging(trimmed.note, { level: 'warn' })
      return trimmed
    }
  }
  return null
}

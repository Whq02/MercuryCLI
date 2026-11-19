import { getSessionKind } from '../../bootstrap/state.js'
import type { Terminal } from '../../query/transitions.js'
import { INVALID_API_KEY_ERROR_MESSAGE, isStreamFaultRecoveryNudgeEcho } from '../../services/api/errors.js'
import { emptyReplyEndedLine, emptyReplyKindOf } from '../../services/providers/emptyReply.js'
import { localRoadBesideSignIn } from '../../services/providers/local/localAccounts.js'
import { localFitRefusalFacts } from '../../services/providers/local/localCatalogue.js'
import { toolCallShapedAnswer } from '../../services/providers/local/toolCallMarkup.js'
import { unansweredAsksBlocker } from '../../services/run/unansweredAsk.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getInMemoryErrors, withoutStackFrames } from '../../utils/log.js'
import { turnCutOf } from '../../utils/messages/turnCut.js'
import { CHOOSE_A_MODEL_DOOR } from '../../utils/model/computedDefault.js'
import type { OutcomeFacts, RowDraft } from '../project.js'
import type { ConversationConfig } from '../turn.js'
import { errorClassOf, statusOfTerminal, toolCallsRefusedSentence, unexecutedToolCallSentence, OUTCOME_SENTENCES, TERMINAL_FAILURE_SENTENCES, type Denial, type ErrorClass, type OutcomeStatus } from '../vocabulary.js'
import { lastTextBlockOf } from './answer.js'

export class MaxTimeCut extends Error {
  override readonly name = 'MaxTimeCut'
}

interface SettleNeeds {
  config: ConversationConfig
  terminal: Terminal | undefined
  answer: string
  abortController: AbortController
  turnMessages: Message[]
  seedMessages: Set<Message>
  denials: Denial[]
  denialsBefore: number
  unansweredAsks: Set<string>
  recoveredUnansweredAsk: boolean
  notices: Array<{ level: 'warning' | 'error'; text: string }>
  apiErrorMessage: (AssistantMessage & { error?: string }) | null
  structuredOutput: unknown
  errorWatermark: ReturnType<typeof getInMemoryErrors>[number] | undefined
  timeLimitFacts: () => Partial<OutcomeFacts>
  endTurn: (status: OutcomeStatus, extra?: Partial<OutcomeFacts>) => AsyncGenerator<RowDraft>
}

export async function* settledTurnRows({ config, terminal, answer, abortController, turnMessages, seedMessages, denials, denialsBefore, unansweredAsks, recoveredUnansweredAsk, notices, apiErrorMessage, structuredOutput, errorWatermark, timeLimitFacts, endTurn }: SettleNeeds): AsyncGenerator<RowDraft> {
  if (terminal === undefined) {
    yield* endTurn('failed', { error: { message: 'The turn ended without a terminal', class: 'internal' } })
    return
  }
  const aborted = terminal.reason === 'aborted_streaming' || terminal.reason === 'aborted_tools'
  const cut = aborted ? turnCutOf(abortController.signal.reason).kind : null
  if (aborted && abortController.signal.reason instanceof MaxTimeCut) {
    yield* endTurn('time_limit', { ...timeLimitFacts(), ...(answer !== '' ? { answer } : {}) })
    return
  }
  let lastAssistant: (AssistantMessage & { isApiErrorMessage?: boolean }) | undefined
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    const message = turnMessages[i]!
    if (message.type === 'assistant' && !seedMessages.has(message)) {
      lastAssistant = message as AssistantMessage & { isApiErrorMessage?: boolean }
      break
    }
  }
  const endedOnApiError = terminal.reason === 'completed' && lastAssistant?.isApiErrorMessage === true
  const settled = endedOnApiError ? { status: 'failed' as const, errorClass: 'model' as const } : statusOfTerminal(terminal, cut)
  if (settled.status === 'completed') {
    const unanswered = denials.slice(denialsBefore).filter(denial => unansweredAsks.has(denial.call_id))
    if (unanswered.length > 0 && getSessionKind() !== 'oculus') {
      const tools = [...new Set(unanswered.map(denial => denial.tool))]
      if (!recoveredUnansweredAsk) {
        yield* endTurn('blocked', { answer, error: unansweredAsksBlocker(unanswered) })
        return
      }
      notices.push({ level: 'warning', text: `${tools.join(', ')} was not approved; the run continued with other tools.` })
    }
    const unexecuted = toolCallShapedAnswer(answer)
    if (unexecuted !== undefined) {
      yield* endTurn('failed', { error: { message: unexecutedToolCallSentence(unexecuted.names), class: 'model' } })
      return
    }
    if (isStreamFaultRecoveryNudgeEcho(answer)) {
      const faultWords = apiErrorMessage !== null ? lastTextBlockOf(apiErrorMessage) : ''
      yield* endTurn('failed', {
        error: {
          message: faultWords !== '' ? faultWords : TERMINAL_FAILURE_SENTENCES.model_error,
          class: apiErrorMessage?.error !== undefined ? errorClassOf(apiErrorMessage.error) : 'model',
        },
      })
      return
    }
    if (answer === '' && lastAssistant !== undefined && emptyReplyKindOf(lastAssistant) === 'empty') {
      const emptyReplies = turnMessages.filter(message => message.type === 'assistant' && !seedMessages.has(message) && emptyReplyKindOf(message as AssistantMessage) === 'empty').length
      yield* endTurn('failed', { error: { message: emptyReplyEndedLine(Math.max(1, emptyReplies - 1)), class: 'model' } })
      return
    }
    yield* endTurn('completed', { answer, ...(structuredOutput !== undefined ? { structured: structuredOutput } : {}) })
    return
  }
  const allErrors = getInMemoryErrors()
  const watermarkIndex = errorWatermark ? allErrors.indexOf(errorWatermark) : -1
  const turnErrors = allErrors.slice(watermarkIndex + 1).map(entry => withoutStackFrames(entry.error))
  const errorClass: ErrorClass = settled.errorClass ?? (settled.status === 'interrupted' ? 'interrupt' : 'internal')
  const apiErrorText = apiErrorMessage !== null ? lastTextBlockOf(apiErrorMessage) : ''
  const localFitRefused = localFitRefusalFacts(apiErrorText) !== null
  let message: string
  if (settled.status === 'interrupted') {
    message = OUTCOME_SENTENCES.interrupted({})
  } else if (terminal.reason === 'model_error' || endedOnApiError) {
    message = apiErrorMessage !== null ? lastTextBlockOf(apiErrorMessage) : terminal.reason === 'model_error' ? (terminal.error instanceof Error ? terminal.error.message : String(terminal.error ?? 'The model call failed')) : 'The model call failed'
    if (message === INVALID_API_KEY_ERROR_MESSAGE || message === CHOOSE_A_MODEL_DOOR) message = `${message}, ${localRoadBesideSignIn()}`
  } else if (cut !== null) {
    message = cut === 'idle-timeout' ? 'The turn was aborted after a no-progress timeout' : `The turn was cut: ${turnCutOf(abortController.signal.reason).detail ?? 'the run was aborted'}`
  } else if (terminal.reason === 'max_turns') {
    message = OUTCOME_SENTENCES.turn_limit({ maxTurns: config.maxTurns })
  } else if (terminal.reason === 'loop_stopped') {
    message = OUTCOME_SENTENCES.loop_stopped({})
  } else if (terminal.reason === 'tool_calls_refused') {
    message = toolCallsRefusedSentence(terminal)
  } else if (terminal.reason === 'blocking_limit' && localFitRefused) {
    message = apiErrorText
  } else {
    message = TERMINAL_FAILURE_SENTENCES[terminal.reason]
  }
  const finalClass: ErrorClass = localFitRefused ? 'context_limit' : (terminal.reason === 'model_error' || endedOnApiError) && apiErrorMessage?.error !== undefined ? errorClassOf(apiErrorMessage.error) : errorClass
  yield* endTurn(settled.status, {
    error: {
      message,
      class: finalClass,
      ...(turnErrors.length > 0 ? { detail: turnErrors } : {}),
    },
  })
}

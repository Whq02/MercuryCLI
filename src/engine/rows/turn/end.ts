import type { getSessionId } from '../../../boot/process-state/processState.js'
import type { Message } from '../../message-shapes/message.js'
import { createAttachmentMessage } from '../../attachments/turnAttachments.js'
import { isBareMode } from '../../../platform/environment/envUtils.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { turnCutOf } from '../../message-shapes/turnCut.js'
import { fireHooks } from '../../../integrations/event-hooks/fire.js'
import { hookRowsOfResult } from '../../../integrations/event-hooks/rows.js'
import { HOOK_CUT_BUDGET_MS } from '../../../integrations/event-hooks/contract.js'
import { flushSessionStorage } from '../../../sessions/transcripts/sessionStorage.js'
import { recordTurnEnd } from '../../../sessions/transcripts/writer.js'
import { noticeRow, type OutcomeFacts, type RowDraft, type RowScope, type Unstamped } from '../project.js'
import { HOOK_NOTICE_CODES, type OutcomeRow, type OutcomeStatus } from '../vocabulary.js'
import type { contextBuilder } from './context.js'
import type { ConversationState } from './state.js'

interface EndNeeds {
  clearTimeLimit: () => void
  closeTurn: (status: OutcomeStatus, extra?: Partial<OutcomeFacts>) => Unstamped<OutcomeRow>
  turnId: string
  cutCalls: string[]
  openCalls: Map<string, string>
  sessionId: ReturnType<typeof getSessionId>
  toolUseContext: ReturnType<ReturnType<typeof contextBuilder>>
  persistenceDisabled: boolean
  turnMessages: Message[]
  scope: RowScope
  inputResult: { messages: Message[] }
  seedMessages: Set<Message>
}

export function turnEnder(this: ConversationState, { clearTimeLimit, closeTurn, turnId, cutCalls, openCalls, sessionId, toolUseContext, persistenceDisabled, turnMessages, scope, inputResult, seedMessages }: EndNeeds): (status: OutcomeStatus, extra?: Partial<OutcomeFacts>) => AsyncGenerator<RowDraft> {
  const endTurn = async function* (this: ConversationState, status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}): AsyncGenerator<RowDraft> {
    clearTimeLimit()
    const row = closeTurn(status, extra)
    const aborted = this.abortController.signal.aborted
    const cut = aborted ? turnCutOf(this.abortController.signal.reason) : null
    try {
      const ended = await fireHooks(
        'turn.end',
        {
          turn_id: turnId,
          status,
          ...(row.stop !== undefined ? { stop: row.stop } : {}),
          ...(row.error !== undefined ? { error: { message: row.error.message, class: row.error.class } } : {}),
          ...(cut !== null ? { cut: { reason: cut.kind, ...(cut.detail !== undefined ? { detail: cut.detail } : {}), tools: [...cutCalls, ...openCalls.values()] } } : {}),
          steps: row.steps,
          wall_ms: row.wall_ms,
          ...(row.cost_usd !== undefined ? { cost_usd: row.cost_usd } : {}),
          usage: row.usage,
          ...(row.answer !== undefined ? { answer: row.answer } : {}),
        },
        { scope: { sessionId: String(sessionId) }, toolUseContext, ...(cut !== null ? { budgetMs: HOOK_CUT_BUDGET_MS } : {}) },
      )
      const hookRows = hookRowsOfResult(ended)
      if (hookRows.length > 0) {
        const attachments = hookRows.map(hookRow => createAttachmentMessage(hookRow))
        this.mutableMessages.push(...attachments)
        turnMessages.push(...attachments)
        if (!persistenceDisabled) await this.recordDelta(turnMessages)
      }
      for (const hookRow of hookRows) {
        if (hookRow.outcome === 'failed' || hookRow.outcome === 'notice') yield noticeRow(scope, 'warning', hookRow.words, HOOK_NOTICE_CODES[hookRow.outcome])
      }
    } catch (error) {
      logError(error)
    }
    if (!persistenceDisabled && (inputResult.messages.length > 0 || turnMessages.some(message => !seedMessages.has(message)))) {
      try {
        await this.recordDelta(turnMessages)
        await recordTurnEnd(turnId, status)
        if (!isBareMode()) await flushSessionStorage()
      } catch (error) {
        logError(error)
      }
    }
    yield row
  }.bind(this)
  return endTurn
}

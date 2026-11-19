import type { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { isBareMode } from '../../utils/envUtils.js'
import { HOOK_CUT_BUDGET_MS } from '../../utils/hooks/contract.js'
import { fireHooks } from '../../utils/hooks/fire.js'
import { hookRowsOfResult } from '../../utils/hooks/rows.js'
import { logError } from '../../utils/log.js'
import { turnCutOf } from '../../utils/messages/turnCut.js'
import { flushSessionStorage } from '../../utils/sessionStorage.js'
import { recordTurnEnd } from '../../utils/sessionStorage/writer.js'
import { noticeRow, type RowDraft, type RowScope } from '../project.js'
import { HOOK_NOTICE_CODES, type OutcomeStatus, type Usage } from '../vocabulary.js'

type EndingRow = RowDraft & { stop?: string; error?: { message: string; class: string }; steps: number; wall_ms: number; cost_usd?: number; usage: Usage; answer?: string }

interface EndingNeeds {
  scope: RowScope
  turnId: string
  sessionId: ReturnType<typeof getSessionId>
  abortController: AbortController
  toolUseContext: ToolUseContext
  inputResult: { messages: Message[] }
  mutableMessages: Message[]
  turnMessages: Message[]
  seedMessages: Set<Message>
  persistenceDisabled: boolean
  recordDelta: (turnMessages: Message[]) => Promise<string | null>
  cutCalls: string[]
  openCalls: Map<string, string>
}

export function turnEnder({ scope, turnId, sessionId, abortController, toolUseContext, inputResult, mutableMessages, turnMessages, seedMessages, persistenceDisabled, recordDelta, cutCalls, openCalls }: EndingNeeds): (status: OutcomeStatus, row: EndingRow) => AsyncGenerator<RowDraft> {
  const turnEnding = async function* (status: OutcomeStatus, row: EndingRow): AsyncGenerator<RowDraft> {
    const aborted = abortController.signal.aborted
    const cut = aborted ? turnCutOf(abortController.signal.reason) : null
    try {
      const ended = await fireHooks(
        'turn.end',
        {
          turn_id: turnId,
          status,
          ...(row.stop !== undefined ? { stop: row.stop as never } : {}),
          ...(row.error !== undefined ? { error: { message: row.error.message, class: row.error.class as never } } : {}),
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
        mutableMessages.push(...attachments)
        turnMessages.push(...attachments)
        if (!persistenceDisabled) await recordDelta(turnMessages)
      }
      for (const hookRow of hookRows) {
        if (hookRow.outcome === 'failed' || hookRow.outcome === 'notice') yield noticeRow(scope, 'warning', hookRow.words, HOOK_NOTICE_CODES[hookRow.outcome])
      }
    } catch (error) {
      logError(error)
    }
    if (!persistenceDisabled && (inputResult.messages.length > 0 || turnMessages.some(message => !seedMessages.has(message)))) {
      try {
        await recordDelta(turnMessages)
        await recordTurnEnd(turnId, status)
        if (!isBareMode()) await flushSessionStorage()
      } catch (error) {
        logError(error)
      }
    }
    yield row
  }
  return turnEnding
}

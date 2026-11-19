import { retryReasonWords } from '../../services/providers/streamIdleBudget.js'
import type { Message, SystemCloseUsageMessage } from '../../types/message.js'
import { advanceLedgerMark } from '../../utils/ledgerMark.js'
import { noticeRow, retryWaitRow, type RowDraft, type RowScope } from '../project.js'
import { closeRowOf } from './close.js'

interface SystemRowsNeeds {
  scope: RowScope
  ledgerAtStart: Parameters<typeof advanceLedgerMark>[0]
  turnStartedAt: number
  mutableMessages: Message[]
  turnMessages: Message[]
  notices: Array<{ level: 'warning' | 'error'; text: string }>
  recordDelta: () => Promise<void>
}

export async function* systemMessageRows({ scope, ledgerAtStart, turnStartedAt, mutableMessages, turnMessages, notices, recordDelta }: SystemRowsNeeds, message: Message & { subtype?: string }): AsyncGenerator<RowDraft, boolean> {
  const systemMessage = message
  if (systemMessage.subtype === 'close_usage') {
    const close = systemMessage as SystemCloseUsageMessage
    if (close.spent !== undefined) advanceLedgerMark(ledgerAtStart, close.spent)
    yield closeRowOf(scope, close)
    return true
  }
  if (systemMessage.subtype === 'api_error') {
    mutableMessages.push(systemMessage)
    turnMessages.push(systemMessage)
    await recordDelta()
    const apiError = systemMessage as { retryAttempt?: number; maxRetries?: number; retryInMs?: number; errorDetail?: { status?: number | null }; error?: { status?: number | null; message?: string } }
    const httpStatus = apiError.errorDetail?.status ?? apiError.error?.status ?? null
    yield retryWaitRow(scope, {
      attempt: apiError.retryAttempt,
      of: apiError.maxRetries,
      reason: retryReasonWords(httpStatus, apiError.error?.message),
      delayMs: apiError.retryInMs,
      httpStatus,
      sinceMs: Date.now() - turnStartedAt,
    })
    return true
  }
  if (systemMessage.subtype !== 'compact_boundary') {
    const level = (systemMessage as { level?: string }).level
    if (systemMessage.subtype === 'informational' && (level === 'warning' || level === 'error')) {
      mutableMessages.push(systemMessage)
      turnMessages.push(systemMessage)
      await recordDelta()
      const text = String((systemMessage as { content?: unknown }).content ?? '')
      notices.push({ level, text })
      yield noticeRow(scope, level, text)
      return true
    }
    mutableMessages.push(systemMessage)
    if (level === 'warning' || level === 'error' || level === 'suggestion' || systemMessage.subtype === 'thinking_note' || systemMessage.subtype === 'stream_cut' || systemMessage.subtype === 'busy_recovery') {
      turnMessages.push(systemMessage)
      await recordDelta()
    }
    if (systemMessage.subtype === 'stream_cut') {
      const text = String((systemMessage as { content?: unknown }).content ?? '')
      notices.push({ level: 'warning', text })
      yield noticeRow(scope, 'warning', text)
    }
    return true
  }
  return false
}

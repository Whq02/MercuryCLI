import { canAnswerAsks } from '../../../boot/process-state/processState.js'
import type { AssistantMessage } from '../../message-shapes/message.js'
import { getAssistantMessageText } from '../../messages/messages.js'
import { API_ERROR_MESSAGE_PREFIX, PROMPT_TOO_LONG_ERROR_MESSAGE } from '../../requests/apiErrorRows.js'
import { overflowSignalOf } from '../../requests/overflowSignal.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export function isOverflowAnswer(row: AssistantMessage): boolean {
  return overflowSignalOf(row) !== null || (getAssistantMessageText(row) ?? '').startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)
}

const PAIRING_COMPLAINTS: readonly RegExp[] = [
  /\bno tool output found for function call\b/i,
  /\bno tool call found for function call output\b/i,
  /\btool_use\b[^.]{0,80}\bwithout\b[^.]{0,80}\btool_result\b/i,
  /\btool_result\b[^.]{0,80}\bwithout\b[^.]{0,80}\btool_use\b/i,
  /\bunexpected\b[^.]{0,40}\btool_use_id\b/i,
  /\btool_use\b[^.]{0,40}\bids? must be unique\b/i,
  /\btool_call_ids?\b[^.]{0,120}\b(?:did not have|without)\b[^.]{0,80}\bresponse/i,
  /\brole 'tool'\b[^.]{0,80}\bmust be a response to\b/i,
  /\bduplicate\b[^.]{0,60}\b(?:call_id|call id|function call id|tool_call_id)\b/i,
]

function providerSentencesOf(row: AssistantMessage): Array<{ words: string; status?: number }> {
  const out: Array<{ words: string; status?: number }> = []
  if (typeof row.errorDetails === 'string' && row.errorDetails.trim() !== '') out.push({ words: row.errorDetails })
  const text = getAssistantMessageText(row) ?? ''
  const prefix = `${API_ERROR_MESSAGE_PREFIX}: `
  let words = text.startsWith(prefix) ? text.slice(prefix.length) : text
  let status: number | undefined
  const spelled = /^(\d{3})\s+/.exec(words)
  if (spelled) {
    status = Number(spelled[1])
    words = words.slice(spelled[0].length)
  }
  const body = words.indexOf('{')
  if (body >= 0) {
    try {
      const parsed = JSON.parse(words.slice(body)) as { error?: { message?: unknown }; message?: unknown }
      const message = parsed.error?.message ?? parsed.message
      if (typeof message === 'string' && message.trim() !== '') words = message
    } catch (error) {
      passedOver(error)
    }
  }
  out.push(status !== undefined ? { words, status } : { words })
  return out
}

export function malformedHistoryRefusalOf(row: AssistantMessage): string | null {
  if (row.isApiErrorMessage !== true) return null
  if (overflowSignalOf(row) !== null) return null
  const text = getAssistantMessageText(row) ?? ''
  const sentences = providerSentencesOf(row)
  const invalidRequest =
    row.error === 'invalid_request' ||
    /\binvalid_request_error\b/.test(text) ||
    sentences.some(sentence => sentence.status === 400)
  if (!invalidRequest) return null
  const complaint = sentences.find(sentence => PAIRING_COMPLAINTS.some(pattern => pattern.test(sentence.words)))
  return complaint === undefined ? null : complaint.words
}

export function compactionRefusedForHistoryText(providerWords: string, opts: { nonInteractive: boolean }): string {
  const remedy = opts.nonInteractive
    ? 'Start a fresh run, or pass --model with a larger window.'
    : '/compact tries again after the history heals, /clear starts fresh, or /model picks a model with a larger window.'
  return `Compaction was refused for a malformed history — ${providerWords} ${remedy}`
}

export function compactionPausedForHistoryText(providerWords: string, opts: { nonInteractive: boolean }): string {
  return `${compactionRefusedForHistoryText(providerWords, opts)} Automatic compaction is paused for the rest of this run.`
}

export function foldRemedyIsHeadless(isNonInteractiveSession: boolean | undefined): boolean {
  return isNonInteractiveSession === true && !canAnswerAsks()
}

export const FOLD_WINDOW_REFUSAL_KEY = "compaction cannot run on this model's window"

export function foldWindowRefusalText(facts: { window: number; sourceWords: string; estTokens: number; remedy: string }): string {
  return `${FOLD_WINDOW_REFUSAL_KEY} (${facts.window.toLocaleString('en-US')} tokens, ${facts.sourceWords}): its own request (≈${Math.round(facts.estTokens / 1000)}k tokens) does not fit and the server would silently truncate it. ${facts.remedy}.`
}

export class CompactionRefusedForHistoryError extends Error {
  readonly providerWords: string
  readonly nonInteractive: boolean
  constructor(providerWords: string, opts: { nonInteractive: boolean }) {
    super(compactionRefusedForHistoryText(providerWords, opts))
    this.name = 'CompactionRefusedForHistoryError'
    this.providerWords = providerWords
    this.nonInteractive = opts.nonInteractive
  }
}

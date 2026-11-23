import type { AssistantMessage } from '../../message-shapes/message.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getAssistantMessageText } from '../../messages/messages.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../requests/apiErrorRows.js'
import { SUMMARY_SECTION_TITLES } from '../summariserPrompt.js'
import { ERROR_MESSAGE_INCOMPLETE_RESPONSE, PROVIDER_FINISH_FAULT_PREFIX, PROVIDER_TERMINATION_NOTE, ERROR_MESSAGE_NO_SUMMARY, MODEL_REFUSAL_STOP_KEY } from './foldLimits.js'

export function summaryAnswerFault(response: AssistantMessage): string | null {
  if (response.isApiErrorMessage === true) {
    const details = typeof response.errorDetails === 'string' ? response.errorDetails : ''
    return details.startsWith(PROVIDER_FINISH_FAULT_PREFIX) ? `the provider ended the response before a summary (finish reason ${details.slice(PROVIDER_FINISH_FAULT_PREFIX.length)})` : null
  }
  const stop = response.message.stop_reason
  if (stop == null) return null
  const blocks = Array.isArray(response.message.content) ? (response.message.content as Array<{ type?: string }>) : []
  const thinking = blocks.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking').length
  const calls = blocks.filter(block => block.type === 'tool_use').length
  const text = getAssistantMessageText(response) ?? ''
  const thinkingWords = `${thinking} thinking block${thinking === 1 ? '' : 's'}`
  if (stop === 'max_tokens') return `the answer hit its output limit before a summary (stop reason max_tokens; ${text.length} characters of text, ${thinkingWords})`
  if (text === '') return `the answer had no text (stop reason ${stop}; ${thinkingWords}, ${calls} tool call${calls === 1 ? '' : 's'})`
  const body = summaryBody(text)
  if (!/[\p{L}\p{N}]/u.test(body)) return `the answer carried no words (${text.length} characters of wrapper or punctuation)`
  if (PROVIDER_TERMINATION_NOTE.test(body)) return `the provider ended the response before a summary: ${JSON.stringify(body.slice(0, 120))}`
  if (summarySaysNothing(body)) return "the answer carried the summary's headings and nothing under them"
  if (summaryRefusesInProse(body)) return `the answer refused in prose: ${JSON.stringify(body.slice(0, 120))}`
  return null
}

export function summaryRefusedByModel(response: AssistantMessage): boolean {
  if (response.isApiErrorMessage !== true) return false
  const details = typeof response.errorDetails === 'string' ? response.errorDetails : ''
  return details.startsWith(MODEL_REFUSAL_STOP_KEY) || (getAssistantMessageText(response) ?? '').includes(`(${MODEL_REFUSAL_STOP_KEY})`)
}

const REFUSAL_PREFACE = /^(?:(?:i(?:\s+am|['’]m)\s+(?:sorry|afraid)|sorry|i\s+apologi[sz]e|(?:my\s+)?apologies|unfortunately|regrettably|however|as\s+an\s+ai(?:\s+(?:language\s+model|assistant|model|system))?)[,.:!;]?\s*(?:but\s+|that\s+)?)+/i
const INABILITY = String.raw`(?:i(?:\s+am|['’]m)\s+(?:unable|not\s+(?:able|going|permitted|allowed|in\s+a\s+position))\s+to|i\s+(?:cannot|can['’]t|will\s+not|won['’]t|refuse\s+to|(?:must\s+)?decline\s+to|(?:won['’]t|will\s+not)\s+be\s+able\s+to))`
const SUMMARY_OBJECT = String.raw`(?:summari[sz]e\b|(?:provide|produce|write|create|generate|give|offer)\s+(?:(?:a|an|the|this|that|any|such|requested|detailed|complete|full)\s+){0,4}(?:summary|summari[sz]ation|record)\b|(?:fulfil|fulfill|complete|carry\s+out|perform)\s+(?:this|that|the|your)\s+(?:request|task|instruction)\b)`
const HELP_OBJECT = String.raw`(?:help|assist|comply|proceed|continue|engage|answer|respond|do\s+(?:that|this|so)\b|with\s+(?:that|this)\b)`
const NO_SUMMARY = String.raw`(?:no\s+summary\s+(?:will|can|could)\s+be\s+(?:provided|produced|generated|given)\b|(?:this|that|the)\s+(?:request|task)\s+(?:cannot|can['’]t|will\s+not|won['’]t)\s+be\s+(?:completed|fulfilled|carried\s+out)\b|that['’]s\s+not\s+something\s+i\s+can\b)`
const OPENING_REFUSAL = new RegExp(String.raw`^(?:${INABILITY}\s+(?:${SUMMARY_OBJECT}|${HELP_OBJECT})|${NO_SUMMARY})`, 'i')
const SENTENCE_REFUSAL = new RegExp(String.raw`^(?:${INABILITY}\s+${SUMMARY_OBJECT}|${NO_SUMMARY})`, 'i')
const HEDGED_REFUSAL_CEILING = 800
const SECTION_TITLE_LINE = new RegExp(String.raw`^\s*(?:#{1,6}\s*)?(?:\d{1,2}[.)]\s*)?\**(?:${SUMMARY_SECTION_TITLES.map(title => title.replace(/\s*\(optional\)$/, '').replace(/\s+/g, '\\s+')).join('|')})(?:\s*\(optional\))?\**:?\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…|[-*_]+)?\s*$`, 'i')
const PLACEHOLDER_LINE = /^\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…|[-*_]+)?\s*$/

function summaryBody(text: string): string {
  let body = text.replace(/<analysis>[\s\S]*?<\/analysis>/, '').trim()
  for (let pass = 0; pass < 3; pass++) {
    const wrapped = /<summary>([\s\S]*?)<\/summary>/.exec(body)
    const inner = (wrapped === null ? body : wrapped[1] ?? '').trim()
    const unfenced = inner.replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1').trim()
    if (unfenced === body) break
    body = unfenced
  }
  return body.replace(/^<summary>\s*/, '').replace(/\s*<\/summary>$/, '').trim()
}

function summaryRefusesInProse(body: string): boolean {
  if (OPENING_REFUSAL.test(body.replace(REFUSAL_PREFACE, ''))) return true
  if (body.length >= HEDGED_REFUSAL_CEILING) return false
  return body.split(/(?<=[.!?])\s+|\n+/).some(sentence => SENTENCE_REFUSAL.test(sentence.replace(REFUSAL_PREFACE, '')))
}

function summarySaysNothing(body: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(body)) return true
  return body.split('\n').every(line => SECTION_TITLE_LINE.test(line) || PLACEHOLDER_LINE.test(line))
}

export function validateSummary(response: AssistantMessage, logMissing: boolean): string {
  if (response.message.stop_reason == null) throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
  const text = getAssistantMessageText(response) ?? ''
  if (response.isApiErrorMessage === true || text.startsWith(API_ERROR_MESSAGE_PREFIX)) throw new Error(text === '' ? ERROR_MESSAGE_INCOMPLETE_RESPONSE : text)
  const fault = summaryAnswerFault(response)
  if (fault !== null) {
    if (logMissing) {
      logForDebugging(`compact: no summary in the response (${fault}): ${JSON.stringify(response).slice(0, 2000)}`, { level: 'error' })
    }
    throw new Error(`${ERROR_MESSAGE_NO_SUMMARY}: ${fault}`)
  }
  return text
}

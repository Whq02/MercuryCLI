import type { Message } from '../types/message.js'
import { isOperatorTurn } from '../utils/messages/operatorTurns.js'

export interface PinIntent {
  messageId: string
  text: string
  earlier?: string
}

function humanText(message: Message): string | null {
  if (message.type !== 'user' || !isOperatorTurn(message) || message.isVirtual || (message.origin && message.origin.kind !== 'human')) return null
  const content = message.message.content
  return typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

export function latestPinIntent(messages: readonly Message[], agentId?: string): PinIntent | undefined {
  if (agentId) return undefined
  let latest: PinIntent | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    const text = humanText(message)
    if (text === null) continue
    if (latest === undefined) { latest = { messageId: message.uuid, text }; continue }
    latest.earlier = text
    break
  }
  return latest
}

const MEMORY_ASK = /\b(?:remember|memori[sz]e|(?:do\s*n['’]?t|never|do\s+not)\s+forget|from\s+now\s+on|keep\s+(?:this|that|it|these)\s+(?:as\s+a\s+rule|in\s+mind)|(?:keep|bear)\s+in\s+mind|make\s+(?:this|that|it)\s+a\s+rule|standing\s+rule|pin\s+(?:this|that|it|these)|note\s+(?:this|that|it|these|down)|(?:write|jot)\s+(?:this|that|it|these)\s+down|(?:save|store|put)\s+(?:this|that|it|these)\s+(?:to|in|into)\s+memory|retain\s+(?:this|that|it|these)|take\s+(?:a\s+)?note|for\s+(?:future|later)\s+(?:sessions?|reference)|for\s+next\s+time|(?:that|this|it)\s+replaces\s+the\s+(?:old|earlier|previous)\s+(?:rule|one)|instead\s+of\s+the\s+(?:old|earlier|previous)\s+(?:rule|one))\b/i

export const MEMORY_ASK_REFUSAL = "Retain is refused: the operator's latest message does not ask to remember anything — a decision or an outcome belongs in the project's records; memory is written on \"remember …\", \"don't forget …\", \"note this down\", \"from now on …\" or \"pin this\""
export const CREWMATE_RETAIN_REFUSAL = 'Retain is refused: a crewmate never writes memory — put the finding in your report; the lead decides what is remembered'

export function memoryAskRefusal(messages: readonly Message[], agentId?: string): string | null {
  if (agentId) return CREWMATE_RETAIN_REFUSAL
  const latest = latestPinIntent(messages)
  return latest !== undefined && MEMORY_ASK.test(latest.text) ? null : MEMORY_ASK_REFUSAL
}

const FILLER = /^(?:(?:ok(?:ay)?|also|and|so|oh|right|cool|yes|yeah|btw|well|then)[\s,.:!-]+)*/i
const NEGATED = /^(?:please\s+|pls\s+)?(?:do\s+not|don['’]t|never|no\s+need\s+to|stop)\s+(?:remember|pin|save|keep|make|retain)\b/i
const DIRECTIVE_HEAD = /^(?:please\s+|pls\s+)?(?:remember(?:\s+(?:this|that|these))?\b|from\s+now\s+on\b|always\b|never\b|(?:i|we)\s+(?:like|prefer|want)\b|(?:standing\s+)?rule\b|every\s+(?:time|release|session|chat)\b)/i
const REQUEST_FORM = /\b(?:please\s+|pls\s+)?(?:(?:make|keep|save|pin)\s+(?:this|it|that|these)\s+(?:as\s+)?(?:a\s+)?(?:standing\s+)?(?:rules?|preferences?)\b|pin\s+(?:this|it|that|these)\b|remember\s+(?:this|that|these)\s+as\s+(?:a\s+)?(?:standing\s+)?(?:rule|preference)\b|from\s+now\s+on\b|standing\s+rule\b)/i
const RULE_WORDS = /\b(?:standing rules?|rules?|preferences?|from now on|always|never|every (?:time|release|session|chat)|(?:i|we) (?:like|prefer|want)|pin (?:this|it|that|these))\b/i
const SECOND_HAND = /\b(?:example|quote|quoted|document|draft|says|said|wrote|not\s+(?:a\s+)?rule)\b/i
const SUFFIX = /^[\s.!;,—-]*(?:please\s+|pls\s+)?(?:remember\s+(?:this|that)|pin\s+(?:this|it|that)|(?:make|keep|save|pin)\s+(?:this|it|that)\s+(?:as\s+)?(?:a\s+)?(?:standing\s+)?(?:rule|preference))\s*[.!]?\s*$/i
const ACCEPTANCE = /^[\s"']*(?:(?:ok(?:ay)?|yes|yeah|yep|sure|please|pls)[\s,.!]*)*(?:pin\s+(?:it|that|this)|(?:make|keep|save)\s+(?:it|that|this)\s+(?:as\s+)?(?:a\s+)?(?:standing\s+)?(?:rule|preference)|remember\s+(?:it|that|this))(?:\s+(?:as\s+)?(?:a\s+)?(?:standing\s+)?(?:rule|preference))?[\s.!]*$/i

interface Sentence {
  start: number
  end: number
  text: string
}

function sentences(text: string): Sentence[] {
  const out: Sentence[] = []
  for (const match of text.matchAll(/[^.!?;\n]+(?:[.!?;]+|\n|$)/g)) {
    const raw = match[0]
    const lead = raw.length - raw.trimStart().length
    const body = raw.trim()
    if (body !== '') out.push({ start: match.index + lead, end: match.index + lead + body.length, text: body })
  }
  return out
}

function directiveOf(sentence: string): string | null {
  const head = sentence.slice((FILLER.exec(sentence)?.[0] ?? '').length)
  if (NEGATED.test(head)) return null
  return DIRECTIVE_HEAD.exec(head)?.[0] ?? REQUEST_FORM.exec(head)?.[0] ?? null
}

function normalise(text: string): string {
  return text.trim().replace(/[.!]+$/, '').toLowerCase()
}

function spanIn(text: string, content: string): { start: number; end: number } | null {
  const wanted = normalise(content)
  if (!wanted) return null
  const start = text.toLowerCase().indexOf(wanted)
  if (start < 0) return null
  const end = start + wanted.length
  const before = text.slice(0, start)
  if ((before.match(/```|~~~/g) ?? []).length % 2 === 1 || /<\/?[a-z][^>]*>/i.test(before)) return null
  if (/^\s*>/.test(text.slice(text.lastIndexOf('\n', start) + 1)) || /["'“‘`]\s*$/.test(before)) return null
  const rows = sentences(text)
  const holder = rows.find(row => row.start <= start && start < row.end)
  if (!holder) return null
  let witness: { directive: string; sentence: Sentence } | null = null
  let list: { directive: string; sentence: Sentence } | null = null
  for (const row of rows) {
    if (row.start > start) break
    const directive = directiveOf(row.text)
    if (directive === null && NEGATED.test(row.text.replace(FILLER, ''))) list = null
    if (directive !== null) list = /:\s*$/.test(row.text) ? { directive, sentence: row } : null
    if (row !== holder) continue
    if (directive !== null) witness = { directive, sentence: row }
    else if (list !== null && !/\n\s*\n/.test(text.slice(list.sentence.end, row.start))) witness = list
    else if (SUFFIX.test(text.slice(end))) witness = { directive: '', sentence: row }
  }
  if (witness === null) return null
  const lead = text.slice(witness.sentence.start, start)
  if (SECOND_HAND.test(lead)) return null
  if (!RULE_WORDS.test(`${witness.sentence.text} ${holder.text} ${witness.directive === '' ? text.slice(end) : ''}`)) return null
  return { start, end }
}

export function pinIntentSpan(intent: PinIntent | undefined, content: string): { start: number; end: number } | null {
  if (!intent?.messageId || !content.trim()) return null
  const own = spanIn(intent.text, content)
  if (own !== null) return own
  if (intent.earlier === undefined || !ACCEPTANCE.test(intent.text)) return null
  const stated = spanIn(intent.earlier, content)
  if (stated !== null) return stated
  const wanted = normalise(content)
  const start = intent.earlier.toLowerCase().indexOf(wanted)
  if (start < 0 || !RULE_WORDS.test(intent.earlier)) return null
  return { start, end: start + wanted.length }
}

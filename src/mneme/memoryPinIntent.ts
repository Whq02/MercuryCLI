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

const NOT_AN_ASK = [
  "(?:do\\s*n['’]?t|do\\s+not|never|cannot|can['’]?t|can\\s+never|no\\s+need\\s+to|stop)\\s+(?:remember|memori[sz]e|save|store|note|log|keep|retain|record|pin)",
  '(?:do|did|can|could|would)\\s+you\\s+(?:still\\s+|even\\s+)?remember',
].join('|')
const MEMORY_ASK_WORDS = [
  'remember',
  'memori[sz]e',
  "(?:do\\s*n['’]?t|do\\s+not|never|please\\s+do\\s+not)\\s+forget",
  'from\\s+now\\s+on',
  'standing\\s+rule',
  'make\\s+(?:this|that|it)\\s+a\\s+rule',
  '(?:keep|bear)\\s+(?:(?:this|that|it|these)\\s+)?in\\s+mind',
  'keep\\s+(?:this|that|it|these)',
  'keep\\s+(?:a\\s+)?(?:note|track)\\s+of',
  'pin\\s+(?:this|that|it|these)',
  'retain\\s+(?:this|that|it|these)',
  '(?:use|call)\\s+(?:the\\s+)?retain(?:\\s+tool)?',
  'note(?=\\s*:)',
  'note\\s+to\\s+self',
  'note\\s+(?:this|that|it|these|down)',
  '(?:make|take|keep)\\s+a\\s+note',
  '(?:write|jot)\\s+(?:(?:this|that|it|these)\\s+)?down',
  '(?:save|add|store|put|record|log|keep)\\s+(?:(?:this|that|it|these)\\s+)?(?:facts?\\s+)?(?:to|in|into)\\s+(?:your\\s+|the\\s+)?memory',
  '(?:save|store|record)\\s+(?:this|that|these)\\s+facts?',
  'log\\s+(?:this|that|it)',
  'remind\\s+me',
  'next\\s+time',
  'for\\s+(?:future|later)\\s+(?:sessions?|reference|runs?)',
  '(?:that|this|it)\\s+replaces\\s+the\\s+(?:old|earlier|previous)\\s+(?:rule|one)',
  'instead\\s+of\\s+the\\s+(?:old|earlier|previous)\\s+(?:rule|one)',
  '(?:update|change|fix|correct)\\s+(?:the|that|this|my|your)\\s+(?:memory|note|fact|record|rule)',
  'merke?\\s+dir',
  "n['’]oublie\\s+pas",
  'souviens[-\\s]toi',
  'recuerda',
  'no\\s+(?:lo\\s+|te\\s+)?olvides',
  'ricorda(?:ti)?',
  'non\\s+dimenticare',
  'lembre(?:-se)?',
].join('|')
const WITHDRAWN = ['no\\s+wait', 'never\\s*mind', 'scratch\\s+that', 'forget\\s+(?:this|that|it|these|what\\s+i\\s+(?:just\\s+)?said)', 'ignore\\s+what\\s+i\\s+(?:just\\s+)?said'].join('|')
const MEMORY_ASK_SCAN = new RegExp(`\\b(?:(?<deny>${NOT_AN_ASK})|(?<ask>${MEMORY_ASK_WORDS})|(?<withdraw>${WITHDRAWN}))\\b`, 'gi')

export function asksForMemory(text: string): boolean {
  let asked = -1
  let withdrawn = -1
  for (const match of text.matchAll(MEMORY_ASK_SCAN)) {
    if (match.groups?.ask !== undefined) asked = match.index
    else if (match.groups?.withdraw !== undefined) withdrawn = match.index
  }
  return asked >= 0 && withdrawn < asked
}

export const MEMORY_ASK_CLIP = 120
export function quotedAsk(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MEMORY_ASK_CLIP ? `${line.slice(0, MEMORY_ASK_CLIP - 1)}…` : line
}

const RETAIN_ROAD = 'say "remember: …" (or "note this down: …", "save to memory: …") for a memory.'
export const retainAskRefusal = (latest: string | undefined): string =>
  latest === undefined
    ? `Retain is refused: no typed message of yours precedes this call, so nothing asks to remember anything; ${RETAIN_ROAD}`
    : `Retain is refused: your latest message — "${quotedAsk(latest)}" — does not ask to remember anything; ${RETAIN_ROAD}`
export const CREWMATE_RETAIN_REFUSAL = 'Retain is refused: a crewmate never writes memory — put the finding in your report; the lead decides what is remembered'

export function memoryAskRefusal(messages: readonly Message[], agentId?: string): string | null {
  if (agentId) return CREWMATE_RETAIN_REFUSAL
  const latest = latestPinIntent(messages)
  return latest !== undefined && asksForMemory(latest.text) ? null : retainAskRefusal(latest?.text)
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

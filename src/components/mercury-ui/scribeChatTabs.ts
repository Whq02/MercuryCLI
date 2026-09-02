import { parseScribeEnvelope, type ScribeEnvelope } from '../../utils/scribe/scribeBus.js'
import { GLYPH } from './glyphs.js'

export const SCRIBE_CHAT_TABS = ['general', 'scribe', 'implement', 'trace'] as const
export type ScribeChatTab = (typeof SCRIBE_CHAT_TABS)[number]

export const SCRIBE_CHAT_TAB_LABEL: Record<ScribeChatTab, string> = {
  general: 'General',
  scribe: 'Scribe',
  implement: 'Implement',
  trace: 'Trace',
}

export type ScribeAuthor = 'operator' | 'scribe' | 'implement'

export function scribeStreamName(author: ScribeAuthor, userHandle: string): string {
  return author === 'scribe'
    ? 'Mercury-Amanuensis'
    : author === 'implement'
      ? 'Mercury-Implement'
      : userHandle
}

type LooseBlock = { type?: string; text?: string }
type LooseMsg = {
  type?: string
  isMeta?: boolean
  message?: { role?: string; content?: unknown }
  content?: unknown
}

export function isChatNoise(m: LooseMsg): boolean {
  return m?.isMeta === true
}

function blocks(m: LooseMsg): unknown {
  return m?.message?.content ?? m?.content
}

export function messageText(m: LooseMsg): string {
  const c = blocks(m)
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return (c as LooseBlock[])
      .filter(b => b && (b.type === 'text' || typeof b.text === 'string'))
      .map(b => b.text ?? '')
      .join(' ')
      .trim()
  }
  return ''
}

export function hasToolActivity(m: LooseMsg): boolean {
  const c = blocks(m)
  if (!Array.isArray(c)) return false
  return (c as LooseBlock[]).some(b => b && (b.type === 'tool_use' || b.type === 'tool_result'))
}

const TEAMMATE_WRAP = /^<teammate-message teammate_id="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>$/

export function wrappedTeammateId(m: LooseMsg): string | null {
  return messageText(m).match(TEAMMATE_WRAP)?.[1] ?? null
}

export function scribeEnvelopeOf(m: LooseMsg): ScribeEnvelope | null {
  const raw = messageText(m)
  const wrap = raw.match(TEAMMATE_WRAP)
  return parseScribeEnvelope(wrap ? wrap[2]! : raw)
}

export function classifyAuthor(m: LooseMsg): ScribeAuthor {
  if (m?.type === 'assistant') return 'scribe'
  if (wrappedTeammateId(m) === 'implementer') return 'implement'
  const env = scribeEnvelopeOf(m)
  if (env?.kind === 'note') return 'operator'
  if (env && (env.from === 'implementer' || env.kind === 'escalate' || env.kind === 'progress')) {
    return 'implement'
  }
  if (!messageText(m) && hasToolActivity(m)) return 'scribe'
  return 'operator'
}

export function messageInTab(
  tab: ScribeChatTab,
  author: ScribeAuthor,
  hasTool: boolean,
): boolean {
  switch (tab) {
    case 'general':
      return true
    case 'scribe':
      return author === 'operator' || author === 'scribe'
    case 'implement':
      return author === 'implement'
    case 'trace':
      return hasTool
  }
}

export function countForTab(messages: readonly unknown[], tab: ScribeChatTab): number {
  let n = 0
  for (const raw of messages) {
    const m = raw as LooseMsg
    if (isChatNoise(m)) continue
    const hasTool = hasToolActivity(m)
    if (!messageInTab(tab, classifyAuthor(m), hasTool)) continue
    if (!messageText(m) && !hasTool) continue
    n++
  }
  return n
}

export type ScribeChatRow = { author: ScribeAuthor; text: string; hasTool: boolean }

export function rowsForTab(
  messages: readonly unknown[],
  tab: ScribeChatTab,
  limit: number,
): ScribeChatRow[] {
  const rows: ScribeChatRow[] = []
  for (let i = messages.length - 1; i >= 0 && rows.length < limit; i--) {
    const m = messages[i] as LooseMsg
    if (isChatNoise(m)) continue
    const author = classifyAuthor(m)
    const hasTool = hasToolActivity(m)
    if (!messageInTab(tab, author, hasTool)) continue
    const text = rowDisplayText(m)
    if (!text && !hasTool) continue
    rows.push({ author, text, hasTool })
  }
  return rows.reverse()
}

export function rowDisplayText(m: LooseMsg): string {
  const env = scribeEnvelopeOf(m)
  if (env) return envelopeProse(env)
  const raw = messageText(m)
  const wrap = raw.match(TEAMMATE_WRAP)
  return wrap ? wrap[2]!.trim() : raw
}

export function envelopeProse(env: ScribeEnvelope): string {
  if (env.kind === 'dispatch') return env.title ? `${env.title}: ${env.task}` : env.task
  if (env.kind === 'progress') return `${env.status}${env.detail ? `: ${env.detail}` : ''}`
  if (env.kind === 'escalate') return `${GLYPH.fail} ${env.reason}`
  if (env.kind === 'control') return `[${env.command}]${env.detail ? ` ${env.detail}` : ''}`
  if (env.kind === 'note') return env.text
  return ''
}

export function prettyEnvelope(rawEnvelopeText: string): string | null {
  const env = parseScribeEnvelope(rawEnvelopeText)
  return env ? envelopeProse(env) : null
}

export function chatLineAuthorFor(teammateId: string, rawEnvelopeText: string): ScribeAuthor {
  if (parseScribeEnvelope(rawEnvelopeText)?.kind === 'note') return 'operator'
  if (teammateId === 'implementer') return 'implement'
  if (teammateId === 'scribe' || teammateId === 'team-lead') return 'scribe'
  return 'operator'
}

const COMMAND_XML = /^<(local-command|command-name|command-message|command-args|command-stdout)/

export function scribeReasoningFeed(messages: readonly unknown[], limit: number): string[] {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i] as LooseMsg
    if (isChatNoise(m)) continue
    if (classifyAuthor(m) !== 'scribe') continue
    if (scribeEnvelopeOf(m)) continue
    const text = rowDisplayText(m).replace(/\s+/g, ' ').trim()
    if (!text || COMMAND_XML.test(text)) continue
    out.push(text)
  }
  return out.reverse()
}


export type ScribeLedgerStatus =
  | 'dispatched'
  | 'started'
  | 'working'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'escalated'
  | 'superseded'

export type ScribeLedgerEntry = {
  requestId: string
  title: string
  status: ScribeLedgerStatus
  detail?: string
  dispatchedTs?: number
  lastUpdateTs?: number
}

export const SCRIBE_UNACKED_AMBER_MS = 90_000

export function isDispatchUnacked(e: ScribeLedgerEntry, nowMs: number): boolean {
  return (
    e.status === 'dispatched' &&
    e.dispatchedTs !== undefined &&
    nowMs - e.dispatchedTs > SCRIBE_UNACKED_AMBER_MS
  )
}

export function buildScribeLedger(messages: readonly unknown[]): ScribeLedgerEntry[] {
  const order: string[] = []
  const byId = new Map<string, ScribeLedgerEntry>()
  for (const raw of messages) {
    const env = scribeEnvelopeOf(raw as LooseMsg)
    if (!env) continue
    if (env.kind === 'dispatch') {
      if (env.refRequestId) {
        const prev = byId.get(env.refRequestId)
        if (prev && prev.status !== 'done' && prev.status !== 'failed') prev.status = 'superseded'
      }
      if (!byId.has(env.request_id)) {
        order.push(env.request_id)
        const ts = Date.parse(env.timestamp)
        byId.set(env.request_id, {
          requestId: env.request_id,
          title: env.title || env.task,
          status: 'dispatched',
          ...(Number.isFinite(ts) ? { dispatchedTs: ts } : {}),
        })
      }
    } else if (env.kind === 'progress' && env.refRequestId) {
      const e = byId.get(env.refRequestId)
      if (e) {
        e.status = env.status
        if (env.detail) e.detail = env.detail
        const ts = Date.parse(env.timestamp)
        if (Number.isFinite(ts)) e.lastUpdateTs = ts
      }
    } else if (env.kind === 'escalate' && env.refRequestId) {
      const e = byId.get(env.refRequestId)
      if (e) {
        e.status = 'escalated'
        e.detail = env.reason
        const ts = Date.parse(env.timestamp)
        if (Number.isFinite(ts)) e.lastUpdateTs = ts
      }
    }
  }
  return order.map(id => byId.get(id)!)
}

export type ScribeDispatchCounts = { total: number; open: number; working: number; done: number }
export function countOpenDispatches(messages: readonly unknown[]): ScribeDispatchCounts {
  const ledger = buildScribeLedger(messages)
  let open = 0
  let working = 0
  let done = 0
  for (const e of ledger) {
    if (e.status === 'done') done++
    else if (e.status === 'failed' || e.status === 'superseded') continue
    else {
      open++
      if (e.status === 'started' || e.status === 'working') working++
    }
  }
  return { total: ledger.length, open, working, done }
}


export type ScribeBatch = { category: string; items: string[] }

function queuedText(q: { value: unknown }): string {
  const v = q.value
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map(b =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join(' ')
      .trim()
  }
  return ''
}

export function categorizeQueued(text: string): string {
  const t = text.trim().toLowerCase()
  const RULES: Array<[RegExp, string]> = [
    [/\b(fix|bug|repair|patch|broken|fails?|errors?)\b/, 'fix'],
    [/\b(add|implement|build|create|feat|feature|wire|support)\b/, 'feature'],
    [/\b(refactor|clean|rename|moves?|extract|simplify|tidy)\b/, 'refactor'],
    [/\b(tests?|testing|verify|prove|checks?|assert|cover)\b/, 'test'],
    [/\b(docs?|document|readme|comment|explain)\b/, 'docs'],
    [/\b(remove|delete|drop|prune|deprecate)\b/, 'cleanup'],
  ]
  for (const [re, cat] of RULES) if (re.test(t)) return cat
  return 'task'
}

export function buildScribeBatchLedger(queued: readonly { value: unknown }[]): ScribeBatch[] {
  const order: string[] = []
  const groups = new Map<string, string[]>()
  for (const q of queued) {
    const text = queuedText(q).trim()
    if (!text || text.startsWith('/')) continue
    const cat = categorizeQueued(text)
    if (!groups.has(cat)) {
      order.push(cat)
      groups.set(cat, [])
    }
    groups.get(cat)!.push(text)
  }
  return order.map(cat => ({ category: cat, items: groups.get(cat)! }))
}

export function stuckDispatchIds(
  entries: readonly ScribeLedgerEntry[],
  daemon: { delivering: boolean; degraded: boolean },
): Set<string> {
  const stuck = new Set<string>()
  if (daemon.delivering && !daemon.degraded) return stuck
  const TERMINAL: ReadonlySet<ScribeLedgerStatus> = new Set(['done', 'failed'])
  for (const e of entries) if (!TERMINAL.has(e.status)) stuck.add(e.requestId)
  return stuck
}

export type ScribeAttention = {
  kind: 'escalate' | 'blocked' | 'failed' | 'done' | 'none'
  detail?: string
  needsOperator?: boolean
}

export function computeScribeAttention(messages: readonly unknown[], k = 8): ScribeAttention {
  let found: ScribeAttention = { kind: 'none' }
  for (const raw of messages.slice(-k)) {
    const env = scribeEnvelopeOf(raw as LooseMsg)
    if (!env) continue
    if (env.kind === 'escalate') {
      found = { kind: 'escalate', detail: env.reason, needsOperator: env.needsOperator }
    } else if (
      env.kind === 'progress' &&
      (env.status === 'blocked' || env.status === 'failed' || env.status === 'done')
    ) {
      found = { kind: env.status, detail: env.detail }
    }
  }
  return found
}

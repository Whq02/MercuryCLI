
import {
  BASH_INPUT_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  TEAMMATE_MESSAGE_TAG,
} from '../../constants/xml.js'
import type { Message, UserMessage } from '../../types/message.js'
import { stripDisplayTagsAllowEmpty } from '../../utils/displayTags.js'
import { selectableUserMessagesFilter } from '../MessageSelector.js'

export type PromptMode = 'plain' | 'bash' | 'slash'

export type PromptRow = {
  kind: 'prompt'
  key: string
  n: number
  at: string
  mode: PromptMode
  firstLine: string
  text: string
  lines: number
  chars: number
  queued?: true
}

export type CrewDirection = 'to' | 'from'

export type CrewRow = {
  kind: 'crew'
  key: string
  at: string
  agent: string
  dir: CrewDirection
  via: 'launch' | 'message' | 'reply'
  firstLine: string
  text: string
  summary?: string
}

export type CrewThreadRow = {
  kind: 'crew-thread'
  key: string
  agent: string
  count: number
  lastAt: string
}

export type CrewTrafficRow = CrewThreadRow | CrewRow

export type RecordLimits = {
  since: string | null
  compacted: boolean
  resumed: boolean
}


function textOf(content: UserMessage['message']['content']): string {
  if (typeof content === 'string') return content
  let out = ''
  for (const block of content) {
    if (block.type === 'text') out = out ? `${out}\n${block.text}` : block.text
  }
  return out
}

export function firstLineOf(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

function lineCount(text: string): number {
  const t = text.trim()
  return t === '' ? 0 : t.split('\n').length
}

export function classifyPrompt(raw: string): { mode: PromptMode; text: string } {
  const trimmed = raw.trim()
  const bash = trimmed.match(new RegExp(`^<${BASH_INPUT_TAG}>([\\s\\S]*?)</${BASH_INPUT_TAG}>$`))
  if (bash) return { mode: 'bash', text: `! ${bash[1]!.trim()}` }
  const slashShaped = new RegExp(`^<(${COMMAND_NAME_TAG}|${COMMAND_MESSAGE_TAG})>`).test(trimmed)
  const name = slashShaped ? trimmed.match(new RegExp(`<${COMMAND_NAME_TAG}>([\\s\\S]*?)</${COMMAND_NAME_TAG}>`)) : null
  if (name) {
    const args = trimmed.match(new RegExp(`<${COMMAND_ARGS_TAG}>([\\s\\S]*?)</${COMMAND_ARGS_TAG}>`))
    let n = name[1]!.trim()
    const a = args?.[1]?.trim() ?? ''
    const skill = n.match(/^\/?skill:(.+)$/)
    if (skill) n = `/${skill[1]}`
    else if (!n.startsWith('/')) n = `/${n}`
    return { mode: 'slash', text: a ? `${n} ${a}` : n }
  }
  const text = stripDisplayTagsAllowEmpty(trimmed)
  return { mode: 'plain', text }
}


function drainedPromptTextOf(m: Message): string | null {
  if (m.type !== 'attachment') return null
  const att = m.attachment as { type?: string; prompt?: unknown; commandMode?: string; origin?: unknown; isMeta?: boolean }
  if (att.type !== 'queued_command') return null
  if (att.isMeta === true || att.origin !== undefined) return null
  if (att.commandMode !== undefined && att.commandMode !== 'prompt') return null
  const prompt = att.prompt
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return null
  return prompt
    .map(block => ((block as { type?: string; text?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : ''))
    .filter(part => part !== '')
    .join('\n')
}

export function promptRows(records: readonly Message[]): PromptRow[] {
  const rows: PromptRow[] = []
  for (const m of records) {
    const drained = drainedPromptTextOf(m)
    if (drained === null && !selectableUserMessagesFilter(m)) continue
    const { mode, text } = classifyPrompt(drained ?? textOf((m as { message: { content: unknown } }).message.content as never))
    const body = text === '' ? '(no prompt text)' : text
    rows.push({
      kind: 'prompt',
      key: `prompt:${m.uuid}`,
      n: rows.length + 1,
      at: m.timestamp,
      mode,
      firstLine: firstLineOf(body),
      text: body,
      lines: Math.max(1, lineCount(body)),
      chars: body.length,
      ...((m as { queued?: true }).queued === true ? { queued: true as const } : {}),
    })
  }
  return rows
}


const TEAMMATE_OPEN = new RegExp(`<${TEAMMATE_MESSAGE_TAG}\\b([^>]*)>([\\s\\S]*?)</${TEAMMATE_MESSAGE_TAG}>`, 'g')

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? unescapeAttr(m[1]!) : undefined
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function sendMessageWords(input: Record<string, unknown>): string {
  const msg = input.message
  if (typeof msg === 'string') return msg
  if (msg && typeof msg === 'object') {
    const o = msg as Record<string, unknown>
    const parts: string[] = []
    if (typeof o.type === 'string') parts.push(`[${o.type}]`)
    for (const k of ['content', 'summary', 'reason', 'feedback', 'status']) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) parts.push(o[k] as string)
    }
    return parts.join(' ')
  }
  return ''
}

export function crewTrafficMessages(records: readonly Message[]): CrewRow[] {
  const rows: CrewRow[] = []
  for (const m of records) {
    if (m.type === 'assistant') {
      const content = m.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        const input = (block.input ?? {}) as Record<string, unknown>
        if (block.name === 'SendMessage' && typeof input.to === 'string' && input.to.trim()) {
          const text = sendMessageWords(input)
          const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim() : undefined
          rows.push({
            kind: 'crew',
            key: `crew:${block.id}`,
            at: m.timestamp,
            agent: input.to.trim(),
            dir: 'to',
            via: 'message',
            firstLine: firstLineOf(text) || summary || '(no text)',
            text,
            ...(summary ? { summary } : {}),
          })
        } else if (block.name === 'Agent' && typeof input.prompt === 'string') {
          const agent =
            typeof input.name === 'string' && input.name.trim()
              ? input.name.trim()
              : typeof input.description === 'string' && input.description.trim()
                ? input.description.trim()
                : 'agent'
          rows.push({
            kind: 'crew',
            key: `crew:${block.id}`,
            at: m.timestamp,
            agent,
            dir: 'to',
            via: 'launch',
            firstLine: firstLineOf(input.prompt) || '(empty brief)',
            text: input.prompt,
            ...(typeof input.description === 'string' && input.description.trim()
              ? { summary: input.description.trim() }
              : {}),
          })
        }
      }
      continue
    }
    if (m.type === 'user') {
      if (m.isMeta) continue
      const text = textOf(m.message.content)
      if (!text.includes(`<${TEAMMATE_MESSAGE_TAG}`)) continue
      TEAMMATE_OPEN.lastIndex = 0
      let match: RegExpExecArray | null
      let i = 0
      while ((match = TEAMMATE_OPEN.exec(text)) !== null) {
        const attrs = match[1] ?? ''
        const body = unescapeAttr((match[2] ?? '').trim())
        const agent = attr(attrs, 'teammate_id') ?? 'agent'
        const summary = attr(attrs, 'summary')
        rows.push({
          kind: 'crew',
          key: `crew:${m.uuid}:${i++}`,
          at: m.timestamp,
          agent,
          dir: 'from',
          via: 'reply',
          firstLine: firstLineOf(body) || summary || '(no text)',
          text: body,
          ...(summary ? { summary } : {}),
        })
      }
    }
  }
  return rows
}

export function crewTrafficRows(records: readonly Message[]): CrewTrafficRow[] {
  const messages = crewTrafficMessages(records)
  const threads = new Map<string, CrewRow[]>()
  for (const r of messages) {
    const list = threads.get(r.agent)
    if (list) list.push(r)
    else threads.set(r.agent, [r])
  }
  const out: CrewTrafficRow[] = []
  for (const [agent, list] of threads) {
    out.push({
      kind: 'crew-thread',
      key: `crew-thread:${agent}`,
      agent,
      count: list.length,
      lastAt: list[list.length - 1]!.at,
    })
    out.push(...list)
  }
  return out
}


export function recordLimits(records: readonly Message[], processStartedAt?: string): RecordLimits {
  let since: string | null = null
  let compacted = false
  for (const m of records) {
    const ts = (m as { timestamp?: unknown }).timestamp
    if (typeof ts === 'string' && ts && (since === null || ts < since)) since = ts
    if (m.type === 'user' && m.isCompactSummary) compacted = true
    if (m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary') compacted = true
  }
  const resumed = since !== null && processStartedAt !== undefined && since < processStartedAt
  return { since, compacted, resumed }
}

export function limitsLine(limits: RecordLimits, promptCount: number, clock: (iso: string) => string, queuedCount = 0): string {
  const head = promptCount === 1 ? '1 prompt' : `${promptCount} prompts`
  const queued = queuedCount > 0 ? ` · ${queuedCount} queued` : ''
  if (limits.since === null) return `${head} · nothing sent in this chat yet${queued}`
  const parts = [`${head} since ${clock(limits.since)}`]
  parts.push(limits.resumed ? 'resumed transcript included' : 'from the start of this session')
  if (limits.compacted) parts.push('a compaction hides the earlier prompts')
  return parts.join(' · ') + queued
}

export function clockOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function clockSecondsOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return `${clockOf(iso)}:${String(d.getSeconds()).padStart(2, '0')}`
}

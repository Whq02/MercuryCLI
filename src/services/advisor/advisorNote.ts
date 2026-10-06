import type { Message, UserMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isAdvisorOrigin, type AdvisorOrigin } from '../../utils/messages/noticeRows.js'
import { isCommandEcho } from '../../utils/messages/operatorTurns.js'
import { callAdvisorOnceMore, liveAdvisorCall, type AdvisorCall } from './advisorCall.js'
import type { AdvisorQuiet } from './advisorQuiet.js'
import {
  advisorClockStart,
  advisorDefaultClock,
  appendAdvisorRow,
  loadAdvisorContext,
  maybeCompactAdvisorContext,
  type AdvisorContext,
  type AdvisorRow,
  type AdvisorSummarizer,
} from './advisorContext.js'
import {
  ADVISOR_MINUTES_FLOOR,
  advisorDispatchEffort,
  advisorSeatRefusal,
  readAdvisorSettings,
  resolveAdvisorModel,
  type AdvisorSeat,
  type AdvisorSettings,
} from './advisorSettings.js'

export const ADVISOR_NOTE_MAX_LINES = 8
export const DIGEST_ROW_CLIP = 600
export const DIGEST_RESULT_CLIP = 400
export const DIGEST_MAX_CHARS = 60_000
export const ADVISOR_MEMORY_NOTES = 12

export const ADVISOR_SYSTEM_PROMPT = [
  'You are the Advisor: a second model that reads a working agent\'s conversation on a cadence and writes the agent one short note. The agent is an AI coding assistant working for an operator inside the Mercury harness. You are not the operator and you never address the operator; you speak to the agent alone, in the second person.',
  '',
  'You are shown the new rows of the agent\'s conversation since your last note (the operator\'s lines, the agent\'s replies, its tool calls with their results clipped) and your own earlier notes. You have no tools and cannot act; the agent can.',
  '',
  `Write ONE note to the agent of at most ${ADVISOR_NOTE_MAX_LINES} lines: what it may be missing, a course correction, or what it should verify before going on. Prefer the one thing that matters most. Be concrete — name the file, the command, the assumption. If the agent is on course and nothing needs saying, answer with the single line "carry on" and nothing else.`,
  '',
  'Never restate the conversation, never praise, never give the agent a new task the operator did not ask for, and never speak as the operator. Plain text only: no headings, no code fences unless quoting a command.',
].join('\n')

export const ADVISOR_CARRY_ON = 'carry on'

const textOfBlocks = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => ((block as { type?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : ''))
    .join('\n')
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function digestLinesOf(message: Message): string[] {
  if (message.type === 'assistant') {
    const lines: string[] = []
    const content = message.message.content
    if (!Array.isArray(content)) return lines
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        lines.push(`[agent] ${clip(block.text, DIGEST_ROW_CLIP)}`)
      } else if (block.type === 'tool_use') {
        lines.push(`[tool] ${String(block.name ?? 'tool')} ${clip(JSON.stringify(block.input ?? {}), DIGEST_RESULT_CLIP)}`)
      }
    }
    return lines
  }
  if (message.type !== 'user') return []
  const user = message as UserMessage
  const origin = user.origin
  if (isAdvisorOrigin(origin)) return []
  const content = user.message.content
  if (typeof content === 'string') {
    if (user.isMeta || isCommandEcho(content)) return []
    return content.trim() === '' ? [] : [`[operator] ${clip(content, DIGEST_ROW_CLIP)}`]
  }
  const lines: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'tool_result') {
      const raw = block.content
      const text = typeof raw === 'string' ? raw : textOfBlocks(raw)
      lines.push(`[result${block.is_error === true ? ' error' : ''}] ${clip(text, DIGEST_RESULT_CLIP)}`)
    } else if (block.type === 'text' && typeof block.text === 'string' && !user.isMeta && block.text.trim() !== '' && !isCommandEcho(block.text)) {
      lines.push(`[operator] ${clip(block.text, DIGEST_ROW_CLIP)}`)
    }
  }
  return lines
}

export interface AgentDigest {
  text: string
  cursor: string | undefined
  count: number
}

export function renderAgentDigest(messages: readonly Message[], sinceUuid: string | undefined): AgentDigest {
  let start = 0
  if (sinceUuid !== undefined) {
    const at = messages.findIndex(message => (message as { uuid?: string }).uuid === sinceUuid)
    if (at >= 0) start = at + 1
  }
  const lines: string[] = []
  let cursor = sinceUuid
  let count = 0
  for (const message of messages.slice(start)) {
    const rowLines = digestLinesOf(message)
    const uuid = (message as { uuid?: string }).uuid
    if (uuid !== undefined) cursor = uuid
    if (rowLines.length === 0) continue
    count += 1
    lines.push(...rowLines)
  }
  let text = lines.join('\n')
  if (text.length > DIGEST_MAX_CHARS) text = `[…older lines elided…]\n${text.slice(text.length - DIGEST_MAX_CHARS)}`
  return { text, cursor, count }
}

export function renderAdvisorMemory(rows: readonly AdvisorRow[]): string {
  const kept = rows.filter(row => row.kind !== 'digest')
  const recent = kept.slice(-ADVISOR_MEMORY_NOTES)
  if (recent.length === 0) return '(no earlier notes — this is your first look at this conversation)'
  return recent
    .map(row => {
      switch (row.kind) {
        case 'summary':
          return `[your earlier memory, summarized] ${row.text}`
        case 'note':
          return `[your note, ${row.at}] ${row.text}`
        case 'question':
          return `[the agent asked, ${row.at}] ${row.text}`
        case 'reply':
          return `[your reply, ${row.at}] ${row.text}`
        default:
          return ''
      }
    })
    .filter(line => line !== '')
    .join('\n')
}

export function composeNotePrompt(memory: string, digest: string): string {
  return [
    '<your_earlier_notes>',
    memory,
    '</your_earlier_notes>',
    '',
    '<new_rows_of_the_agents_conversation>',
    digest,
    '</new_rows_of_the_agents_conversation>',
    '',
    `Write your one note to the agent now (at most ${ADVISOR_NOTE_MAX_LINES} lines), or the single line "${ADVISOR_CARRY_ON}".`,
  ].join('\n')
}

export function clampNoteLines(text: string): string {
  const lines = text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
  return lines.slice(0, ADVISOR_NOTE_MAX_LINES).join('\n')
}

export function advisorNoteDue(context: Pick<AdvisorContext, 'rows' | 'openedAt' | 'lookedAt'>, minutes: number, now: number): boolean {
  const interval = Math.max(ADVISOR_MINUTES_FLOOR, Math.floor(minutes)) * 60_000
  return now - advisorClockStart(context) >= interval
}

export interface AdvisorNote {
  text: string
  origin: AdvisorOrigin
}

export interface AdvisorRoad {
  seat?: AdvisorSeat
  chat?: boolean
  call?: AdvisorCall
  summarize?: AdvisorSummarizer
  settings?: AdvisorSettings
  model?: string
  window?: number
  dir?: string
  persist?: boolean
  signal?: AbortSignal
  onQuiet?: (quiet: AdvisorQuiet) => void
  now?: () => number
}

export function advisorClock(road: Pick<AdvisorRoad, 'now'>): () => number {
  return road.now ?? advisorDefaultClock()
}

export function advisorContextOptions(road: Pick<AdvisorRoad, 'dir' | 'persist' | 'now'>): { dir?: string; persist?: boolean; now: () => number } {
  return {
    ...(road.dir !== undefined ? { dir: road.dir } : {}),
    ...(road.persist !== undefined ? { persist: road.persist } : {}),
    now: advisorClock(road),
  }
}

export async function composeAdvisorNote(
  context: AdvisorContext,
  messages: readonly Message[],
  road: AdvisorRoad = {},
): Promise<AdvisorNote | null> {
  const settings = road.settings ?? readAdvisorSettings()
  if (advisorSeatRefusal(road.seat ?? 'main', settings, road.chat) !== undefined) return null
  const now = advisorClock(road)
  let model = road.model
  if (model === undefined) {
    const resolved = resolveAdvisorModel()
    if (resolved.origin === 'unset') {
      logForDebugging(`advisor: no advisor model pinned — ${resolved.hint}; no note for ${context.agentId}`)
      return null
    }
    model = resolved.model
  }
  const digest = renderAgentDigest(messages, context.cursor)
  if (digest.count === 0) {
    logForDebugging(`advisor: nothing new for ${context.agentId} since the last note`)
    return null
  }
  context.lookedAt = now()
  const reply = await callAdvisorOnceMore(road.call ?? liveAdvisorCall, {
    model,
    system: ADVISOR_SYSTEM_PROMPT,
    prompt: composeNotePrompt(renderAdvisorMemory(context.rows), digest.text),
    ...(road.model === undefined ? { effort: advisorDispatchEffort(model) } : {}),
    ...(road.signal !== undefined ? { signal: road.signal } : {}),
  })
  if (!reply.ok) {
    road.onQuiet?.({ origin: { kind: 'advisor', model, minutes: settings.minutes, at: new Date(now()).toISOString() }, reason: reply.reason, empty: reply.empty === true })
    return null
  }
  const at = new Date(now()).toISOString()
  await appendAdvisorRow(context, { kind: 'digest', at, text: digest.text, cursor: digest.cursor })
  const text = clampNoteLines(reply.text)
  await appendAdvisorRow(context, { kind: 'note', at, text, model })
  await maybeCompactAdvisorContext(context, {
    model,
    ...(road.window !== undefined ? { window: road.window } : {}),
    ...(road.summarize !== undefined ? { summarize: road.summarize } : {}),
  })
  if (text.trim().toLowerCase() === ADVISOR_CARRY_ON) return null
  return { text, origin: { kind: 'advisor', model, minutes: settings.minutes, at } }
}

export async function advisorTurnSettled(
  agentId: string,
  messages: readonly Message[],
  road: AdvisorRoad = {},
): Promise<AdvisorNote | null> {
  const settings = road.settings ?? readAdvisorSettings()
  if (advisorSeatRefusal(road.seat ?? 'main', settings, road.chat) !== undefined) return null
  const context = await loadAdvisorContext(agentId, advisorContextOptions(road))
  if (!advisorNoteDue(context, settings.minutes, advisorClock(road)())) return null
  return composeAdvisorNote(context, messages, { ...road, settings })
}

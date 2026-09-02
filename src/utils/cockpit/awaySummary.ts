import type { Message } from '../../types/message.js'
import { isMercurySubstrateProfileOn } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isOperatorTurn } from '../messages/operatorTurns.js'


export function isAwaySummaryEnabled(): boolean {
  
  const flag = flagEnv('MERCURY_AWAY_SUMMARY')
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  if (isEnvTruthy(flag)) return true
  return isMercurySubstrateProfileOn()
}

const COUNTED_TOOLS = new Set<string>([
  'Edit',
  'Write',
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
  'ProviderSearch',
])

export function humanGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string }

function isSyntheticResumeAssistant(m: Message): boolean {
  if (m.type !== 'assistant') return false
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content === 'No response requested.'
  if (Array.isArray(content) && content.length === 1) {
    const b = content[0] as Block
    return b?.type === 'text' && b.text === 'No response requested.'
  }
  return false
}

function isSyntheticOrMeta(m: Message): boolean {
  if (isSyntheticResumeAssistant(m)) return true
  const um = m as { isMeta?: boolean }
  return um.isMeta === true
}

function fileOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

export type AwayRecap = {
  line: string
  endedOnError: boolean
  turns: number
  filesTouched: number
  topTools: string
  toolFailures: number
  lastActiveGapMs?: number
  gitDelta?: { files: number; added: number; removed: number } | null
}

export function buildAwayRecap(
  messages: Message[],
  nowMs: number,
  gitDelta?: { files: number; added: number; removed: number } | null,
): AwayRecap | null {
  if (!Array.isArray(messages) || messages.length === 0) return null

  let turns = 0
  const toolCounts = new Map<string, number>()
  const files = new Set<string>()
  let lastTs = 0
  let lastAssistant: Message | null = null

  const failedToolUseIds = new Set<string>()
  let toolFailures = 0
  for (const m of messages) {
    if (m.type !== 'user') continue
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const b = raw as { type?: string; tool_use_id?: string; is_error?: boolean }
      if (b?.type !== 'tool_result' || b.is_error !== true) continue
      toolFailures++
      if (typeof b.tool_use_id === 'string' && b.tool_use_id.length > 0) {
        failedToolUseIds.add(b.tool_use_id)
      }
    }
  }

  for (const m of messages) {
    if (isOperatorTurn(m)) turns++

    if (isSyntheticOrMeta(m)) continue

    const ts = Date.parse((m as { timestamp?: string }).timestamp ?? '')
    if (Number.isFinite(ts) && ts > lastTs) lastTs = ts

    if (m.type === 'assistant') {
      lastAssistant = m
      const content = (m as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const raw of content) {
          const b = raw as Block
          if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
          if (COUNTED_TOOLS.has(b.name)) {
            toolCounts.set(b.name, (toolCounts.get(b.name) ?? 0) + 1)
          }
          const f = fileOf(b.input)
          if (f && !(typeof b.id === 'string' && failedToolUseIds.has(b.id))) files.add(f)
        }
      }
    }
  }

  const totalToolUse = [...toolCounts.values()].reduce((a, b) => a + b, 0)
  if (turns === 0 && totalToolUse === 0) return null

  const parts: string[] = []
  parts.push(`${turns} turn${turns === 1 ? '' : 's'}`)
  if (files.size > 0) parts.push(`${files.size} file${files.size === 1 ? '' : 's'} touched`)
  if (toolFailures > 0) {
    parts.push(`${toolFailures} tool call${toolFailures === 1 ? '' : 's'} failed`)
  }
  const gap = lastTs > 0 ? humanGap(nowMs - lastTs) : ''
  if (gap) parts.push(`last active ${gap}`)

  if (gitDelta && gitDelta.files > 0) {
    const d =
      gitDelta.added > 0 || gitDelta.removed > 0
        ? ` (+${gitDelta.added}/-${gitDelta.removed})`
        : ''
    parts.push(`${gitDelta.files} uncommitted${d}`)
  }

  const le = lastAssistant as { error?: unknown; isApiErrorMessage?: boolean } | null
  const endedOnError = !!le && (le.error != null || le.isApiErrorMessage === true)
  if (endedOnError) {
    parts.unshift('prior run ended on an error')
  }

  const top = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, n]) => `${name}×${n}`)

  let line = `Resumed — ${parts.join(', ')}`
  if (top.length > 0) line += ` · ${top.join(' ')}`
  return {
    line,
    endedOnError,
    turns,
    filesTouched: files.size,
    topTools: top.join(' '),
    toolFailures,
    ...(lastTs > 0 ? { lastActiveGapMs: nowMs - lastTs } : {}),
    gitDelta,
  }
}

export function buildAwaySummary(
  messages: Message[],
  nowMs: number,
  gitDelta?: { files: number; added: number; removed: number } | null,
): string | null {
  return buildAwayRecap(messages, nowMs, gitDelta)?.line ?? null
}

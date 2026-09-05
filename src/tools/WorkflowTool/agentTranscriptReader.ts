
import { existsSync } from 'node:fs'
import { readFile, stat, open } from 'node:fs/promises'
import path from 'node:path'

import { decodeTranscriptBuffer } from '../../fabric/transcriptDecode.js'
import { startsWithApiErrorPrefix } from '../../services/api/errorPrefix.js'
import type { ApiUsage } from '../../types/wire.js'
import { turnCutOfText, turnCutResultText } from '../../utils/messages/turnCut.js'
import { getTokenCountFromUsage } from '../../utils/tokenUsage.js'

export const PROMPT_CAP_CHARS = 8_000
export const ACTIVITY_LAST_N = 40
export const ACTIVITY_INPUT_SUMMARY_CHARS = 120
export const ACTIVITY_RESULT_PREVIEW_CHARS = 200
export const REASONING_LAST_N = 8
export const REASONING_EACH_CAP_CHARS = 2_000
export const OUTCOME_CAP_CHARS = 4_000

export const MAX_FULL_READ_BYTES = 16 * 1024 * 1024
const HEAD_READ_BYTES = 64 * 1024
const TAIL_READ_BYTES = 2 * 1024 * 1024

export type AgentToolCallView = {
  name: string
  inputSummary: string
  resultPreview?: string
  isError?: boolean
  timestamp?: string
}

export type AgentUsageRollup = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextTokens: number
  apiTurns: number
}

export type AgentTranscriptView = {
  prompt?: string
  promptTruncated?: boolean
  toolCalls: AgentToolCallView[]
  toolCallsTotal: number
  reasoning: string[]
  reasoningTotal: number
  unreadableReasoningTotal: number
  finalText?: string
  finalTextTruncated?: boolean
  model?: string
  usage?: AgentUsageRollup
  entryCount: number
  truncatedRead?: boolean
  end: AgentTranscriptEnd
}

export type AgentTranscriptEnd = {
  kind: 'completed' | 'failed' | 'stopped' | 'cut'
  words: string
}
const OPEN_END: AgentTranscriptEnd = { kind: 'cut', words: 'cut off mid-turn' }
const NO_ROWS_END: AgentTranscriptEnd = { kind: 'cut', words: 'no readable rows' }
const COMPLETED_END: AgentTranscriptEnd = { kind: 'completed', words: 'completed' }
const FAILED_END: AgentTranscriptEnd = { kind: 'failed', words: 'failed' }
const STOPPED_END: AgentTranscriptEnd = { kind: 'stopped', words: 'stopped' }

export function transcriptEndWords(end: AgentTranscriptEnd | undefined): string {
  return end === undefined ? 'transcript on disk (unreadable)' : `${end.words} (transcript on disk)`
}

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input !== 'object') return clip(String(input), ACTIVITY_INPUT_SUMMARY_CHARS)
  const obj = input as Record<string, unknown>
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'prompt',
    'description',
    'url',
  ]) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) {
      return clip(v.replace(/\s+/g, ' '), ACTIVITY_INPUT_SUMMARY_CHARS)
    }
  }
  const first = Object.values(obj).find(
    v => typeof v === 'string' && (v as string).length > 0,
  )
  if (typeof first === 'string') {
    return clip(first.replace(/\s+/g, ' '), ACTIVITY_INPUT_SUMMARY_CHARS)
  }
  try {
    return clip(JSON.stringify(obj) ?? '', ACTIVITY_INPUT_SUMMARY_CHARS)
  } catch {
    return '<unserializable input>'
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b =>
        b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join(' ')
  }
  return ''
}

type RawEntry = {
  type?: unknown
  timestamp?: unknown
  isApiErrorMessage?: unknown
  message?: {
    id?: unknown
    role?: unknown
    model?: unknown
    content?: unknown
    usage?: Record<string, unknown>
  }
}

export async function readAgentTranscript(
  file: string,
): Promise<AgentTranscriptView | undefined> {
  let raw: string
  let truncatedRead = false
  try {
    const st = await stat(file)
    if (st.size <= MAX_FULL_READ_BYTES) {
      raw = await readFile(file, 'utf8')
    } else {
      truncatedRead = true
      const fh = await open(file, 'r')
      try {
        const head = Buffer.alloc(HEAD_READ_BYTES)
        const tail = Buffer.alloc(TAIL_READ_BYTES)
        await fh.read(head, 0, HEAD_READ_BYTES, 0)
        await fh.read(tail, 0, TAIL_READ_BYTES, st.size - TAIL_READ_BYTES)
        const headStr = head.toString('utf8')
        const tailStr = tail.toString('utf8')
        raw = `${headStr.slice(0, headStr.lastIndexOf('\n') + 1)}${tailStr.slice(
          tailStr.indexOf('\n') + 1,
        )}`
      } finally {
        await fh.close()
      }
    }
  } catch {
    return undefined
  }

  const entries = decodeTranscriptBuffer<RawEntry>(raw).entries

  let prompt: string | undefined
  let promptTruncated = false
  const toolCallsAll: AgentToolCallView[] = []
  const pendingResults = new Map<string, AgentToolCallView>()
  const reasoningAll: string[] = []
  let unreadableReasoningTotal = 0
  let finalText: string | undefined
  let model: string | undefined
  const usage: AgentUsageRollup = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
    apiTurns: 0,
  }
  const seenUsageIds = new Set<string>()
  let end: AgentTranscriptEnd = OPEN_END

  for (const e of entries) {
    const msg = e.message
    const content = msg?.content
    if (e.type === 'user') {
      end = OPEN_END
      const cutOf = (text: string): void => {
        const cut = turnCutOfText(text)
        if (cut === null) return
        end = cut.kind === 'operator' ? STOPPED_END : { kind: 'cut', words: turnCutResultText(cut).replace(/^Cut off/, 'cut off') }
      }
      if (typeof content === 'string') cutOf(content)
      if (prompt === undefined && typeof content === 'string') {
        promptTruncated = content.length > PROMPT_CAP_CHARS
        prompt = clip(content, PROMPT_CAP_CHARS)
        continue
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          const block = b as Record<string, unknown>
          if (block.type === 'text') cutOf(String(block.text ?? ''))
          if (prompt === undefined && block.type === 'text') {
            const t = String(block.text ?? '')
            promptTruncated = t.length > PROMPT_CAP_CHARS
            prompt = clip(t, PROMPT_CAP_CHARS)
          }
          if (block.type === 'tool_result') {
            const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
            const call = pendingResults.get(id)
            if (call) {
              call.resultPreview = clip(
                toolResultText(block.content).replace(/\s+/g, ' ').trim(),
                ACTIVITY_RESULT_PREVIEW_CHARS,
              )
              call.isError = block.is_error === true
              pendingResults.delete(id)
            }
          }
        }
      }
      continue
    }
    if (e.type !== 'assistant') continue

    if (typeof msg?.model === 'string') model = msg.model
    const mid = typeof msg?.id === 'string' ? msg.id : undefined
    const u = msg?.usage
    if (u && (mid === undefined || !seenUsageIds.has(mid))) {
      if (mid !== undefined) seenUsageIds.add(mid)
      usage.apiTurns += 1
      const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
      usage.inputTokens += n(u.input_tokens)
      usage.outputTokens += n(u.output_tokens)
      usage.cacheReadTokens += n(u.cache_read_input_tokens)
      usage.cacheCreationTokens += n(u.cache_creation_input_tokens)
      usage.contextTokens = getTokenCountFromUsage({
        input_tokens: n(u.input_tokens),
        output_tokens: n(u.output_tokens),
        cache_read_input_tokens: n(u.cache_read_input_tokens),
        cache_creation_input_tokens: n(u.cache_creation_input_tokens),
      } as ApiUsage)
    }
    if (!Array.isArray(content)) continue
    let opensCall = false
    let apiError = e.isApiErrorMessage === true
    let spoke = false
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      if (block.type === 'tool_use') {
        opensCall = true
        const call: AgentToolCallView = {
          name: String(block.name ?? '?'),
          inputSummary: summarizeToolInput(block.input),
          timestamp: typeof e.timestamp === 'string' ? e.timestamp : undefined,
        }
        toolCallsAll.push(call)
        if (typeof block.id === 'string') pendingResults.set(block.id, call)
      } else if (block.type === 'thinking') {
        const t = String(block.thinking ?? '')
        if (t.length > 0) reasoningAll.push(clip(t, REASONING_EACH_CAP_CHARS))
        else unreadableReasoningTotal += 1
      } else if (block.type === 'redacted_thinking') {
        unreadableReasoningTotal += 1
      } else if (block.type === 'text') {
        const t = String(block.text ?? '')
        if (startsWithApiErrorPrefix(t)) apiError = true
        if (t.trim().length > 0) {
          spoke = true
          if (!apiError) finalText = t
        }
      }
    }
    if (apiError) end = FAILED_END
    else if (opensCall) end = OPEN_END
    else if (spoke) end = COMPLETED_END
  }

  return {
    end: entries.length === 0 ? NO_ROWS_END : end,
    prompt,
    promptTruncated: promptTruncated || undefined,
    toolCalls: toolCallsAll.slice(-ACTIVITY_LAST_N),
    toolCallsTotal: toolCallsAll.length,
    reasoning: reasoningAll.slice(-REASONING_LAST_N),
    reasoningTotal: reasoningAll.length,
    unreadableReasoningTotal,
    finalText: finalText === undefined ? undefined : clip(finalText, OUTCOME_CAP_CHARS),
    finalTextTruncated:
      finalText !== undefined && finalText.length > OUTCOME_CAP_CHARS
        ? true
        : undefined,
    model,
    usage: usage.apiTurns > 0 ? usage : undefined,
    entryCount: entries.length,
    truncatedRead: truncatedRead || undefined,
  }
}

export function agentTranscriptFile(
  transcriptDir: string,
  agentId: string,
): string {
  return path.join(transcriptDir, `agent-${agentId}.jsonl`)
}

export function resolveAgentTranscriptFile(
  dirs: readonly (string | undefined)[],
  agentId: string,
): string | undefined {
  let primary: string | undefined
  for (const d of dirs) {
    if (!d) continue
    const p = agentTranscriptFile(d, agentId)
    primary ??= p
    try {
      if (existsSync(p)) return p
    } catch {
    }
  }
  return primary
}

export async function readAgentMeta(
  transcriptDir: string,
  agentId: string,
): Promise<
  { agentType?: string; worktreePath?: string; description?: string } | undefined
> {
  try {
    const raw = await readFile(
      path.join(transcriptDir, `agent-${agentId}.meta.json`),
      'utf8',
    )
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      agentType:
        typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
      worktreePath:
        typeof parsed.worktreePath === 'string' ? parsed.worktreePath : undefined,
      description:
        typeof parsed.description === 'string' ? parsed.description : undefined,
    }
  } catch {
    return undefined
  }
}

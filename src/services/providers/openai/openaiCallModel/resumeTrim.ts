import type {
  Message,
} from '../../../../types/message.js'
import type { ContentBlockParam } from '../../../../types/wire.js'
import type { Options } from '../../anthropic/streamCore.js'
import { isSyntheticApiErrorMessage } from '../../../../utils/messages/factories.js'
import { COMPACTION_SOURCES } from '../../../../constants/querySource.js'
import { projectTimeBasedMicrocompact } from '../../../compact/microCompact.js'
import { digestClearedToolResult, isClearedOrDigested } from '../../../compact/microCompactDigest.js'
import { estimateContentTokens } from '../../../tokenEstimation.js'
import type {
  OpenaiFault,
} from '../openaiWire.js'
import { stripThinkingFromIndex } from '../../../messages/apiFilters.js'
import { isOneOf } from '../../../../utils/isOneOf.js'

export const priorConversation4xx = new Map<string, string>()

export const isCompactionSource = (source: unknown): boolean => isOneOf(COMPACTION_SOURCES, String(source))
export const compactedToolResultsByConversation = new Map<string, Map<string, string>>()

export function applyCompactedToolResults(
  messages: Message[],
  replacements: ReadonlyMap<string, string> | undefined,
): Message[] {
  if (!replacements || replacements.size === 0) return messages
  let firstEdited = -1
  const mapped = messages.map((m, idx) => {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) return m
    let touched = false
    const nextBlocks = m.message.content.map(rawBlock => {
      const block = rawBlock as { type?: string; tool_use_id?: string; content?: unknown }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const replacement = replacements.get(block.tool_use_id)
        if (replacement !== undefined && block.content !== replacement) {
          touched = true
          return { ...block, content: replacement }
        }
      }
      return rawBlock
    })
    if (!touched) return m
    if (firstEdited === -1) firstEdited = idx
    return { ...m, message: { ...(m as { message: object }).message, content: nextBlocks } } as Message
  })
  return firstEdited === -1 ? mapped : stripThinkingFromIndex(mapped, firstEdited)
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++
        continue
      }
      return true
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n')
}

export function priorTurn4xxCodeOf(messages: readonly Message[], conversation4xxKey: string): string | undefined {
  let sawTrailingUser = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'user' || m.type === 'attachment') {
      if (m.type === 'user' && (m as { isMeta?: boolean }).isMeta === true) {
        const c = (m as { message?: { content?: unknown } }).message?.content
        const text = typeof c === 'string' ? c : extractToolResultText(c)
        if (text.includes('refused an image in the last request')) return undefined
      }
      sawTrailingUser = true
      continue
    }
    if (m.type !== 'assistant') continue
    if (
      sawTrailingUser &&
      isSyntheticApiErrorMessage(m) &&
      m.error === 'invalid_request' &&
      !m.mediaRefusal &&
      !m.overflowSignal
    ) {
      return typeof m.errorDetails === 'string' && m.errorDetails !== '' ? m.errorDetails : '4xx'
    }
    break
  }
  return sawTrailingUser ? priorConversation4xx.get(conversation4xxKey) : undefined
}

export function compactTranscriptFor4xxResume(
  messages: Message[],
  querySource: Options['querySource'],
  fault: OpenaiFault,
  conversation4xxKey: string,
): { messages: Message[]; note: string } | null {
  const micro = projectTimeBasedMicrocompact(messages, querySource, { pressure: true })
  const base = micro ? micro.messages : messages
  const clearedIds = new Set<string>(micro?.clearedIds ?? [])
  let tokensSaved = micro?.tokensSaved ?? 0
  let charsSaved = 0
  let surrogatesFixed = 0
  const faultText = fault.wireMessage ?? fault.message
  let storedMap = compactedToolResultsByConversation.get(conversation4xxKey)
  if (!storedMap) {
    storedMap = new Map<string, string>()
    compactedToolResultsByConversation.set(conversation4xxKey, storedMap)
  }
  if (micro) {
    for (const m of base) {
      if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
      for (const rawBlock of m.message.content) {
        const block = rawBlock as { type?: string; tool_use_id?: string; content?: unknown }
        if (
          block.type === 'tool_result' &&
          typeof block.tool_use_id === 'string' &&
          clearedIds.has(block.tool_use_id) &&
          typeof block.content === 'string'
        ) {
          storedMap.set(block.tool_use_id, block.content)
        }
      }
    }
  }

  const candidateToolIds: Array<{ id: string; chars: number; tokens: number; badSurrogate: boolean; named: boolean }> = []
  for (const m of base) {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    for (const block of m.message.content) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      if (clearedIds.has(block.tool_use_id) || isClearedOrDigested(block.content)) continue
      const text = extractToolResultText(block.content)
      if (text.trim() === '') continue
      const badSurrogate = hasUnpairedSurrogate(text)
      const named = faultText.includes(block.tool_use_id)
      const tokens = estimateContentTokens(block.content)
      candidateToolIds.push({ id: block.tool_use_id, chars: text.length, tokens, badSurrogate, named })
    }
  }

  const targetIds = new Set<string>()
  for (const c of candidateToolIds) {
    if (c.badSurrogate || c.named) {
      targetIds.add(c.id)
    }
  }
  if (targetIds.size === 0 && clearedIds.size === 0 && candidateToolIds.length > 0) {
    const oversized = candidateToolIds.filter(c => c.chars >= 4_000 || c.tokens >= 1_000)
    const chosen = oversized.length > 0 ? oversized.at(-1)! : candidateToolIds[0]!
    targetIds.add(chosen.id)
  }

  let firstEdited = micro ? messages.findIndex((m, idx) => m !== base[idx]) : -1
  const rebuilt = base.map((m, idx) => {
    if (m.type !== 'user' && m.type !== 'assistant') return m
    const content = m.message.content
    if (typeof content === 'string') {
      if (!hasUnpairedSurrogate(content)) return m
      surrogatesFixed++
      if (firstEdited === -1 || idx < firstEdited) firstEdited = idx
      return { ...m, message: { ...(m as { message: object }).message, content: content.toWellFormed() } } as Message
    }
    if (!Array.isArray(content)) return m
    let touched = false
    const blocks: readonly ContentBlockParam[] = content
    const nextBlocks = blocks.map(block => {
      if (
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        targetIds.has(block.tool_use_id) &&
        !isClearedOrDigested(block.content)
      ) {
        touched = true
        const beforeText = extractToolResultText(block.content)
        if (hasUnpairedSurrogate(beforeText)) surrogatesFixed++
        const digest = digestClearedToolResult(block.content)
        const savedTok = Math.max(1, estimateContentTokens(block.content) - estimateContentTokens(digest))
        tokensSaved += savedTok
        charsSaved += Math.max(0, beforeText.length - digest.length)
        clearedIds.add(block.tool_use_id)
        storedMap.set(block.tool_use_id, digest)
        return { ...block, content: digest }
      }
      if (block.type === 'text' && typeof block.text === 'string' && hasUnpairedSurrogate(block.text)) {
        touched = true
        surrogatesFixed++
        return { ...block, text: block.text.toWellFormed() }
      }
      return block
    })
    if (!touched) return m
    if (firstEdited === -1 || idx < firstEdited) firstEdited = idx
    return { ...m, message: { ...(m as { message: object }).message, content: nextBlocks } } as Message
  })

  if (clearedIds.size === 0 && surrogatesFixed === 0) return null
  const finalMessages = firstEdited === -1 ? rebuilt : stripThinkingFromIndex(rebuilt, firstEdited)
  const idList = [...clearedIds]
  const idsWords = idList.length <= 3 ? idList.join(', ') : `${idList.slice(0, 3).join(', ')} +${idList.length - 3} more`
  const surrogateWords = surrogatesFixed > 0 ? '; sanitized unpaired UTF-16 surrogate' : ''
  const whatTrimmed =
    idList.length > 0
      ? `compacted ${idList.length} tool result(s) (${idsWords}; ~${Math.max(1, tokensSaved).toLocaleString('en-US')} tokens${charsSaved > 0 ? `, ${charsSaved.toLocaleString('en-US')} chars` : ''}${surrogateWords})`
      : `sanitized ${surrogatesFixed} unpaired UTF-16 surrogate(s) in transcript text`
  const note = `[openai] resumed turn hit ${fault.code} on the replayed transcript — ${whatTrimmed} and retrying once.`
  return { messages: finalMessages, note }
}

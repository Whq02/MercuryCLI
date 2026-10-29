import type { ContentBlock, ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import { MESSAGE_STAMPER } from '../../rows/project.js'
import { clientCallItemsOf, contentItemsOf, resultItemsOf, storedBlocksOf } from '../../rows/content.js'
import { getStrictToolResultPairing } from '../../bootstrap/state.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type {
  AssistantMessage,
  Message,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { logError } from '../log.js'
import { requestConversationPlan } from './apiPlan.js'
import { contentBlocksOf } from './normalize.js'
import { createUserMessage } from './factories.js'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './rejectionText.js'

export function createToolUseSummaryMessage(
  summary: string,
  precedingToolUseIds: string[],
): ToolUseSummaryMessage {
  const stamp = MESSAGE_STAMPER.mint()
  return {
    type: 'tool_use_summary',
    summary,
    precedingToolUseIds,
    uuid: stamp.uuid,
    timestamp: stamp.timestamp,
  }
}

function resultsAnsweredOnce(
  content: readonly (ContentBlockParam | ContentBlock)[],
  called: ReadonlySet<string>,
): (ContentBlockParam | ContentBlock)[] {
  const delivered = new Set<string>()
  return content.filter(block => {
    if (typeof block !== 'object' || !('type' in block) || block.type !== 'tool_result') return true
    const id = (block as ToolResultBlockParam).tool_use_id
    if (!called.has(id) || delivered.has(id)) return false
    delivered.add(id)
    return true
  })
}

type PairingRow = UserMessage | AssistantMessage

function detachedUser(row: UserMessage, first: boolean): UserMessage | null {
  const before = row.message.content
  if (!Array.isArray(before)) return row
  const content = before.filter(block => !(typeof block === 'object' && 'type' in block && block.type === 'tool_result'))
  if (content.length === before.length) return row
  if (content.length === 0) {
    if (!first) return null
    content.push({ type: 'text', text: '[Orphaned tool result removed due to conversation resume]' })
  }
  return { ...row, message: { ...row.message, content } }
}

function admitAssistant(row: AssistantMessage, known: Set<string>): {
  row: AssistantMessage; called: Set<string>; repaired: boolean
} {
  const before = contentBlocksOf(row.message.content) as ContentBlock[]
  const serverAnswers = new Set(before.flatMap(block =>
    'tool_use_id' in block && typeof block.tool_use_id === 'string' ? [block.tool_use_id] : []))
  const called = new Set<string>()
  let repaired = false
  const content: ContentBlock[] = []
  for (const item of contentItemsOf(before)) {
    if (item.type === 'tool_call') {
      const client = item.native === 'tool_use'
      if (client ? known.has(item.call_id) : !serverAnswers.has(item.call_id)) {
        repaired = true
        continue
      }
      if (client) {
        known.add(item.call_id)
        called.add(item.call_id)
      }
    }
    content.push(item.value as ContentBlock)
  }
  const changed = content.length !== before.length || before !== row.message.content
  if (!content.length) content.push({ type: 'text', text: '[Tool use interrupted]', citations: [] })
  return { row: changed ? { ...row, message: { ...row.message, content } } : row, called, repaired }
}

function reconcileResults(called: Set<string>, next: PairingRow | undefined): UserMessage | undefined {
  const following = next?.type === 'user' ? next : undefined
  const ids = following && Array.isArray(following.message.content)
    ? resultItemsOf(following.message.content).map(item => item.call_id) : []
  const answered = new Set(ids)
  const clean = ids.length !== answered.size || ids.some(id => !called.has(id))
  const absent = [...called].filter(id => !answered.has(id))
  if (!clean && absent.length === 0) return undefined
  const missing: ToolResultBlockParam[] = absent.map(tool_use_id => ({
    type: 'tool_result', tool_use_id, content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, is_error: true,
  }))
  if (!following) return missing.length ? createUserMessage({ content: missing, isMeta: true }) : undefined
  const body = following.message.content
  const blocks = Array.isArray(body) ? body : [{ type: 'text' as const, text: body }]
  const content = [...missing, ...(clean ? resultsAnsweredOnce(blocks, called) : blocks)]
  return content.length
    ? { ...following, message: { ...following.message, content } }
    : createUserMessage({ content: NO_CONTENT_MESSAGE, isMeta: true })
}

function pairingStructure(row: PairingRow, index: number): string {
  if (row.type === 'assistant') {
    const client: string[] = []
    const server: string[] = []
    for (const item of contentItemsOf(row.message.content)) {
      if (item.type === 'tool_call') (item.native === 'tool_use' ? client : server).push(item.call_id)
    }
    const parts = [`id=${row.message.id}`, `tool_uses=[${client.join(',')}]`]
    if (server.length) parts.push(`server_tool_uses=[${server.join(',')}]`)
    return `[${index}] assistant(${parts.join(', ')})`
  }
  const body = row.message.content
  if (Array.isArray(body)) {
    const ids = body.filter(block => typeof block === 'object' && 'type' in block && block.type === 'tool_result')
      .map(block => (block as ToolResultBlockParam).tool_use_id)
    if (ids.length) return `[${index}] user(tool_results=[${ids.join(',')}])`
  }
  return `[${index}] ${row.type}`
}

export function ensureToolResultPairing(messages: PairingRow[]): PairingRow[] {
  const output: PairingRow[] = []
  const known = new Set<string>()
  let repaired = false
  let cursor = 0
  while (cursor < messages.length) {
    const row = messages[cursor++]!
    if (row.type !== 'assistant') {
      const accepted = row.type === 'user' && output.at(-1)?.type !== 'assistant'
        ? detachedUser(row, output.length === 0) : row
      if (accepted !== row) repaired = true
      if (accepted) output.push(accepted)
      continue
    }
    const accepted = admitAssistant(row, known)
    repaired ||= accepted.repaired
    output.push(accepted.row)
    const answer = reconcileResults(accepted.called, messages[cursor])
    if (!answer) continue
    repaired = true
    output.push(answer)
    if (messages[cursor]?.type === 'user') cursor++
  }
  if (repaired) {
    const structure = messages.map(pairingStructure).join('; ')
    if (getStrictToolResultPairing()) {
      throw new Error(`The tool calls and their results do not pair up and strict pairing is on, so no placeholder is written into the model's context. Message structure: ${structure}`)
    }
    logError(new Error(`Tool results were repaired on the way to the wire (${messages.length} rows in, ${output.length} out). Message structure: ${structure}`))
  }
  return output
}

export function foldSplitTurnsForWire(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const out: (UserMessage | AssistantMessage)[] = []
  const isAllToolResults = (m: UserMessage): boolean =>
    Array.isArray(m.message.content) &&
    m.message.content.length > 0 &&
    m.message.content.every(
      block =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    )
  for (const msg of messages) {
    const prev = out.at(-1)
    if (
      msg.type === 'assistant' &&
      prev?.type === 'assistant' &&
      typeof msg.message.id === 'string' &&
      msg.message.id !== '' &&
      prev.message.id === msg.message.id
    ) {
      out[out.length - 1] = {
        ...prev,

        ...('apexProviderTurn' in msg && msg.apexProviderTurn !== undefined
          ? { apexProviderTurn: msg.apexProviderTurn }
          : {}),
        ...(msg.geminiProviderTurn !== undefined
          ? { geminiProviderTurn: msg.geminiProviderTurn }
          : {}),
        ...(msg.kimiProviderTurn !== undefined ? { kimiProviderTurn: msg.kimiProviderTurn } : {}),
        ...(msg.xaiProviderTurn !== undefined ? { xaiProviderTurn: msg.xaiProviderTurn } : {}),
        ...(msg.openrouterProviderTurn !== undefined
          ? { openrouterProviderTurn: msg.openrouterProviderTurn }
          : {}),
        message: {
          ...prev.message,
          content: [...storedBlocksOf(prev.message.content), ...storedBlocksOf(msg.message.content)] as ContentBlock[],
          stop_reason: msg.message.stop_reason ?? prev.message.stop_reason,
          usage: msg.message.usage ?? prev.message.usage,
        },
      }
      continue
    }
    if (
      msg.type === 'user' &&
      prev?.type === 'user' &&
      isAllToolResults(msg) &&
      isAllToolResults(prev)
    ) {
      out[out.length - 1] = {
        ...prev,
        message: {
          ...prev.message,
          content: [
            ...(prev.message.content as ContentBlockParam[]),
            ...(msg.message.content as ContentBlockParam[]),
          ],
        },
      }
      continue
    }
    out.push(msg)
  }
  return out
}

function repairResultAdjacency(
  rows: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const isToolResultBlock = (b: unknown): b is ToolResultBlockParam =>
    typeof b === 'object' &&
    b !== null &&
    'type' in b &&
    (b as { type: string }).type === 'tool_result'

  const loc = new Map<string, { row: number; block: number }>()
  rows.forEach((m, ri) => {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) return
    m.message.content.forEach((b, bi) => {
      if (isToolResultBlock(b) && !loc.has(b.tool_use_id)) {
        loc.set(b.tool_use_id, { row: ri, block: bi })
      }
    })
  })

  const moved = new Set<string>()
  const prepends = new Map<number, ToolResultBlockParam[]>()
  const inserts = new Map<number, ToolResultBlockParam[]>()
  rows.forEach((m, ri) => {
    if (m.type !== 'assistant') return
    const useIds = clientCallItemsOf(m.message.content).map(item => item.call_id)
    if (useIds.length === 0) return
    const next = rows[ri + 1]
    const nextIsUser = next?.type === 'user' && Array.isArray(next.message.content)
    const inNext = new Set<string>()
    if (nextIsUser) {
      for (const b of next.message.content as ContentBlockParam[]) {
        if (isToolResultBlock(b)) inNext.add(b.tool_use_id)
      }
    }
    for (const id of useIds) {
      if (inNext.has(id)) continue
      const found = loc.get(id)

      if (!found || found.row <= ri + 1) continue
      const key = `${found.row}:${found.block}`
      if (moved.has(key)) continue
      moved.add(key)
      const donor = rows[found.row] as UserMessage
      const block = (donor.message.content as ContentBlockParam[])[
        found.block
      ] as ToolResultBlockParam
      if (nextIsUser) {
        const list = prepends.get(ri + 1) ?? []
        list.push(block)
        prepends.set(ri + 1, list)
      } else {
        const list = inserts.get(ri) ?? []
        list.push(block)
        inserts.set(ri, list)
      }
    }
  })
  if (moved.size === 0) return rows

  const out: (UserMessage | AssistantMessage)[] = []
  rows.forEach((m, ri) => {
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const kept = m.message.content.filter(
        (_, bi) => !moved.has(`${ri}:${bi}`),
      )
      const pre = prepends.get(ri) ?? []
      const content = [...pre, ...kept]
      if (content.length > 0) {
        out.push({ ...m, message: { ...m.message, content } })
      }
      return
    }
    out.push(m)
    if (m.type === 'assistant') {
      const pulled = inserts.get(ri)
      if (pulled && pulled.length > 0) {
        out.push(createUserMessage({ content: pulled, isMeta: true }))
      }
    }
  })
  return out
}

export function healWalkableForWire(
  messages: readonly { type: string }[],
): (UserMessage | AssistantMessage)[] {
  return requestConversationPlan(messages as readonly Message[], [], 'family').messages
}

export function orderToolResultsByUse(
  rows: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const isToolResultBlock = (b: unknown): b is ToolResultBlockParam =>
    typeof b === 'object' &&
    b !== null &&
    'type' in b &&
    (b as { type: string }).type === 'tool_result'
  let changed = false
  const out = rows.map((row, i) => {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) return row
    const prev = rows[i - 1]
    if (!prev || prev.type !== 'assistant') return row
    const useOrder = new Map<string, number>()
    for (const item of clientCallItemsOf(prev.message.content)) useOrder.set(item.call_id, useOrder.size)
    if (useOrder.size === 0) return row
    const content = row.message.content as ContentBlockParam[]
    const results = content
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => isToolResultBlock(b))
    if (results.length === 0) return row
    const sorted = results
      .map(({ b, idx }) => ({
        b,
        idx,
        rank: useOrder.get((b as ToolResultBlockParam).tool_use_id) ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((x, y) => x.rank - y.rank || x.idx - y.idx)
      .map(({ b }) => b)
    const others = content.filter(b => !isToolResultBlock(b))
    const next = [...sorted, ...others]
    if (next.length === content.length && next.every((b, k) => b === content[k])) return row
    changed = true
    return { ...row, message: { ...row.message, content: next } }
  })
  return changed ? out : rows
}

export function isUnsignedThinkingBlock(b: { type?: string }): boolean {
  if (b.type !== 'thinking') return false
  const signature = (b as { signature?: unknown }).signature
  return !(typeof signature === 'string' && signature.length > 0)
}

export function stripUnsignedThinkingBlocks(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  let changed = false
  const result = messages.map(msg => {
    if (msg.type !== 'assistant') return msg
    const content = msg.message.content
    const filtered = content.filter(b => !isUnsignedThinkingBlock(b))

    const labelled = filtered.some(b => b.type === 'text' && 'phase' in b)
    if (filtered.length === content.length && !labelled) return msg
    changed = true
    const projected = labelled
      ? filtered.map(b => {
          if (b.type !== 'text' || !('phase' in b)) return b
          const { phase: _phase, ...unlabelled } = b
          return unlabelled
        })
      : filtered
    if (projected.length === 0) {
      projected.push({
        type: 'text' as const,
        text: '[reasoning from another model provider — not transferable]',
        citations: [],
      })
    }
    return { ...msg, message: { ...msg.message, content: projected } }
  })
  return changed ? result : messages
}

export function pairConversationMessages(
  messages: (UserMessage | AssistantMessage)[],
  geometry: 'canonical' | 'split',
): (UserMessage | AssistantMessage)[] {
  const turns = geometry === 'split' ? repairResultAdjacency(foldSplitTurnsForWire(messages)) : messages
  return orderToolResultsByUse(ensureToolResultPairing(turns))
}

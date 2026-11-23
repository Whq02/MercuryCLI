import type { ContentBlock, ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import { clientCallItemsOf, contentItemOf, contentItemsOf, resultItemsOf, storedBlocksOf } from '../../rows/content.js'
import { getStrictToolResultPairing } from '../../bootstrap/state.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { logError } from '../log.js'
import { contentBlocksOf } from './normalize.js'
import { createUserMessage } from './factories.js'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './rejectionText.js'

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

function strictPairingWords(structure: string): string {
  return `The tool calls and their results do not pair up and strict pairing is on, so no placeholder is written into the model's context. Message structure: ${structure}`
}

function repairedPairingWords(rowsIn: number, rowsOut: number, structure: string): string {
  return `Tool results were repaired on the way to the wire (${rowsIn} rows in, ${rowsOut} out). Message structure: ${structure}`
}

function idPartWords(id: string): string {
  return `id=${id}`
}

function clientPartWords(clientIds: string): string {
  return `tool_uses=[${clientIds}]`
}

function serverPartWords(serverIds: string): string {
  return `server_tool_uses=[${serverIds}]`
}

function assistantRowWords(index: number, parts: string): string {
  return `[${index}] assistant(${parts})`
}

function userResultsRowWords(index: number, resultIds: string): string {
  return `[${index}] user(tool_results=[${resultIds}])`
}

function otherRowWords(index: number, type: string): string {
  return `[${index}] ${type}`
}

function describedRows(rows: readonly PairingRow[]): string {
  return rows
    .map((row, index) => {
      if (row.type === 'assistant') {
        const calls = contentItemsOf(row.message.content).flatMap(item => (item.type === 'tool_call' ? [item] : []))
        const idsOf = (client: boolean): string => calls.flatMap(call => ((call.native === 'tool_use') === client ? [call.call_id] : [])).join(',')
        const serverIds = idsOf(false)
        const parts = [idPartWords(row.message.id), clientPartWords(idsOf(true)), ...(serverIds === '' ? [] : [serverPartWords(serverIds)])]
        return assistantRowWords(index, parts.join(', '))
      }
      const resultIds = row.type === 'user' && Array.isArray(row.message.content) ? resultItemsOf(row.message.content).map(item => item.call_id) : []
      return resultIds.length > 0 ? userResultsRowWords(index, resultIds.join(',')) : otherRowWords(index, row.type)
    })
    .join('; ')
}

function admittedAssistant(row: AssistantMessage, admitted: Set<string>): { row: AssistantMessage; calls: Set<string>; tookOut: boolean } {
  const blocks = contentBlocksOf(row.message.content)
  const calls = new Set<string>()
  const kept = blocks.filter(block => {
    const item = contentItemOf(block)
    if (item.type !== 'tool_call') return true
    if (item.native !== 'tool_use') return blocks.some(other => 'tool_use_id' in other && other.tool_use_id === item.call_id)
    if (admitted.has(item.call_id)) return false
    admitted.add(item.call_id)
    calls.add(item.call_id)
    return true
  })
  const tookOut = kept.length !== blocks.length
  if (kept.length === 0) kept.push({ type: 'text', text: '[Tool use interrupted]', citations: [] })
  if (!tookOut && kept.length === blocks.length && blocks === row.message.content) return { row, calls, tookOut }
  return { row: { ...row, message: { ...row.message, content: kept as ContentBlock[] } }, calls, tookOut }
}

export function ensureToolResultPairing(messages: PairingRow[]): PairingRow[] {
  const out: PairingRow[] = []
  const admitted = new Set<string>()
  let repaired = false
  for (let at = 0; at < messages.length; at++) {
    const row = messages[at]!
    if (row.type !== 'assistant') {
      if (row.type !== 'user' || out.at(-1)?.type === 'assistant') {
        out.push(row)
        continue
      }
      const detached = detachedUser(row, out.length === 0)
      if (detached !== row) repaired = true
      if (detached !== null) out.push(detached)
      continue
    }
    const given = admittedAssistant(row, admitted)
    if (given.tookOut) repaired = true
    out.push(given.row)
    const next = messages[at + 1]
    const reconciled = reconcileResults(given.calls, next)
    if (reconciled === undefined) continue
    repaired = true
    out.push(reconciled)
    if (next?.type === 'user') at++
  }
  if (!repaired) return out
  const structure = describedRows(messages)
  if (getStrictToolResultPairing()) throw new Error(strictPairingWords(structure))
  logError(new Error(repairedPairingWords(messages.length, out.length, structure)))
  return out
}

function sameReply(earlier: AssistantMessage, later: AssistantMessage): boolean {
  const { id } = earlier.message
  return typeof id === 'string' && id !== '' && id === later.message.id
}

function foldedReply(earlier: AssistantMessage, later: AssistantMessage): AssistantMessage {
  return {
    ...earlier,
    ...(later.apexProviderTurn !== undefined ? { apexProviderTurn: later.apexProviderTurn } : {}),
    ...(later.geminiProviderTurn !== undefined ? { geminiProviderTurn: later.geminiProviderTurn } : {}),
    ...(later.kimiProviderTurn !== undefined ? { kimiProviderTurn: later.kimiProviderTurn } : {}),
    ...(later.xaiProviderTurn !== undefined ? { xaiProviderTurn: later.xaiProviderTurn } : {}),
    ...(later.openrouterProviderTurn !== undefined ? { openrouterProviderTurn: later.openrouterProviderTurn } : {}),
    message: {
      ...earlier.message,
      content: [...storedBlocksOf(earlier.message.content), ...storedBlocksOf(later.message.content)] as ContentBlock[],
      stop_reason: later.message.stop_reason ?? earlier.message.stop_reason,
      usage: later.message.usage ?? earlier.message.usage,
    },
  }
}

function resultsAlone(row: UserMessage): ContentBlockParam[] | null {
  const { content } = row.message
  return Array.isArray(content) && content.length > 0 && content.every(block => block.type === 'tool_result') ? content : null
}

export function foldSplitTurnsForWire(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const out: PairingRow[] = []
  for (const row of messages) {
    const last = out.at(-1)
    if (row.type === 'assistant' && last?.type === 'assistant' && sameReply(last, row)) {
      out[out.length - 1] = foldedReply(last, row)
      continue
    }
    if (row.type === 'user' && last?.type === 'user') {
      const earlier = resultsAlone(last)
      const later = resultsAlone(row)
      if (earlier !== null && later !== null) {
        out[out.length - 1] = { ...last, message: { ...last.message, content: [...earlier, ...later] } }
        continue
      }
    }
    out.push(row)
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

export function orderToolResultsByUse(
  rows: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  let changed = false
  const out = rows.map((row, at) => {
    const before = rows[at - 1]
    if (row.type !== 'user' || before?.type !== 'assistant') return row
    const { content } = row.message
    if (!Array.isArray(content)) return row
    const called = clientCallItemsOf(before.message.content).map(item => item.call_id)
    if (called.length === 0) return row
    const results: ToolResultBlockParam[] = []
    const others: ContentBlockParam[] = []
    for (const block of content) {
      if (block.type === 'tool_result') results.push(block)
      else others.push(block)
    }
    if (results.length === 0) return row
    const standing = (block: ToolResultBlockParam): number => {
      const place = called.indexOf(block.tool_use_id)
      return place === -1 ? called.length : place
    }
    const ordered = [...results.sort((a, b) => standing(a) - standing(b)), ...others]
    if (ordered.every((block, place) => block === content[place])) return row
    changed = true
    return { ...row, message: { ...row.message, content: ordered } }
  })
  return changed ? out : rows
}

export function pairConversationMessages(
  messages: (UserMessage | AssistantMessage)[],
  geometry: 'canonical' | 'split',
): (UserMessage | AssistantMessage)[] {
  const rows = geometry === 'split' ? repairResultAdjacency(foldSplitTurnsForWire(messages)) : messages
  return orderToolResultsByUse(ensureToolResultPairing(rows))
}

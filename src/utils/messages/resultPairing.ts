import type { ContentBlock, ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import { clientCallItemsOf, contentItemsOf, resultItemsOf, storedBlocksOf } from '../../rows/content.js'
import { getStrictToolResultPairing } from '../../bootstrap/state.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { logError } from '../log.js'
import { contentBlocksOf } from './normalize.js'
import { createUserMessage } from './factories.js'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './rejectionText.js'
import { notBuilt } from '../../pi/holes.js'

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

export function ensureToolResultPairing(messages: PairingRow[]): PairingRow[] {
  return notBuilt('src/utils/messages/resultPairing.ts:108')
}

export function foldSplitTurnsForWire(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return notBuilt('src/utils/messages/resultPairing.ts:141')
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
  return notBuilt('src/utils/messages/resultPairing.ts:292')
}

export function pairConversationMessages(
  messages: (UserMessage | AssistantMessage)[],
  geometry: 'canonical' | 'split',
): (UserMessage | AssistantMessage)[] {
  return notBuilt('src/utils/messages/resultPairing.ts:330')
}

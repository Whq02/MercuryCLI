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

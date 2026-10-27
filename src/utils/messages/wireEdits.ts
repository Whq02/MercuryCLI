import { isThinkingBlock } from './apiFilters.js'

export interface WireEdit {
  index: number
  key: string
}

export interface SettledWireEdits<M> {
  messages: M[]
  firstEdited: number
}

type Row = { type: string; uuid?: unknown; message?: unknown }

interface AppliedEdit {
  lastAssistantUuid: string | null
}

const appliedByOwner = new Map<string, Map<string, AppliedEdit>>()

export function resetWireEditsForTesting(): void {
  appliedByOwner.clear()
}

function lastAssistantUuidOf(messages: readonly Row[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]!
    if (row.type === 'assistant' && typeof row.uuid === 'string') return row.uuid
  }
  return null
}

export function conversationEditKey(owner: string, messages: readonly Row[]): string {
  for (const row of messages) {
    if ((row.type === 'user' || row.type === 'assistant') && typeof row.uuid === 'string') return `${owner}|${row.uuid}`
  }
  return `${owner}|`
}

function withoutThinking<M extends Row>(row: M): M {
  if (row.type !== 'assistant') return row
  const message = row.message as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return row
  const kept = content.filter(block => !isThinkingBlock(block as Parameters<typeof isThinkingBlock>[0]))
  if (kept.length === content.length) return row
  return { ...row, message: { ...(message as object), content: kept } }
}

export function settleWireEdits<M extends Row>(owner: string | undefined, messages: M[], edits: readonly WireEdit[]): SettledWireEdits<M> {
  if (edits.length === 0) return { messages, firstEdited: -1 }
  if (owner === undefined) return { messages, firstEdited: Math.min(...edits.map(edit => edit.index)) }
  const conversation = conversationEditKey(owner, messages)
  let applied = appliedByOwner.get(conversation)
  if (applied === undefined) {
    applied = new Map()
    appliedByOwner.set(conversation, applied)
  }
  const end = lastAssistantUuidOf(messages)
  let firstEdited = -1
  const dead = new Set<number>()
  for (const edit of edits) {
    const known = applied.get(edit.key)
    const until = known === undefined || known.lastAssistantUuid === null ? null : messages.findIndex(row => row.uuid === known.lastAssistantUuid)
    if (known === undefined || until === -1) {
      applied.set(edit.key, { lastAssistantUuid: end })
      if (firstEdited === -1 || edit.index < firstEdited) firstEdited = edit.index
      continue
    }
    if (until === null) continue
    for (let index = edit.index; index <= until; index++) dead.add(index)
  }
  if (dead.size === 0) return { messages, firstEdited }
  let copy: M[] | undefined
  messages.forEach((row, index) => {
    if (!dead.has(index)) return
    const next = withoutThinking(row)
    if (next === row) return
    copy ??= messages.slice()
    copy[index] = next
  })
  return { messages: copy ?? messages, firstEdited }
}

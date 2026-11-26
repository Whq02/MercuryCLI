import { decodeTranscriptBuffer } from '../fabric/transcriptDecode.js'

const RECORD_LINE_PREFIX = Buffer.from('{"schemaVersion":1,"recordId":"')
const PRUNE_KIND_NEEDLE = Buffer.from('"payload":{"kind":"')
const PRUNE_PARENT_NEEDLE = Buffer.from('"parentId":"')
const PRUNE_MESSAGE_ID_NEEDLE = Buffer.from('"providerMessageId":"')
const PRUNE_KIND_BOUND = 600
const PRUNE_CHAIN_KINDS = new Set(['input', 'output', 'attachment', 'notice', 'boundary', 'progress'])

export type IndexedLine = { from: number; to: number; id: string | null }

export function indexLine(bytes: Buffer, from: number): IndexedLine {
  const end = bytes.length
  let id: string | null = null
  const n = RECORD_LINE_PREFIX.length
  if (end > n + 2 && bytes.subarray(0, n).equals(RECORD_LINE_PREFIX)) {
    const idEnd = bytes.indexOf(34, n)
    const kindAt = bytes.subarray(0, PRUNE_KIND_BOUND + PRUNE_KIND_NEEDLE.length).indexOf(PRUNE_KIND_NEEDLE)
    if (idEnd > n && idEnd - n <= 64 && kindAt >= 0 && kindAt < PRUNE_KIND_BOUND) {
      const start = kindAt + PRUNE_KIND_NEEDLE.length, stop = bytes.indexOf(34, start)
      if (stop > start && PRUNE_CHAIN_KINDS.has(bytes.toString('latin1', start, stop))) id = bytes.toString('latin1', n, idEnd)
    }
  }
  return { from, to: from + end, id }
}

export function selectBranchIds(lines: readonly IndexedLine[], read: (r: IndexedLine) => Buffer): Set<string> | null {
  const QUOTE = 34
  const nodes = lines.filter(r => r.id !== null)
  if (!nodes.length) return null
  const len = lines.reduce((n, r) => n + r.to - r.from, 0)
  const nodeIds = nodes.map(r => r.id!)
  const nodeIdx = nodes.flatMap(r => [r.from, r.to])
  const chainBytes = nodes.reduce((n, r) => n + r.to - r.from, 0)
  if (chainBytes < Math.floor(len / 2)) return null
  const idToSlots = new Map<string, number[]>()
  for (let slot = 0; slot < nodes.length; slot++) {
    const id = nodeIds[slot]!, list = idToSlots.get(id)
    if (list) list.push(slot)
    else idToSlots.set(id, [slot])
  }
  const readSlot = (slot: number): Buffer => read(nodes[slot]!)
  const decodeSlot = (slot: number): Record<string, unknown> | null => {
    const d = decodeTranscriptBuffer<Record<string, unknown>>(
      readSlot(slot),
    )
    return d.entries.length === 1 ? d.entries[0]! : null
  }

  let leaf: Record<string, unknown> | null = null
  for (let slot = nodeIds.length - 1; slot >= 0; slot--) {
    const e = decodeSlot(slot)
    if (e === null || e.isSidechain === true) continue
    leaf = e
    break
  }
  if (leaf === null) return null

  const liveIds = new Set<string>()
  const liveMessageIds = new Set<string>()
  const assistantIds = new Set<string>()
  const keepsAsQuiet = (e: Record<string, unknown>): boolean =>
    e.type === 'attachment' || (e.type === 'system' && e.subtype !== 'compact_boundary' && e.subtype !== 'microcompact_boundary')
  const noteAssistant = (e: Record<string, unknown>, id: string): void => {
    if (e.type !== 'assistant') return
    const message = e.message as { id?: unknown } | undefined
    if (typeof message?.id === 'string' && message.id !== '') liveMessageIds.add(message.id)
    assistantIds.add(id)
  }
  let liveBytes = 0
  let cur: Record<string, unknown> | null = leaf
  const spineEntries: Array<{ id: string; assistant: boolean; quiet: boolean }> = []
  while (cur) {
    const id = typeof cur.uuid === 'string' ? cur.uuid : null
    if (id === null || liveIds.has(id)) break
    liveIds.add(id)
    noteAssistant(cur, id)
    spineEntries.push({ id, assistant: cur.type === 'assistant', quiet: keepsAsQuiet(cur) })
    for (const slot of idToSlots.get(id) ?? []) {
      liveBytes += nodeIdx[slot * 2 + 1]! - nodeIdx[slot * 2]!
    }
    const parent = typeof cur.parentUuid === 'string' && cur.parentUuid ? cur.parentUuid : null
    if (parent === null) break
    const slots = idToSlots.get(parent)
    if (!slots || slots.length === 0) break
    cur = decodeSlot(slots[slots.length - 1]!)
  }
  if (liveIds.size === 0) return null

  const assistantNoteIds = new Set<string>()
  let spineUnderAssistant = false
  for (let i = spineEntries.length - 1; i >= 0; i--) {
    const entry = spineEntries[i]!
    if (entry.assistant) spineUnderAssistant = true
    else if (entry.quiet) {
      if (spineUnderAssistant) assistantNoteIds.add(entry.id)
    } else spineUnderAssistant = false
  }

  const byParent = new Map<string, number[]>()
  const byMessageId = new Map<string, number[]>()
  const indexInto = (index: Map<string, number[]>, line: Buffer, needle: Buffer, cap: number, slot: number): void => {
    let at = line.indexOf(needle)
    while (at !== -1) {
      const from = at + needle.length
      const close = line.indexOf(QUOTE, from)
      if (close > from && close - from <= cap) {
        const key = line.toString('latin1', from, close)
        const slots = index.get(key)
        if (slots) slots.push(slot)
        else index.set(key, [slot])
      }
      at = line.indexOf(needle, from)
    }
  }
  for (let slot = 0; slot < nodeIds.length; slot++) {
    if (liveIds.has(nodeIds[slot]!)) continue
    const line = readSlot(slot)
    indexInto(byParent, line, PRUNE_PARENT_NEEDLE, 64, slot)
    indexInto(byMessageId, line, PRUNE_MESSAGE_ID_NEEDLE, 128, slot)
  }
  const kept = new Set<string>()
  const parentQueue: string[] = [...liveIds]
  const messageIdQueue: string[] = [...liveMessageIds]
  const settledEntryOf = (id: string): Record<string, unknown> | null => {
    const slots = idToSlots.get(id)
    return slots === undefined || slots.length === 0 ? null : decodeSlot(slots[slots.length - 1]!)
  }
  const keepsAsToolResult = (e: Record<string, unknown>, parent: string): boolean => {
    if (e.type !== 'user' || !(assistantIds.has(parent) || assistantNoteIds.has(parent))) return false
    const content = (e.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return false
    return (content as Array<{ type?: unknown }>).some(block => block?.type === 'tool_result')
  }
  const consider = (slot: number, road: 'parent' | 'sibling'): void => {
    const id = nodeIds[slot]!
    if (liveIds.has(id) || kept.has(id)) return
    const e = settledEntryOf(id)
    if (e === null || typeof e.uuid !== 'string' || e.uuid !== id) return
    const parent = typeof e.parentUuid === 'string' && e.parentUuid ? e.parentUuid : null
    const parentStands = parent !== null && (liveIds.has(parent) || kept.has(parent))
    const message = e.message as { id?: unknown } | undefined
    const sibling = road === 'sibling' && e.type === 'assistant' && typeof message?.id === 'string' && liveMessageIds.has(message.id)
    const toolResult = road === 'parent' && parentStands && parent !== null && keepsAsToolResult(e, parent)
    const note = road === 'parent' && parentStands && keepsAsQuiet(e)
    if (!sibling && !toolResult && !note) return
    kept.add(id)
    if (note && parent !== null && (assistantIds.has(parent) || assistantNoteIds.has(parent))) assistantNoteIds.add(id)
    noteAssistant(e, id)
    parentQueue.push(id)
    if (sibling && typeof message?.id === 'string') messageIdQueue.push(message.id)
  }
  while (parentQueue.length > 0 || messageIdQueue.length > 0) {
    const parentId = parentQueue.pop()
    if (parentId !== undefined) for (const slot of byParent.get(parentId) ?? []) consider(slot, 'parent')
    const messageId = messageIdQueue.pop()
    if (messageId !== undefined) for (const slot of byMessageId.get(messageId) ?? []) consider(slot, 'sibling')
  }
  for (const id of kept) {
    for (const slot of idToSlots.get(id) ?? []) {
      liveBytes += nodeIdx[slot * 2 + 1]! - nodeIdx[slot * 2]!
    }
  }

  const deadBytes = chainBytes - liveBytes
  if (deadBytes < Math.floor(len / 2)) return null

  return new Set([...liveIds, ...kept])
}

export function pruneRecordBranchesBeforeParse(buf: Buffer): Buffer {
  const lines: IndexedLine[] = []
  for (let from = 0; from < buf.length;) {
    const nl = buf.indexOf(10, from)
    const to = nl < 0 ? buf.length : nl + 1
    lines.push(indexLine(buf.subarray(from, to), from))
    from = to
  }
  const read = (row: IndexedLine): Buffer => buf.subarray(row.from, row.to)
  const kept = selectBranchIds(lines, read)
  return kept ? Buffer.concat(lines.filter(row => row.id === null || kept.has(row.id)).map(read)) : buf
}

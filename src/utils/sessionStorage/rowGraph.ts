import type { UUID } from 'node:crypto'
import type { TranscriptMessage } from '../../types/logs.js'
import type { SystemCompactBoundaryMessage } from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'

type Segment = NonNullable<SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']>
const compactRow = (row: TranscriptMessage): row is TranscriptMessage & SystemCompactBoundaryMessage => row.type === 'system' && row.subtype === 'compact_boundary'
const snipped = (row: TranscriptMessage): UUID[] | undefined => (row as { snipMetadata?: { removedUuids?: UUID[] } }).snipMetadata?.removedUuids

export class TranscriptRows {
  private positions = new Map<UUID, number>()
  private ordinal = 0
  private children = new Map<UUID, Set<UUID>>()
  private assistants = new Map<string, Set<UUID>>()
  private terminals = new Set<UUID>()
  private boundaries = new Set<UUID>()
  private removals = new Map<UUID, UUID[]>()
  private structural = false

  constructor(readonly rows: Map<UUID, TranscriptMessage>) {
    for (const [id, row] of rows) this.set(id, row)
  }

  get(id: UUID): TranscriptMessage | undefined { return this.rows.get(id) }
  has(id: UUID): boolean { return this.rows.has(id) }
  [Symbol.iterator](): MapIterator<[UUID, TranscriptMessage]> { return this.rows[Symbol.iterator]() }

  private group<K>(index: Map<K, Set<UUID>>, key: K, id: UUID): void {
    let members = index.get(key)
    if (!members) index.set(key, members = new Set())
    members.add(id)
  }

  private ungroup<K>(index: Map<K, Set<UUID>>, key: K, id: UUID): void {
    const members = index.get(key)
    if (!members) return
    members.delete(id)
    if (members.size === 0) index.delete(key)
  }

  private detach(id: UUID, row: TranscriptMessage): void {
    if (row.parentUuid) {
      this.ungroup(this.children, row.parentUuid, id)
      if (!this.children.has(row.parentUuid) && this.has(row.parentUuid)) this.terminals.add(row.parentUuid)
    }
    if (row.type === 'assistant' && row.message.id) this.ungroup(this.assistants, row.message.id, id)
    this.boundaries.delete(id)
    this.removals.delete(id)
  }

  set(id: UUID, row: TranscriptMessage): this {
    const previous = this.positions.has(id) ? this.get(id) : undefined
    if (previous === row) return this
    if (previous) this.detach(id, previous)
    else this.positions.set(id, this.ordinal++)
    this.rows.set(id, row)
    if (row.parentUuid) {
      this.group(this.children, row.parentUuid, id)
      this.terminals.delete(row.parentUuid)
    }
    if (this.children.has(id)) this.terminals.delete(id)
    else this.terminals.add(id)
    if (row.type === 'assistant' && row.message.id) this.group(this.assistants, row.message.id, id)
    if (row.type === 'system') this.structural = true
    if (compactRow(row)) this.boundaries.add(id)
    const removed = snipped(row)
    if (removed) {
      this.removals.set(id, removed)
      this.structural = true
    }
    return this
  }

  delete(id: UUID): boolean {
    const row = this.get(id)
    if (!row) return false
    this.detach(id, row)
    this.positions.delete(id)
    this.terminals.delete(id)
    return this.rows.delete(id)
  }

  clear(): void {
    this.rows.clear()
    this.positions.clear()
    this.children.clear()
    this.assistants.clear()
    this.terminals.clear()
    this.boundaries.clear()
    this.removals.clear()
    this.ordinal = 0
    this.structural = false
  }

  private ordered(ids: Iterable<UUID>): TranscriptMessage[] {
    return [...ids].filter(id => this.has(id)).sort((a, b) => this.positions.get(a)! - this.positions.get(b)!).map(id => this.get(id)!)
  }

  childrenOf(id: UUID): TranscriptMessage[] {
    return this.ordered(this.children.get(id) ?? [])
  }

  finish(): void {
    if (!this.structural) return
    this.relinkPreserved()
    this.removeSnipped()
    this.structural = false
  }

  relinkPreserved(): void {
    let segment: Segment | undefined
    let owner: UUID | undefined
    let boundary: UUID | undefined
    for (const row of this.ordered(this.boundaries)) {
      if (!compactRow(row)) continue
      boundary = row.uuid
      if (row.compactMetadata?.preservedSegment) {
        segment = row.compactMetadata.preservedSegment
        owner = row.uuid
      }
    }
    if (!segment || !boundary) return
    const preserved = new Set<UUID>()
    if (owner === boundary) {
      let cursor = this.get(segment.tailUuid)
      while (cursor && !preserved.has(cursor.uuid)) {
        preserved.add(cursor.uuid)
        if (cursor.uuid === segment.headUuid) break
        cursor = cursor.parentUuid ? this.get(cursor.parentUuid) : undefined
      }
      if (!cursor || cursor.uuid !== segment.headUuid) return
      const first = this.get(segment.headUuid)!
      if (first.parentUuid !== segment.anchorUuid) this.set(first.uuid, { ...first, parentUuid: segment.anchorUuid })
      for (const id of [...(this.children.get(segment.anchorUuid) ?? [])]) {
        if (id === segment.headUuid) continue
        const child = this.get(id)!
        this.set(id, { ...child, parentUuid: segment.tailUuid })
      }
      for (const id of preserved) {
        const row = this.get(id)
        if (row?.type !== 'assistant') continue
        const usage = row.message.usage
        if (usage !== undefined && usage.input_tokens === 0 && usage.output_tokens === 0 && usage.cache_creation_input_tokens === 0 && usage.cache_read_input_tokens === 0) continue
        this.set(id, { ...row, message: { ...row.message, usage: { ...usage, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
      }
    }
    const end = this.positions.get(boundary)!
    for (const [id] of this) {
      if (this.positions.get(id)! >= end) break
      if (!preserved.has(id)) this.delete(id)
    }
  }

  removeSnipped(): void {
    const removed = new Set<UUID>()
    for (const ids of this.removals.values()) for (const id of ids) removed.add(id)
    if (removed.size === 0) return
    const parents = new Map<UUID, UUID | null>()
    const affected = new Set<UUID>()
    for (const id of removed) {
      const row = this.get(id)
      if (row) parents.set(id, row.parentUuid)
      for (const child of this.children.get(id) ?? []) affected.add(child)
    }
    let removedCount = 0
    for (const id of removed) if (this.delete(id)) removedCount++
    const resolve = (start: UUID): UUID | null => {
      let cursor: UUID | null = start
      const visited = new Set<UUID>()
      while (cursor && removed.has(cursor)) {
        if (visited.has(cursor)) { cursor = null; break }
        visited.add(cursor)
        cursor = parents.get(cursor) ?? null
      }
      for (const id of visited) parents.set(id, cursor)
      return cursor
    }
    let relinkedCount = 0
    for (const id of affected) {
      const row = this.get(id)
      if (!row?.parentUuid || !removed.has(row.parentUuid)) continue
      this.set(id, { ...row, parentUuid: resolve(row.parentUuid) })
      relinkedCount++
    }
    if (removedCount > 0 || relinkedCount > 0) logForDebugging(`snip replay on load: ${removedCount} message(s) removed, ${relinkedCount} survivor(s) re-linked`)
  }

  resumeLeaves(): Set<UUID> {
    const leaves = new Set<UUID>()
    const nearest = new Map<UUID, UUID | null>()
    let hasCycle = false
    for (const terminal of this.ordered(this.terminals)) {
      const visited = new Set<UUID>()
      let cursor: TranscriptMessage | undefined = terminal
      let leaf: UUID | null = null
      while (cursor) {
        if (nearest.has(cursor.uuid)) { leaf = nearest.get(cursor.uuid)!; break }
        if (visited.has(cursor.uuid)) { hasCycle = true; break }
        visited.add(cursor.uuid)
        if (cursor.type === 'user' || cursor.type === 'assistant') { leaf = cursor.uuid; break }
        cursor = cursor.parentUuid ? this.get(cursor.parentUuid) : undefined
      }
      for (const id of visited) nearest.set(id, leaf)
      if (leaf) leaves.add(leaf)
    }
    if (hasCycle) logForDebugging('cycle detected during resume-leaf computation', { level: 'warn' })
    return leaves
  }

  chain(leaf: TranscriptMessage): TranscriptMessage[] {
    const path: TranscriptMessage[] = []
    const seen = new Set<UUID>()
    let cursor: TranscriptMessage | undefined = leaf
    while (cursor) {
      if (seen.has(cursor.uuid)) {
        logError(new Error(`Cycle detected in parentUuid chain at message ${cursor.uuid}. Returning partial transcript.`))
        break
      }
      seen.add(cursor.uuid)
      path.push(cursor)
      cursor = cursor.parentUuid ? this.get(cursor.parentUuid) : undefined
    }
    path.reverse()
    const anchors = new Map<string, UUID>()
    for (const row of path) if (row.type === 'assistant' && row.message.id) anchors.set(row.message.id, row.uuid)
    const inserts = new Map<UUID, TranscriptMessage[]>()
    const byTime = (a: TranscriptMessage, b: TranscriptMessage): number => a.timestamp.localeCompare(b.timestamp)
    for (const [messageId, anchor] of anchors) {
      const group = this.ordered(this.assistants.get(messageId) ?? [])
      const siblings = group.filter(row => !seen.has(row.uuid)).sort(byTime)
      const results: TranscriptMessage[] = []
      for (const member of group) {
        for (const child of this.ordered(this.children.get(member.uuid) ?? [])) {
          if (child.type === 'user' && !seen.has(child.uuid) && Array.isArray(child.message.content) && child.message.content.some(block => block.type === 'tool_result')) results.push(child)
        }
      }
      results.sort(byTime)
      const restored = [...siblings, ...results]
      if (restored.length) {
        inserts.set(anchor, restored)
        for (const row of restored) seen.add(row.uuid)
      }
    }
    const conversation: TranscriptMessage[] = []
    for (const row of path) {
      conversation.push(row)
      const restored = inserts.get(row.uuid)
      if (restored) conversation.push(...restored)
    }
    const withNotes: TranscriptMessage[] = []
    for (const row of conversation) {
      withNotes.push(row)
      for (const note of this.ordered(this.children.get(row.uuid) ?? [])) {
        if (note.type !== 'system' || seen.has(note.uuid) || note.subtype === 'compact_boundary' || note.subtype === 'microcompact_boundary') continue
        seen.add(note.uuid)
        withNotes.push(note)
      }
    }
    return withNotes
  }
}

const indexedRows = new WeakMap<Map<UUID, TranscriptMessage>, TranscriptRows>()

export function createTranscriptRows(entries?: Iterable<readonly [UUID, TranscriptMessage]>): Map<UUID, TranscriptMessage> {
  const messages = new Map(entries)
  indexedRows.set(messages, new TranscriptRows(messages))
  return messages
}

export function transcriptRows(messages: Map<UUID, TranscriptMessage>): TranscriptRows {
  return indexedRows.get(messages) ?? new TranscriptRows(messages)
}

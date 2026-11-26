import type { UUID } from 'node:crypto'
import type { TranscriptMessage } from './transcriptEntries.js'
import type { SystemFoldBoundaryMessage } from '../../engine/message-shapes/message.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { logError } from '../../platform/logs/errorLog.js'

type Segment = NonNullable<SystemFoldBoundaryMessage['compactMetadata']['preservedSegment']>
type BoundaryRow = TranscriptMessage & SystemFoldBoundaryMessage
const foldBoundaryRow = (row: TranscriptMessage): row is BoundaryRow => row.type === 'system' && row.subtype === 'compact_boundary'
const snipped = (row: TranscriptMessage): UUID[] | undefined => (row as { snipMetadata?: { removedUuids?: UUID[] } }).snipMetadata?.removedUuids

export const sideNote = (row: { type: string; subtype?: string } | null | undefined): boolean => row?.type === 'system' && row.subtype !== 'local_command' && row.subtype?.endsWith('_boundary') !== true

export function keptLine<Id>(listed: readonly Id[], parentOf: (id: Id) => Id | null | undefined, notesUnder: (id: Id) => Iterable<Id>, isNote: (id: Id) => boolean): Id[] {
  const named = new Set(listed.filter((id, at) => at === 0 || at === listed.length - 1 || !isNote(id)))
  const under = new Map<Id, Id[]>()
  const seen = new Set<Id>()
  let loose: Id[] = []
  let whole = false
  for (let id: Id | null | undefined = listed.at(-1); !whole && id !== undefined && id !== null && !seen.has(id); id = parentOf(id)) {
    seen.add(id)
    if (!named.has(id)) { loose.unshift(id); continue }
    under.set(id, loose)
    loose = []
    whole = id === listed[0]
  }
  if (!whole) under.clear()
  const placed = new Set([...under.values()].flat())
  const reached = new Set<Id>()
  const owners = listed.slice(0, -1)
  for (const row of [...owners.filter(id => named.has(id)), ...owners.filter(id => !named.has(id))]) {
    if (placed.has(row)) continue
    const group = under.get(row) ?? []
    const open = [row]
    for (const from of open) {
      for (const note of notesUnder(from)) {
        if (named.has(note) || reached.has(note)) continue
        reached.add(note)
        open.push(note)
        if (placed.has(note)) continue
        placed.add(note)
        group.push(note)
      }
    }
    under.set(row, group)
  }
  return listed.flatMap(row => placed.has(row) ? [] : [row, ...(under.get(row) ?? [])])
}

class TranscriptRows {
  private positions = new Map<UUID, number>()
  private ordinal = 0
  children = new Map<UUID, Set<UUID>>()
  assistants = new Map<string, Set<UUID>>()
  private terminals = new Set<UUID>()
  private boundaries = new Set<UUID>()
  private anchors = new Map<UUID, Set<UUID>>()
  removals = new Map<UUID, UUID[]>()
  private structural = false

  constructor(readonly rows: Map<UUID, TranscriptMessage>, order: Iterable<UUID> = []) {
    for (const id of order) if (!this.positions.has(id)) this.positions.set(id, this.ordinal++)
    for (const [id, row] of rows) {
      if (!this.positions.has(id)) this.positions.set(id, this.ordinal++)
      this.index(id, row)
    }
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
    if (foldBoundaryRow(row) && row.compactMetadata?.preservedSegment !== undefined) this.ungroup(this.anchors, row.compactMetadata.preservedSegment.anchorUuid, id)
    this.removals.delete(id)
  }

  set(id: UUID, row: TranscriptMessage): this {
    const indexed = this.positions.has(id)
    const previous = indexed ? this.rows.get(id) : undefined
    if (previous === row) return this
    if (previous) this.detach(id, previous)
    else if (indexed) this.structural = true
    else this.positions.set(id, this.ordinal++)
    this.rows.set(id, row)
    this.index(id, row)
    return this
  }

  private index(id: UUID, row: TranscriptMessage): void {
    if (row.parentUuid) {
      this.group(this.children, row.parentUuid, id)
      this.terminals.delete(row.parentUuid)
      if (this.anchors.has(row.parentUuid)) this.structural = true
    }
    if (this.children.has(id)) this.terminals.delete(id)
    else this.terminals.add(id)
    if (row.type === 'assistant' && row.message.id) this.group(this.assistants, row.message.id, id)
    if (row.type === 'system') this.structural = true
    if (foldBoundaryRow(row)) {
      this.boundaries.add(id)
      if (row.compactMetadata?.preservedSegment !== undefined) this.group(this.anchors, row.compactMetadata.preservedSegment.anchorUuid, id)
    }
    const removed = snipped(row)
    if (removed) {
      this.removals.set(id, removed)
      this.structural = true
    }
  }

  delete(id: UUID): boolean {
    const row = this.get(id)
    if (!row) return false
    this.detach(id, row)
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
    this.anchors.clear()
    this.removals.clear()
    this.ordinal = 0
    this.structural = false
  }

  positionOf(id: UUID): number {
    return this.positions.get(id) ?? -1
  }

  ordered(ids: Iterable<UUID>): TranscriptMessage[] {
    return [...ids].filter(id => this.has(id)).sort((a, b) => this.positionOf(a) - this.positionOf(b)).map(id => this.get(id)!)
  }

  order(): UUID[] {
    return [...this.positions].sort((a, b) => a[1] - b[1]).map(([id]) => id)
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

  private boundariesOldestFirst(): BoundaryRow[] {
    return this.ordered(this.boundaries).filter(foldBoundaryRow)
  }

  private keptBySegment(segment: Segment): Set<UUID> | null {
    if (segment.keptUuids !== undefined) {
      const ids = segment.keptUuids
      if (!Array.isArray(ids) || ids[0] !== segment.headUuid || ids.at(-1) !== segment.tailUuid || !ids.every(id => this.has(id))) return null
      const folds = this.boundariesOldestFirst()
      const fold = folds.findIndex(row => row.compactMetadata?.preservedSegment === segment)
      const floor = fold < 1 ? -1 : this.positionOf(folds[fold - 1]!.uuid), end = fold < 0 ? Infinity : this.positionOf(folds[fold]!.uuid)
      const line = keptLine(ids, id => this.get(id)?.parentUuid, id => [...this.children.get(id) ?? []].filter(note => this.positionOf(note) > floor && this.positionOf(note) < end && sideNote(this.get(note))), id => sideNote(this.get(id)))
      const kept = new Set(line)
      return kept.size === line.length && !kept.has(segment.anchorUuid) ? kept : null
    }
    const kept = new Set<UUID>()
    let cursor = this.get(segment.tailUuid)
    while (cursor && !kept.has(cursor.uuid)) {
      kept.add(cursor.uuid)
      if (cursor.uuid === segment.headUuid) return kept
      cursor = cursor.parentUuid ? this.get(cursor.parentUuid) : undefined
    }
    return null
  }

  private relinkSegment(segment: Segment, kept: Set<UUID>): void {
    let parentUuid = segment.anchorUuid
    for (const id of segment.keptUuids === undefined ? [segment.headUuid] : kept) {
      const row = this.get(id)!
      if (row.parentUuid !== parentUuid) this.set(id, { ...row, parentUuid })
      parentUuid = id
    }
    for (const id of [...(this.children.get(segment.anchorUuid) ?? [])]) {
      if (id === segment.headUuid) continue
      const child = this.get(id)!
      this.set(id, { ...child, parentUuid: segment.tailUuid })
    }
    for (const id of kept) {
      const row = this.get(id)
      if (row?.type !== 'assistant') continue
      const usage = row.message.usage
      if (usage !== undefined && usage.input_tokens === 0 && usage.output_tokens === 0 && usage.cache_creation_input_tokens === 0 && usage.cache_read_input_tokens === 0) continue
      this.set(id, { ...row, message: { ...row.message, usage: { ...usage, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
    }
  }

  relinkPreserved(): void {
    const ordered = this.boundariesOldestFirst()
    const boundary = ordered.at(-1)
    if (!boundary || !ordered.some(row => row.compactMetadata?.preservedSegment !== undefined)) return
    let preserved = new Set<UUID>()
    for (const row of ordered) {
      const segment = row.compactMetadata?.preservedSegment
      if (segment === undefined) continue
      const kept = this.keptBySegment(segment)
      if (kept === null) {
        if (row === boundary) return
        continue
      }
      this.relinkSegment(segment, kept)
      if (row === boundary) preserved = kept
    }
    const end = this.positionOf(boundary.uuid)
    const folded: UUID[] = []
    for (const [id] of this) {
      if (this.positionOf(id) < end && !preserved.has(id)) folded.push(id)
    }
    for (const id of folded) this.delete(id)
  }

  removeSnipped(): void { return removeSnippedOf.call(this) }

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

  ancestry(leaf: TranscriptMessage, seen: Set<UUID>, relinks?: ReadonlyMap<UUID, UUID>): TranscriptMessage[] {
    const path: TranscriptMessage[] = []
    let cursor: TranscriptMessage | undefined = leaf
    while (cursor) {
      if (seen.has(cursor.uuid)) {
        logError(new Error(`Cycle detected in parentUuid chain at message ${cursor.uuid}. Returning partial transcript.`))
        break
      }
      seen.add(cursor.uuid)
      path.push(cursor)
      const above: UUID | null = relinks?.get(cursor.uuid) ?? cursor.parentUuid
      cursor = above ? this.get(above) : undefined
    }
    path.reverse()
    return path
  }

  decorate(spine: TranscriptMessage[], seen: Set<UUID>): TranscriptMessage[] { return decorateOf.call(this, spine, seen) }

  notesUnder(id: UUID, seen: Set<UUID>): TranscriptMessage[] { return notesUnderOf.call(this, id, seen) }

  chain(leaf: TranscriptMessage): TranscriptMessage[] {
    const seen = new Set<UUID>()
    return this.decorate(this.ancestry(leaf, seen), seen)
  }

  strandedAfter(boundary: BoundaryRow, seen: Set<UUID>, relinks: ReadonlyMap<UUID, UUID>): TranscriptMessage[] { return strandedAfterOf.call(this, boundary, seen, relinks) }
}

type NoteFrame =
  | { kind: 'sys'; list: TranscriptMessage[]; at: number }
  | { kind: 'afterSys'; attachments: TranscriptMessage[] }
  | { kind: 'attBfs'; queue: TranscriptMessage[]; at: number }

function notesUnderOf(this: TranscriptRows, rootId: UUID, seen: Set<UUID>): TranscriptMessage[] {
  const byPos = (a: TranscriptMessage, b: TranscriptMessage): number => this.positionOf(a.uuid) - this.positionOf(b.uuid)
  const splitChildren = (id: UUID): { systems: TranscriptMessage[]; attachments: TranscriptMessage[] } => {
    const ids = this.children.get(id)
    const systems: TranscriptMessage[] = []
    const attachments: TranscriptMessage[] = []
    if (!ids) return { systems, attachments }
    let prevSys = -1
    let sysUnsorted = false
    let prevAtt = -1
    let attUnsorted = false
    for (const childId of ids) {
      const row = this.get(childId)
      if (!row) continue
      if (row.type === 'system') {
        if (seen.has(row.uuid) || row.subtype === 'compact_boundary' || row.subtype === 'microcompact_boundary') continue
        const pos = this.positionOf(childId)
        if (pos < prevSys) sysUnsorted = true
        prevSys = pos
        systems.push(row)
      } else if (row.type === 'attachment') {
        const pos = this.positionOf(childId)
        if (pos < prevAtt) attUnsorted = true
        prevAtt = pos
        attachments.push(row)
      }
    }
    if (sysUnsorted) systems.sort(byPos)
    if (attUnsorted) attachments.sort(byPos)
    return { systems, attachments }
  }
  const pushAttachmentChildren = (id: UUID, out: TranscriptMessage[]): void => {
    const ids = this.children.get(id)
    if (!ids) return
    const start = out.length
    let prev = -1
    let unsorted = false
    for (const childId of ids) {
      const row = this.get(childId)
      if (!row || row.type !== 'attachment') continue
      const pos = this.positionOf(childId)
      if (pos < prev) unsorted = true
      prev = pos
      out.push(row)
    }
    if (unsorted) {
      const slice = out.splice(start)
      slice.sort(byPos)
      for (const row of slice) out.push(row)
    }
  }

  const notes: TranscriptMessage[] = []
  const stack: NoteFrame[] = []
  const enter = (id: UUID): void => {
    const { systems, attachments } = splitChildren(id)
    if (attachments.length > 0) stack.push({ kind: 'afterSys', attachments })
    if (systems.length > 0) stack.push({ kind: 'sys', list: systems, at: 0 })
  }
  enter(rootId)
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    if (frame.kind === 'sys') {
      let descended = false
      while (frame.at < frame.list.length) {
        const note = frame.list[frame.at++]!
        if (seen.has(note.uuid)) continue
        seen.add(note.uuid)
        notes.push(note)
        if (frame.at >= frame.list.length) stack.pop()
        enter(note.uuid)
        descended = true
        break
      }
      if (!descended) stack.pop()
    } else if (frame.kind === 'afterSys') {
      stack.pop()
      const hookQueue = frame.attachments.slice()
      for (let i = 0; i < hookQueue.length; i++) {
        const row = hookQueue[i]!
        if (seen.has(row.uuid)) continue
        const attachment = (row as { attachment?: unknown }).attachment as { type?: unknown; callId?: unknown } | undefined
        if (typeof attachment === 'object' && attachment !== null && attachment.type === 'hook' && typeof attachment.callId === 'string') {
          seen.add(row.uuid)
          notes.push(row)
        }
        pushAttachmentChildren(row.uuid, hookQueue)
      }
      stack.push({ kind: 'attBfs', queue: frame.attachments, at: 0 })
    } else {
      let descended = false
      while (frame.at < frame.queue.length) {
        const att = frame.queue[frame.at++]!
        const { systems, attachments } = splitChildren(att.uuid)
        for (const childAtt of attachments) frame.queue.push(childAtt)
        if (systems.length > 0) {
          if (frame.at >= frame.queue.length) stack.pop()
          stack.push({ kind: 'sys', list: systems, at: 0 })
          descended = true
          break
        }
      }
      if (!descended) stack.pop()
    }
  }
  return notes
}

function removeSnippedOf(this: TranscriptRows): void {
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

function decorateOf(this: TranscriptRows, spine: TranscriptMessage[], seen: Set<UUID>): TranscriptMessage[] {
  const anchors = new Map<string, UUID>()
  for (const row of spine) if (row.type === 'assistant' && row.message.id) anchors.set(row.message.id, row.uuid)
  const inserts = new Map<UUID, TranscriptMessage[]>()
  const byTime = (a: TranscriptMessage, b: TranscriptMessage): number => a.timestamp.localeCompare(b.timestamp)
  for (const [messageId, anchor] of anchors) {
    const group = this.ordered(this.assistants.get(messageId) ?? [])
    const siblings = group.filter(row => !seen.has(row.uuid)).sort(byTime)
    const results: TranscriptMessage[] = []
    for (const member of group) {
      const direct = this.children.get(member.uuid)
      if (!direct) continue
      const pending: UUID[] = [...direct]
      for (let i = 0; i < pending.length; i++) {
        const child = this.get(pending[i]!)
        if (!child) continue
        if (child.type === 'attachment' || (child.type === 'system' && child.subtype !== 'compact_boundary' && child.subtype !== 'microcompact_boundary')) {
          const nested = this.children.get(child.uuid)
          if (nested) for (const id of nested) pending.push(id)
        } else if (child.type === 'user' && !seen.has(child.uuid) && Array.isArray(child.message.content) && child.message.content.some(block => block.type === 'tool_result')) {
          results.push(child)
        }
      }
    }
    results.sort((a, b) => byTime(a, b) || this.positionOf(a.uuid) - this.positionOf(b.uuid))
    const restored = [...siblings, ...results]
    if (restored.length) {
      inserts.set(anchor, restored)
      for (const row of restored) seen.add(row.uuid)
    }
  }
  const conversation: TranscriptMessage[] = []
  for (const row of spine) {
    conversation.push(row)
    const restored = inserts.get(row.uuid)
    if (restored) conversation.push(...restored)
  }
  const withNotes: TranscriptMessage[] = []
  for (const row of conversation) {
    withNotes.push(row, ...this.notesUnder(row.uuid, seen))
  }
  return withNotes
}

function strandedAfterOf(this: TranscriptRows, boundary: BoundaryRow, seen: Set<UUID>, relinks: ReadonlyMap<UUID, UUID>): TranscriptMessage[] {
  const floor = this.positionOf(boundary.uuid)
  const verdicts = new Map<UUID, 'stranded' | 'attached'>()
  const stranded: TranscriptMessage[] = []
  for (const [id, row] of this) {
    if (this.positionOf(id) <= floor || seen.has(id) || verdicts.has(id)) continue
    const walked: TranscriptMessage[] = []
    const visited = new Set<UUID>()
    let cursor: TranscriptMessage | undefined = row
    let verdict: 'stranded' | 'attached' = 'attached'
    while (cursor) {
      if (seen.has(cursor.uuid) || visited.has(cursor.uuid)) break
      const known = verdicts.get(cursor.uuid)
      if (known !== undefined) { verdict = known; break }
      visited.add(cursor.uuid)
      walked.push(cursor)
      if (!cursor.parentUuid) { verdict = 'stranded'; break }
      const parent = this.get(cursor.parentUuid)
      if (parent === undefined) { verdict = 'stranded'; break }
      const moved = relinks.get(cursor.uuid)
      cursor = moved === undefined ? parent : this.get(moved)
    }
    for (const step of walked) {
      verdicts.set(step.uuid, verdict)
      if (verdict === 'stranded' && this.positionOf(step.uuid) > floor) stranded.push(step)
    }
  }
  stranded.sort((a, b) => this.positionOf(a.uuid) - this.positionOf(b.uuid))
  return stranded
}

const indexedRows = new WeakMap<Map<UUID, TranscriptMessage>, TranscriptRows>()

export function createTranscriptRows(entries?: Iterable<readonly [UUID, TranscriptMessage]>, order?: Iterable<UUID>): Map<UUID, TranscriptMessage> {
  const messages = new Map(entries)
  indexedRows.set(messages, new TranscriptRows(messages, order))
  return messages
}

export function transcriptRows(messages: Map<UUID, TranscriptMessage>): TranscriptRows {
  return indexedRows.get(messages) ?? new TranscriptRows(messages)
}

export function transcriptRowOrder(messages: Map<UUID, TranscriptMessage>): UUID[] {
  return transcriptRows(messages).order()
}

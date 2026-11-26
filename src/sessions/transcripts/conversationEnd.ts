import type { UUID } from 'node:crypto'
import { isToolUseResultMessage } from '../../engine/message-shapes/normalize.js'
import { isFoldBoundaryMessage } from '../../engine/message-shapes/systemMessages.js'
import { transcriptRows } from './rowGraph.js'
import type { TranscriptMessage } from './transcriptEntries.js'

type Scope = { kind: 'session' } | { kind: 'crewmate'; agentId: string }
type ConversationEnd = { primary: TranscriptMessage; rows: TranscriptMessage[]; screenRows: TranscriptMessage[] }
type Point = { id: UUID; parent: UUID | null; stamp: string; position: number; role: 'turn' | 'result' | 'quiet' | 'fence'; group: string; kept: { anchor: UUID; tail: UUID } | undefined }
type Choice = { primary: UUID; end: UUID; fence: UUID | undefined; relinks: Map<UUID, UUID>; late: Map<UUID, UUID> }
type Graph = ReturnType<typeof transcriptRows>

function pointOf(row: TranscriptMessage, position: number): Point {
  const segment = isFoldBoundaryMessage(row) ? row.compactMetadata?.preservedSegment : undefined
  const role = row.type === 'assistant' ? 'turn' : row.type === 'user' ? (isToolUseResultMessage(row) ? 'result' : 'turn') : isFoldBoundaryMessage(row) ? 'fence' : 'quiet'
  const group = row.type === 'assistant' && row.message.id ? row.message.id : row.uuid
  return { id: row.uuid, parent: row.parentUuid, stamp: row.timestamp, position, role, group, kept: segment === undefined ? undefined : { anchor: segment.anchorUuid, tail: segment.tailUuid } }
}

function climber(above: (point: Point) => Point | undefined, stopsAt: (point: Point) => boolean, longest: number): (from: Point | undefined) => Point | undefined {
  const known = new Map<UUID, Point | null>()
  return from => {
    let point = from
    let steps = 0
    while (point !== undefined && !stopsAt(point)) {
      const settled = known.get(point.id)
      if (settled !== undefined) {
        point = settled ?? undefined
        break
      }
      point = ++steps > longest ? undefined : above(point)
    }
    if (steps > 2) for (let step = from, left = steps; step !== undefined && left > 0; step = above(step), left--) known.set(step.id, point ?? null)
    return point
  }
}

function newer(point: Point, other: Point): boolean {
  const stampOf = (each: Point): number => {
    const at = Date.parse(each.stamp)
    return Number.isNaN(at) ? -Infinity : at
  }
  const at = stampOf(point)
  const otherAt = stampOf(other)
  return at > otherAt || (at === otherAt && point.position > other.position)
}

function choose(ordered: readonly Point[]): Choice | undefined {
  const points = new Map<UUID, Point>()
  for (const point of ordered) points.set(point.id, point)
  const fenceAt = ordered.findLastIndex(point => point.role === 'fence')
  return (fenceAt < 0 ? undefined : chooseBehind(ordered, points, fenceAt)) ?? chooseBehind(ordered, points, -1)
}

function chooseBehind(ordered: readonly Point[], points: ReadonlyMap<UUID, Point>, fenceAt: number): Choice | undefined {
  const fence = fenceAt < 0 ? undefined : ordered[fenceAt]
  const relinks = new Map<UUID, UUID>()
  const above = (point: Point): Point | undefined => {
    const id = relinks.get(point.id) ?? point.parent
    return id === null ? undefined : points.get(id)
  }
  const turnOf = climber(above, point => point.role === 'turn' || point.role === 'fence', ordered.length)
  const groupAt = (point: Point | undefined): string | undefined => (point === undefined ? undefined : (turnOf(point) ?? point).group)

  const keptTail = fence?.kept === undefined ? undefined : points.get(fence.kept.tail)
  const keptUnder = climber(above, point => point.id === fence?.kept?.anchor, ordered.length)
  const late = new Map<UUID, UUID>()
  let stand: Point | undefined
  for (let index = Math.max(fenceAt, 0); index < ordered.length; index++) {
    const point = ordered[index]!
    if (stand !== undefined && point.parent !== stand.id) {
      const parent = point.parent === null ? undefined : points.get(point.parent)
      if (point.role === 'result') {
        if (groupAt(parent) !== groupAt(stand)) {
          late.set(point.id, stand.id)
          continue
        }
      } else if (point.parent !== null) {
        const stood = late.get(point.parent) ?? (parent === undefined ? stand.id : undefined)
        if (stood !== undefined) relinks.set(point.id, stood)
      }
    }
    stand = keptTail !== undefined && point.id === fence?.kept?.anchor && keptUnder(keptTail) !== undefined ? keptTail : point
  }

  const fenceOf = climber(above, point => point === fence, ordered.length)
  const continued = new Set<string>()
  const lastTurn = new Map<string, number>()
  for (let index = 0; index < ordered.length; index++) {
    const point = ordered[index]!
    if (point.role !== 'turn' || (fence !== undefined && fenceOf(point) === undefined)) continue
    const prior = groupAt(above(point))
    if (prior !== undefined && prior !== point.group) continued.add(prior)
    lastTurn.set(point.group, index)
  }
  let turnAt = -1
  for (const [group, index] of lastTurn) if (!continued.has(group) && (turnAt < 0 || newer(ordered[index]!, ordered[turnAt]!))) turnAt = index
  const turn = turnAt < 0 ? (fence === undefined ? stand : undefined) : ordered[turnAt]
  if (turn === undefined) return undefined

  const tail = new Map<UUID, Point>()
  const behind = turnAt >= fenceAt ? turnAt + 1 : 0
  for (let index = behind; index < ordered.length; index++) {
    const point = ordered[index]!
    if ((point.role === 'quiet' || (point.role === 'result' && !late.has(point.id))) && groupAt(point) === turn.group) tail.set(point.id, point)
  }
  for (let index = behind; tail.size > 1 && index < ordered.length; index++) {
    const parent = late.has(ordered[index]!.id) ? undefined : above(ordered[index]!)
    if (parent !== undefined) tail.delete(parent.id)
  }
  let end = turn
  for (const point of tail.values()) end = point
  let primary = end
  while (primary.role === 'quiet' && primary !== turn) primary = above(primary) ?? turn
  return { primary: primary.id, end: end.id, fence: fence?.id, relinks, late }
}

function withStranded(graph: Graph, path: TranscriptMessage[], seen: Set<UUID>, fence: TranscriptMessage | undefined, relinks: ReadonlyMap<UUID, UUID>): TranscriptMessage[] {
  const stranded = fence !== undefined && isFoldBoundaryMessage(fence) ? graph.strandedAfter(fence, seen, relinks) : []
  if (stranded.length === 0) return path
  for (const row of stranded) seen.add(row.uuid)
  const spine: TranscriptMessage[] = []
  let next = 0
  for (const row of path) {
    const at = graph.positionOf(row.uuid)
    while (next < stranded.length && graph.positionOf(stranded[next]!.uuid) < at) spine.push(stranded[next++]!)
    spine.push(row)
  }
  while (next < stranded.length) spine.push(stranded[next++]!)
  return spine
}

export function electConversationEnd(messages: Map<UUID, TranscriptMessage>, scope: Scope = { kind: 'session' }): ConversationEnd | undefined {
  const graph = transcriptRows(messages)
  const inScope = (row: TranscriptMessage): boolean => (scope.kind === 'crewmate' ? row.isSidechain && row.agentId === scope.agentId : !row.isSidechain)
  const facts: Point[] = []
  let inFileOrder = true
  for (const row of messages.values()) {
    if (!inScope(row)) continue
    const fact = pointOf(row, graph.positionOf(row.uuid))
    if (fact.position < (facts.at(-1)?.position ?? -1)) inFileOrder = false
    facts.push(fact)
  }
  if (!inFileOrder) facts.sort((a, b) => a.position - b.position)
  const choice = choose(facts)
  if (choice === undefined) return undefined
  const primary = messages.get(choice.primary)!
  const project = (from: TranscriptMessage, stranded: boolean): TranscriptMessage[] => {
    const seen = new Set<UUID>()
    const path = graph.ancestry(from, seen, choice.relinks)
    const rows = graph.decorate(stranded ? withStranded(graph, path, seen, choice.fence === undefined ? undefined : messages.get(choice.fence), choice.relinks) : path, seen)
    return facts.length === messages.size ? rows : rows.filter(inScope)
  }
  let rows: TranscriptMessage[] | undefined
  let screenRows: TranscriptMessage[] | undefined
  return {
    primary,
    get rows() {
      return (rows ??= project(messages.get(choice.end)!, false))
    },
    get screenRows() {
      return (screenRows ??= project(primary, true))
    },
  }
}

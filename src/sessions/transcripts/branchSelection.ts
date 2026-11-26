import type { UUID } from 'node:crypto'
import { choose } from './conversationEnd.js'
import { readRecordFact, recordHoldsToolResult, type RecordFact } from './recordFacts.js'

type RowFact = Extract<RecordFact, { kind: 'voter' }>

const RECORD_LINE_PREFIX = Buffer.from('{"schemaVersion":1,"recordId":"')
const PRUNE_KIND_NEEDLE = Buffer.from('"payload":{"kind":"')
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
  const nodes = lines.filter(r => r.id !== null)
  if (!nodes.length) return null
  const len = lines.reduce((n, r) => n + r.to - r.from, 0)
  const chainBytes = nodes.reduce((n, r) => n + r.to - r.from, 0)
  if (chainBytes < Math.floor(len / 2)) return null
  const settled = new Map<string, IndexedLine>()
  const bytes = new Map<string, number>()
  for (const row of nodes) {
    settled.set(row.id!, row)
    bytes.set(row.id!, (bytes.get(row.id!) ?? 0) + row.to - row.from)
  }
  const rows = new Map<string, RowFact>()
  const progress = new Map<string, string | null>()
  for (const [id, row] of settled) {
    const fact = readRecordFact(id, read(row), rows.size)
    if (fact?.kind === 'bridge') progress.set(id, fact.parent)
    else if (fact !== undefined) rows.set(id, fact)
  }
  const over = (parent: string | null): string | null => {
    let at = parent
    for (let hops = 0; at !== null && progress.has(at) && hops <= progress.size; hops++) at = progress.get(at) ?? null
    return at
  }
  const points = [...rows.values()].filter(fact => !fact.sidechain).map(fact => ({ ...fact.point, parent: over(fact.point.parent) as UUID | null }))
  const elected = choose(points)
  if (elected === undefined) return null
  const relinks: ReadonlyMap<string, string> = elected.relinks
  const scope = new Set<string>(points.map(point => point.id))
  const above = (id: string): string | null => relinks.get(id) ?? over(rows.get(id)!.point.parent)

  const kept = new Set<string>()
  const spine: string[] = []
  for (let at: string | null = elected.end; at !== null && scope.has(at) && !kept.has(at); at = above(at)) {
    kept.add(at)
    spine.push(at)
  }
  const under = new Map<string, string[]>()
  const groups = new Map<string, string[]>()
  const file = (index: Map<string, string[]>, key: string, id: string): void => {
    const ids = index.get(key)
    if (ids) ids.push(id)
    else index.set(key, [id])
  }
  for (const [id, fact] of rows) {
    const parent = over(fact.point.parent)
    if (parent !== null) file(under, parent, id)
    if (fact.assistant) file(groups, fact.point.group, id)
  }
  const voiced = new Set<string>()
  let underAssistant = false
  for (let i = spine.length - 1; i >= 0; i--) {
    const fact = rows.get(spine[i]!)!
    if (fact.assistant) underAssistant = true
    else if (!fact.note) underAssistant = false
    if (underAssistant) voiced.add(spine[i]!)
  }
  const holdsResult = (id: string, fact: RowFact): boolean => (fact.holdsResult ??= recordHoldsToolResult(id, read(settled.get(id)!)))
  const gathered = [...spine]
  while (gathered.length > 0) {
    const id = gathered.pop()!
    const fact = rows.get(id)!
    for (const twin of (fact.assistant && groups.get(fact.point.group)) || []) {
      if (kept.has(twin)) continue
      kept.add(twin)
      voiced.add(twin)
      gathered.push(twin)
    }
    for (const child of under.get(id) ?? []) {
      const below = rows.get(child)!
      if (kept.has(child) || !(below.note || (voiced.has(id) && holdsResult(child, below)))) continue
      kept.add(child)
      if (below.note && voiced.has(id)) voiced.add(child)
      gathered.push(child)
    }
  }

  const hangsFrom = new Map<string, string>()
  const stranded = new Set<string>()
  for (const id of scope) {
    if (kept.has(id) || hangsFrom.has(id)) continue
    const line = new Set<string>()
    let at: string | null = id
    let top = id
    while (at !== null && !kept.has(at) && !hangsFrom.has(at) && !line.has(at)) {
      line.add(at)
      top = at
      const written = over(rows.get(at)!.point.parent)
      at = written !== null && rows.has(written) ? (relinks.get(at) ?? written) : null
    }
    if (at !== null && hangsFrom.has(at)) top = hangsFrom.get(at) ?? top
    else if (at === null || !kept.has(at)) stranded.add(top)
    for (const step of line) hangsFrom.set(step, top)
  }
  const fenceAt = elected.fence === undefined ? Infinity : rows.get(elected.fence)!.point.position
  const revived = new Set<string>()
  const stands = (id: string): boolean => {
    const top = hangsFrom.get(id)
    return top === undefined ? kept.has(id) : revived.has(top) || (stranded.has(top) && rows.get(id)!.point.position > fenceAt)
  }
  const leansOn = (id: string): Array<string | null | undefined> => {
    const written = over(rows.get(id)!.point.parent)
    const moved = relinks.get(id)
    return [moved, moved === undefined ? undefined : written, written !== null && scope.has(written) ? elected.late.get(id as UUID) : undefined]
  }
  const needed = [...scope].filter(stands).flatMap(leansOn)
  while (needed.length > 0) {
    const id = needed.pop() ?? ''
    const top = hangsFrom.get(id)
    if (top === undefined || stands(id)) continue
    revived.add(top)
    for (const [member, from] of hangsFrom) if (from === top && scope.has(member)) needed.push(...leansOn(member))
  }
  for (const id of hangsFrom.keys()) if (scope.has(id) && stands(id)) kept.add(id)
  for (const id of [...kept]) {
    for (let at = rows.get(id)!.point.parent as string | null; at !== null && progress.has(at) && !kept.has(at); at = progress.get(at) ?? null) kept.add(at)
  }

  let liveBytes = 0
  for (const id of kept) liveBytes += bytes.get(id) ?? 0
  if (chainBytes - liveBytes < Math.floor(len / 2)) return null
  return kept
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

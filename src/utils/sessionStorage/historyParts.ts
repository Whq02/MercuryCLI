import { basename, dirname, join } from 'node:path'
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs'
import { nodeTranscriptReaderIo, rangeFromFd, transcriptLineBytes } from './transcriptBytes.js'

const PREFIX = '{"annotations":{"historyPart":1,'
const HEADER_MAX = 2048

export const historyPartDir = (file: string): string => join(dirname(file), basename(file, '.jsonl'), 'history')
export const sealedFile = (file: string, end: number): string => join(historyPartDir(file), `${end}.jsonl`)

interface HistoryExtent {
  path: string
  before: number
  start: number
  end: number
  ino?: number
}

export function historyHead(file: string): HistoryExtent & { boundary?: string } {
  let fd: number
  try { fd = openSync(file, 'r') } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path: file, before: 0, start: 0, end: 0 }
    throw error
  }
  let prefix: Buffer, size: number, ino: number
  try {
    ;({ size, ino } = fstatSync(fd))
    prefix = rangeFromFd(fd, 0, Math.min(HEADER_MAX, size))
  } finally { closeSync(fd) }
  const plain = { path: file, before: 0, start: 0, end: size, ino }
  if (!prefix.subarray(0, PREFIX.length).equals(Buffer.from(PREFIX))) return plain
  const nl = prefix.indexOf(10)
  if (nl < 0) throw new Error(`Invalid history part header in ${file}`)
  const { annotations: row, payload } = JSON.parse(prefix.toString('utf8', 0, nl)) as { annotations: { before: number; carry: number; boundary: string }; payload?: { kind?: string; metaKind?: string } }
  if (payload?.kind !== 'session-meta' || payload.metaKind !== 'mercury-transcript-header') return plain
  if (!Number.isSafeInteger(row.before) || row.before < 1 || !Number.isSafeInteger(row.carry) || row.carry < 0 || row.carry > size - nl - 1 || typeof row.boundary !== 'string') throw new Error(`Invalid history part header in ${file}`)
  return { path: file, before: row.before, start: nl + 1 + row.carry, end: size, ino, boundary: row.boundary }
}

export function sealedExtents(head: HistoryExtent): HistoryExtent[] {
  const extents: HistoryExtent[] = []
  let end = head.before
  while (end > 0) {
    const path = sealedFile(head.path, end)
    const meta = nodeTranscriptReaderIo.readRangeSync(`${path}.index`, 0, 256)
    const line = meta.indexOf(10)
    if (line < 0) throw new Error(`Invalid history index at ${path}`)
    const [before, start, size] = JSON.parse(meta.toString('utf8', 0, line)) as number[]
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(start) || !Number.isSafeInteger(size) || before! < 0 || before! >= end || start! < 0 || size! - start! !== end - before!) throw new Error(`Invalid history extent at ${path}`)
    extents.push({ path, before: before!, start: start!, end: size! })
    end = before!
  }
  return extents.reverse()
}

export function* historyLines(file: string, from = 0, until = Infinity, head = historyHead(file)): Generator<Buffer> {
  const extents = from < head.before ? [...sealedExtents(head), head] : [head]
  for (const extent of extents) {
    const start = extent.start + Math.max(0, from - extent.before)
    const end = Math.min(extent.end, extent.start + until - extent.before)
    if (start >= end) continue
    if (extent !== head && statSync(extent.path).size !== extent.end) throw new Error(`History part changed: ${extent.path}`)
    yield* transcriptLineBytes(extent.path, { start, end, ino: extent.ino })
  }
}

export type HistoryIndexRow = [id: string, uuid: string | null, offset: number, length: number, mirrorUuid: string | null]

export function* historyIndex(extent: HistoryExtent): Generator<HistoryIndexRow> {
  let header = true
  const path = `${extent.path}.index`
  for (const line of transcriptLineBytes(path, { end: statSync(path).size })) {
    if (header) { header = false; continue }
    const row = JSON.parse(line.toString('utf8')) as HistoryIndexRow
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !(row[1] === null || typeof row[1] === 'string') || !Number.isSafeInteger(row[2]) || !Number.isSafeInteger(row[3]) || row[2] < extent.start || row[3] < 1 || row[3] > extent.end - row[2]) throw new Error(`Invalid history index at ${path}`)
    yield row
  }
}

export function historyRange(head: HistoryExtent, start: number, end: number): Buffer {
  return Buffer.concat([...historyLines(head.path, start, end, head)])
}

export function historyTail(file: string, limit: number): { bytes: Buffer; skipped: number } {
  const head = historyHead(file)
  const size = head.before + head.end - head.start
  const skipped = Math.max(0, size - limit)
  return { bytes: historyRange(head, skipped, size), skipped }
}

export function ownedHistoryParts(file: string): { dir: string; files: string[]; bytes: number } | undefined {
  const head = historyHead(file)
  if (!head.before) return undefined
  const dir = historyPartDir(file)
  const expected = join(realpathSync(dirname(file)), basename(file, '.jsonl'), 'history')
  if (realpathSync(dir) !== expected) throw new Error(`History directory changed: ${dir}`)
  const files = sealedExtents(head).flatMap(p => [p.path, `${p.path}.index`])
  let bytes = 0
  for (const name of files) {
    const st = lstatSync(name)
    if (!st.isFile()) throw new Error(`History part changed: ${name}`)
    bytes += st.size
  }
  return { dir, files, bytes }
}

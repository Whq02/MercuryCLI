import { randomUUID, type UUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FoldMetadata } from '../../../engine/message-shapes/message.js'
import { dirFsyncErrorIsFatal } from '../../../platform/host-os/files.js'
import { sleep } from '../../../platform/async/sleep.js'
import { asRecordId } from '../../fabric/ids.js'
import { entryToRecord, recordToEntry } from '../../fabric/entryCodec.js'
import type { MercuryRecord } from '../../fabric/record.js'
import { faultPoint, fsyncEnabled, publishAtomicSync } from '../../../platform/substrate/fileStore.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { foldWorkerRecord } from '../mirrorRecord.js'
import { carriedSegment } from '../rowGraph.js'
import { historyHead, historyIndex, historyPartDir, sealedExtents, sealedFile, type HistoryIndexRow } from '../historyParts.js'
import { rangeFromFd, transcriptLineBytes } from '../transcriptBytes.js'

type Range = { at: number; len: number; torn: boolean; relinkTo?: string; innerSegment?: Segment }
type ChainRow = Range & { parent?: string; originalParent?: string; keptParent?: UUID }
type Segment = NonNullable<FoldMetadata['preservedSegment']>
const sticky = new Set(['summary', 'custom-title', 'ai-title', 'last-prompt', 'tag', 'agent-name', 'agent-color', 'agent-setting', 'session-brief', 'session-brief-add', 'mode', 'advisor-switch', 'swarm-switch', 'model', 'worktree-state', 'pr-link'])

function linkedCopy(fd: number, row: Range, parent: string, file: string): Buffer {
  const bytes = rangeFromFd(fd, row.at, row.at + row.len)
  if (bytes.length !== row.len) throw new Error(`History changed while sealing ${file}`)
  const record = JSON.parse(bytes.toString('utf8')) as MercuryRecord
  record.parentId = asRecordId(parent)
  const payload = record.payload
  if (payload.kind === 'boundary' || payload.kind === 'notice') {
    payload.fields = { ...payload.fields, parentUuid: parent }
    if (row.innerSegment) payload.fields.compactMetadata = { ...payload.fields.compactMetadata as FoldMetadata, preservedSegment: row.innerSegment }
  }
  else if (payload.kind === 'unknown-retained') {
    const line = payload.fields.line
    if (line && typeof line === 'object') (line as Record<string, unknown>).parentUuid = parent
    else payload.fields.parentUuid = parent
  } else record.annotations = { ...record.annotations, parentUuid: parent }
  return Buffer.from(JSON.stringify(record) + '\n')
}

function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length;) at += writeSync(fd, data, at, data.length - at)
}

function* fileContents(path: string): Generator<Buffer> {
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(256 * 1024)
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) return
      yield chunk.subarray(0, n)
    }
  } finally { closeSync(fd) }
}

function archive(file: string, path: string): void {
  try {
    linkSync(file, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      const a = statSync(file), b = statSync(path)
      if (a.dev === b.dev && a.ino === b.ino) return
      throw error
    }
    if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EXDEV' && code !== 'EMLINK') throw error
    publishAtomicSync(path, fileContents(file), { mode: statSync(file).mode & 0o777 })
  }
}

async function alreadyArchived(head: ReturnType<typeof historyHead>, missing: Set<string>): Promise<boolean> {
  if (!missing.size) return true
  let count = 0
  try {
    for (const extent of sealedExtents(head)) {
      for (const [id] of historyIndex(extent)) {
        missing.delete(id)
        if (!missing.size) return true
        if (++count % 4096 === 0) await sleep(0)
      }
    }
  } catch (error) { passedOver(error) }
  return false
}

export async function sealHistoryPart(file: string, line: string, boundary: MercuryRecord): Promise<boolean> {
  const head = historyHead(file)
  if (head.boundary === boundary.recordId) return true
  if (head.end === 0) return false
  const before = statSync(file)
  if (head.end !== before.size || head.ino !== before.ino) throw new Error(`History changed while sealing ${file}`)
  const end = head.before + head.end - head.start
  const segment = (recordToEntry(boundary).compactMetadata as { preservedSegment?: Segment } | undefined)?.preservedSegment
  const ids = segment?.keptUuids
  if (ids !== undefined && !Array.isArray(ids)) return false
  const selected = ids && new Set<string>(ids)
  if (segment && selected && (selected.size !== ids!.length || selected.has(segment.anchorUuid))) return false
  const part = sealedFile(file, end)
  mkdirSync(historyPartDir(file), { recursive: true, mode: 0o700 })
  const staging = `${part}.${randomUUID()}.tmp`
  const index = openSync(staging, 'wx', 0o600)
  const metadata = new Map<string, Range>()
  const preservedMeta = new Map<string, Range>()
  const nodes = new Map<string, ChainRow>()
  const segments = new Map<string, Segment>()
  const missing = selected && new Set(selected)
  let at = 0, lastYield = 0, batch = ''
  try {
    try {
      writeAll(index, Buffer.from(JSON.stringify([head.before, head.start, head.end]) + '\n'))
      for (const bytes of transcriptLineBytes(file, { end: head.end })) {
        const range = { at, len: bytes.length, torn: bytes.at(-1) !== 10 }
        at += bytes.length
        if (at - lastYield >= 1024 * 1024) { await sleep(0); lastYield = at }
        if (batch.length >= 64 * 1024) { writeAll(index, Buffer.from(batch)); batch = '' }
        let record: MercuryRecord
        try { record = JSON.parse(bytes.toString('utf8')) as MercuryRecord } catch (error) {
          passedOver(error)
          if (range.at >= head.start && bytes.toString('utf8').trim()) batch += JSON.stringify(['', null, range.at, bytes.length, null]) + '\n'
          continue
        }
        if (record === null || typeof record !== 'object' || typeof record.recordId !== 'string' || !record.payload) continue
        const id = record.recordId, uid = record.annotations?.uuid
        const payload = record.payload
        const mirror = foldWorkerRecord(record, id)?.uuid ?? null
        if (range.at >= head.start) {
          const row: HistoryIndexRow = [id, typeof uid === 'string' ? uid : null, range.at, bytes.length, mirror]
          batch += JSON.stringify(row) + '\n'
        }
        missing?.delete(id)
        if (payload.kind === 'session-meta') {
          if (sticky.has(payload.metaKind)) metadata.set(JSON.stringify([payload.metaKind, payload.metaKind === 'summary' ? payload.fields.leafUuid : record.sessionId]), range)
          else if (segment && (payload.metaKind === 'file-history-snapshot' || payload.metaKind === 'attribution-snapshot')) preservedMeta.set(JSON.stringify([payload.metaKind, payload.fields.messageId]), range)
          else if (segment && payload.metaKind === 'content-replacement') preservedMeta.set(id, range)
        } else if (segment && (!selected || (selected.has(id) && (mirror !== null || payload.kind === 'attachment')))) {
          nodes.set(id, { ...range, parent: record.parentId, originalParent: record.parentId })
          if (payload.kind === 'boundary' && payload.boundaryKind === 'compact') {
            const prior = (payload.fields?.compactMetadata as { preservedSegment?: Segment } | undefined)?.preservedSegment
            if (prior) segments.set(id, prior)
          }
        }
      }
      if (batch) writeAll(index, Buffer.from(batch))
    } finally { closeSync(index) }
    const carry = [...metadata.values(), ...(!selected || nodes.size ? preservedMeta.values() : [])]
    if (selected) carry.sort((a, b) => a.at - b.at)
    if (segment?.keptUuids && selected && missing) {
      if (!await alreadyArchived(head, missing)) return false
      const keptUuids = segment.keptUuids.filter(id => nodes.has(id))
      if (keptUuids.length !== segment.keptUuids.length && boundary.payload.kind === 'boundary') {
        const { fields } = boundary.payload
        const headUuid = keptUuids[0], tailUuid = keptUuids.at(-1)
        const preservedSegment = headUuid && tailUuid ? { ...segment, headUuid, tailUuid, keptUuids } : undefined
        const compactMetadata = { ...fields.compactMetadata as FoldMetadata, preservedSegment }
        const stored = { ...boundary, payload: { ...boundary.payload, fields: { ...fields, compactMetadata } } }
        line = line.slice(0, line.lastIndexOf('\n', line.length - 2) + 1) + JSON.stringify(stored) + '\n'
      }
      let parent = segment.anchorUuid
      for (const id of keptUuids) {
        const row = nodes.get(id)!
        row.keptParent = parent
        if (row.parent !== parent) row.relinkTo = parent
        carry.push(row)
        parent = id
      }
      for (const [id, prior] of segments) {
        const inner = carriedSegment(prior, uuid => nodes.get(uuid)?.keptParent)
        if (inner === prior) continue
        const row = nodes.get(id)!
        row.relinkTo = row.keptParent
        row.innerSegment = inner
      }
    } else if (segment) {
      for (const prior of segments.values()) {
        const first = nodes.get(prior.headUuid)
        if (first && nodes.has(prior.tailUuid)) {
          first.parent = prior.anchorUuid
          for (const [id, row] of nodes) if (id !== prior.headUuid && row.parent === prior.anchorUuid) row.parent = prior.tailUuid
        }
      }
      let id: string | undefined = segment.tailUuid
      const seen = new Set<string>()
      for (;;) {
        const row: ChainRow | undefined = id === undefined ? undefined : nodes.get(id)
        if (!row || !id || seen.has(id)) return false
        if (id !== segment.headUuid && row.parent !== row.originalParent) row.relinkTo = row.parent
        carry.push(row)
        if (id === segment.headUuid) break
        seen.add(id)
        id = row.parent
      }
    }
    if (!selected) carry.sort((a, b) => a.at - b.at)
    const source = openSync(file, 'r')
    let carrySize = 0
    try {
      for (const row of carry) carrySize += row.relinkTo === undefined ? row.len + Number(row.torn) : linkedCopy(source, row, row.relinkTo, file).length
    } finally { closeSync(source) }
    const current = statSync(file)
    if (current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs) throw new Error(`History changed while sealing ${file}`)
    const header = entryToRecord({ type: 'mercury-transcript-header', fileVersion: 1, format: 'mercury-records' }, { sessionId: boundary.sessionId, nextOrdinal: () => boundary.creationOrdinal, observedAt: boundary.occurredAt, source: boundary.source })
    const marker = JSON.stringify({ annotations: { historyPart: 1, before: end, carry: carrySize, boundary: boundary.recordId }, ...header }) + '\n'
    faultPoint('seal-part', file)
    archive(file, part)
    publishAtomicSync(`${part}.index`, fileContents(staging), { mode: 0o600 })
    rmSync(staging)
    if (fsyncEnabled()) {
      try { const fd = openSync(dirname(historyPartDir(file)), 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
      catch (error) { if (dirFsyncErrorIsFatal(error)) throw error }
    }
    function* contents(): Generator<Buffer> {
      yield Buffer.from(marker)
      const fd = openSync(part, 'r')
      try {
        for (const row of carry) {
          if (row.relinkTo !== undefined) {
            yield linkedCopy(fd, row, row.relinkTo, file)
            continue
          }
          for (let off = 0; off < row.len;) {
            const piece = Buffer.allocUnsafe(Math.min(256 * 1024, row.len - off))
            const n = readSync(fd, piece, 0, piece.length, row.at + off)
            if (!n) throw new Error(`History changed while sealing ${file}`)
            yield piece.subarray(0, n)
            off += n
          }
          if (row.torn) yield Buffer.from('\n')
        }
      } finally { closeSync(fd) }
      yield Buffer.from(line)
    }
    publishAtomicSync(file, contents(), { mode: 0o600 })
    return true
  } finally { rmSync(staging, { force: true }) }
}

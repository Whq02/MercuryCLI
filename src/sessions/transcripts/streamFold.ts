import { closeSync, fstatSync, openSync } from 'node:fs'
import { sleep } from '../../platform/async/sleep.js'
import { decodeTranscriptBuffer } from '../fabric/transcriptDecode.js'
import type { Entry } from './transcriptEntries.js'
import { classifyLoadLine, SKIP_PRECOMPACT_THRESHOLD } from './sessionStoragePortable.js'
import { applyTranscriptEntry, type TranscriptFoldState } from './fold.js'
import { indexLine, selectBranchIds, type IndexedLine } from './branchSelection.js'
import { rangeFromFd, transcriptLineBytes, transcriptReaderCensus } from './transcriptBytes.js'

const METADATA_TYPE_MARKERS = [
  '"metaKind":"summary"',
  '"metaKind":"custom-title"',
  '"metaKind":"tag"',
  '"metaKind":"agent-name"',
  '"metaKind":"agent-color"',
  '"metaKind":"agent-setting"',
  '"metaKind":"session-brief"',
  '"metaKind":"session-brief-add"',
  '"metaKind":"mode"',
  '"metaKind":"advisor-switch"',
  '"metaKind":"swarm-switch"',
  '"metaKind":"model"',
  '"metaKind":"worktree-state"',
  '"metaKind":"pr-link"',
]
const METADATA_MARKER_BUFS = METADATA_TYPE_MARKERS.map(m => Buffer.from(m))
const previousPartMetadata = new Set(METADATA_TYPE_MARKERS.map(marker => /"metaKind":"([^"]+)"/.exec(marker)![1]!))

export async function streamFold(path: string, fold: TranscriptFoldState, start: number, end: number, ino: number, plan: boolean, prune: boolean, committedOnly = false, accepts?: (e: Entry) => boolean) {
  const accounting = { malformed: 0, invalid: 0, totalLines: 0 }
  let refusal: string | null = null, firstIssue = '', firstParsed = true, offset = end, pruned = false, rejectedParent = false
  let physical = start, boundary = start, budget = 0, preserved = false, parsed = 0
  const fd = openSync(path, 'r')
  const decode = (bytes: Buffer, torn: boolean): void => {
    const one = decodeTranscriptBuffer<Entry>(bytes)
    accounting.totalLines += one.totalLines
    if (refusal) return
    if (one.refusal && firstParsed) { refusal = one.refusal; return }
    const malformed = torn ? 0 : one.malformed.length
    if (!firstIssue && malformed) firstIssue = `line ${accounting.totalLines}`
    if (!firstIssue && (one.invalid.length || one.refusal)) firstIssue = `#${parsed} ${one.invalid[0]?.reason ?? 'line is not a MercuryRecord envelope'}`
    if (one.entries.length || one.invalid.length || one.refusal) { firstParsed = false; parsed++ }
    accounting.malformed += malformed
    accounting.invalid += one.invalid.length + Number(Boolean(one.refusal))
    for (const entry of one.entries) {
      if (accepts && !accepts(entry)) rejectedParent = true
      if (!rejectedParent) applyTranscriptEntry(fold, entry)
    }
  }
  try {
    const st = fstatSync(fd)
    if (st.ino !== ino || st.size < end) throw new Error(`History changed during the read: ${path}`)
    let rows: IndexedLine[] = []
    const meta: IndexedLine[] = []
    let snapshot: IndexedLine | null = null
    const read = (r: IndexedLine): Buffer => {
      const bytes = rangeFromFd(fd, r.from, r.to)
      if (bytes.length !== r.to - r.from) throw new Error(`History changed during the read: ${path}`)
      transcriptReaderCensus.bytesRead += bytes.length
      return bytes
    }
    for (const bytes of transcriptLineBytes(path, { start, end, opened: fd })) {
      const at = physical
      physical += bytes.length
      budget += bytes.length
      if (budget >= 1024 * 1024) { await sleep(0); budget = 0 }
      let torn = false
      if (bytes.at(-1) !== 10) {
        if (committedOnly) { offset = at; break }
        try { JSON.parse(bytes.toString('utf8')) } catch { torn = true; offset = at }
      }
      if (!plan) { decode(bytes, torn); continue }
      const row = indexLine(bytes, at)
      const disposition = classifyLoadLine(bytes, false)
      if (disposition.kind === 'snapshot') { snapshot = row; continue }
      if (disposition.kind === 'boundary') {
        if (disposition.preserved) preserved = true
        else { rows = []; boundary = at; preserved = false; snapshot = null }
      }
      if (METADATA_MARKER_BUFS.some(marker => bytes.includes(marker))) meta.push(row)
      rows.push(row)
    }
    if (plan) {
      if (snapshot) rows.push(snapshot)
      for (const row of meta) {
        if (row.from >= boundary) break
        for (const entry of decodeTranscriptBuffer<Entry>(read(row)).entries) if (previousPartMetadata.has(entry.type)) applyTranscriptEntry(fold, entry)
      }
      const selected = prune && !preserved && rows.reduce((n, r) => n + r.to - r.from, 0) > SKIP_PRECOMPACT_THRESHOLD ? selectBranchIds(rows, read) : null
      pruned = selected !== null
      for (const row of rows) {
        if (selected && row.id !== null && !selected.has(row.id)) continue
        const bytes = read(row)
        decode(bytes, row.from === offset && offset !== end)
        budget += bytes.length
        if (budget >= 1024 * 1024) { await sleep(0); budget = 0 }
      }
    }
    if (refusal) { accounting.invalid = 0; accounting.malformed = 0 }
    return { accounting, refusal, offset, pruned, firstIssue, rejectedParent }
  } finally { closeSync(fd) }
}

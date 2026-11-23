import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { historyLines } from './historyParts.js'
import type { Entry } from './transcriptEntries.js'
import { decodeTranscriptBuffer } from '../fabric/transcriptDecode.js'
import {
  applyTranscriptEntry,
  emptyFoldState,
  type TranscriptFoldState,
} from './loading.js'

interface MaterializedPoint {
  ordinal: number
  totalEntries: number
  fold: TranscriptFoldState
  digest: string
}

export async function readAllTranscriptEntries(transcriptPath: string): Promise<Entry[]> {
  return [...fileEntries(transcriptPath)]
}

function* fileEntries(path: string): Generator<Entry> {
  statSync(path)
  let first = true
  for (const row of historyLines(path)) {
    const decoded = decodeTranscriptBuffer<Entry>(row)
    if (first && decoded.refusal) return
    if (decoded.refusal || decoded.invalid.length || decoded.entries.length) first = false
    yield* decoded.entries
  }
}

export function transcriptMessageIndex(path: string, uuid: string): number {
  let index = 0
  for (const entry of fileEntries(path)) {
    if ('uuid' in entry && entry.uuid === uuid) return index
    index++
  }
  return -1
}

export function materializationDigest(fold: TranscriptFoldState): string {
  const hash = createHash('sha256')
  function feed(value: unknown): void {
    if (value instanceof Map) {
      hash.update('{"«map»":')
      feed([...value.entries()].map(([k, v]) => [String(k), v]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      hash.update('}')
    } else if (Array.isArray(value)) {
      hash.update('[')
      value.forEach((v, i) => { if (i) hash.update(','); feed(v) })
      hash.update(']')
    } else if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const sorted = Object.fromEntries(Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => [k, obj[k]]))
      hash.update('{')
      Object.entries(sorted).forEach(([k, v], i) => { if (i) hash.update(','); hash.update(JSON.stringify(k) + ':'); feed(v) })
      hash.update('}')
    } else hash.update(JSON.stringify(value) ?? 'null')
  }
  feed(fold)
  return hash.digest('hex')
}

export function materializeEntriesAt(entries: readonly Entry[], ordinal?: number): MaterializedPoint {
  const upTo = ordinal === undefined ? entries.length : Math.max(0, Math.min(ordinal, entries.length))
  const fold = emptyFoldState()
  for (let i = 0; i < upTo; i++) {
    applyTranscriptEntry(fold, entries[i]!)
  }
  return {
    ordinal: upTo,
    totalEntries: entries.length,
    fold,
    digest: materializationDigest(fold),
  }
}

export async function materializeTranscriptAt(
  transcriptPath: string,
  ordinal?: number,
): Promise<MaterializedPoint> {
  const fold = emptyFoldState()
  let totalEntries = 0, taken = 0
  for (const entry of fileEntries(transcriptPath)) {
    if (ordinal === undefined || totalEntries < ordinal) { applyTranscriptEntry(fold, entry); taken++ }
    totalEntries++
  }
  return { ordinal: taken, totalEntries, fold, digest: materializationDigest(fold) }
}

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Entry } from '../../types/logs.js'
import { decodeTranscriptBuffer } from '../../fabric/transcriptDecode.js'
import {
  applyTranscriptEntry,
  emptyFoldState,
  type TranscriptFoldState,
} from './loading.js'

export interface MaterializedPoint {
  ordinal: number
  totalEntries: number
  fold: TranscriptFoldState
  digest: string
}

export async function readAllTranscriptEntries(transcriptPath: string): Promise<Entry[]> {
  const data = await readFile(transcriptPath)
  const decoded = decodeTranscriptBuffer<Entry>(data)
  return decoded.entries
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([k, v]) => [String(k), canonicalize(v)] as const,
    )
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return { '«map»': entries }
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = canonicalize(v)
    }
    return out
  }
  return value
}

export function materializationDigest(fold: TranscriptFoldState): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(fold as unknown as Record<string, unknown>)))
    .digest('hex')
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
  return materializeEntriesAt(await readAllTranscriptEntries(transcriptPath), ordinal)
}

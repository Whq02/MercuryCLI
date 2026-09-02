// ============================================================================
//  sessionStorage/materialize — deterministic point-in-time materialization
//
//
//  materializeTranscriptAt reconstructs the fold state at ANY retained
//  committed ordinal as the PURE fold over the transcript's records — the
//  same emptyFoldState/applyTranscriptEntry kernel the loader and the
//  resume snapshot share, so a materialized point can never disagree with
//  what a resume at that point would have produced.
//
//  Laws:
//    · OWN full-read path: readAllTranscriptEntries reads the WHOLE
//      file — the >5MB precompact-skip is a LOADER latency policy, never a
//      truth policy; replay reads everything.
//    · determinism: identical inputs ⇒ identical state ⇒ identical
//      semantic digest. The digest canonicalizes the fold (sorted map
//      entries, sorted object keys) so map insertion order and platform
//      cannot leak in.
//    · zero side effects: this module performs no writes, no model
//      calls, no tool executions, no unread mutations — it only reads the
//      given bytes/entries and folds. (Import surface pinned by the prover.)
//
//  The committed ordinal vocabulary: the 1-based position of the entry in
//  file order — the same order the fold consumes and the writer commits.
//  vNext records carrying their own creationOrdinal agree with this by the
// Settlement law (pinned in prove-transition-b-replay-core).
// ============================================================================
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
  /** The committed ordinal folded to (1-based entry position; 0 = empty). */
  ordinal: number
  /** Total committed entries seen in the source. */
  totalEntries: number
  fold: TranscriptFoldState
  /** The semantic materialization digest (canonical, platform-stable). */
  digest: string
}

/** The OWN full-read path: every byte, no precompact skip, decoded by
 *  the fabric decoder the loader itself uses. */
export async function readAllTranscriptEntries(transcriptPath: string): Promise<Entry[]> {
  const data = await readFile(transcriptPath)
  const decoded = decodeTranscriptBuffer<Entry>(data)
  return decoded.entries
}

/** Canonical JSON: sorted object keys, Maps as sorted entry lists — the
 *  digest input. Undefined drops (JSON semantics); insertion order cannot
 *  leak. */
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

/** The semantic materialization digest: sha256 over the canonical
 *  fold serialization. */
export function materializationDigest(fold: TranscriptFoldState): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(fold as unknown as Record<string, unknown>)))
    .digest('hex')
}

/** The pure fold to a committed ordinal (undefined ⇒ the full history). */
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

/** materializeAt over a transcript file — the entry point. */
export async function materializeTranscriptAt(
  transcriptPath: string,
  ordinal?: number,
): Promise<MaterializedPoint> {
  return materializeEntriesAt(await readAllTranscriptEntries(transcriptPath), ordinal)
}

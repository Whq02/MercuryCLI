/* ============================================================================
   MNEME CURRENT buffer — observation staging (see mnemeGates.ts;
   arXiv:2606.10677 §current buffer).

   Observations land here first as O_APPEND JSONL rows and only enter the
   library at consolidation, so adjacent-turn corrections resolve BEFORE a
   topic doc is touched (the paper's staging rationale). Write posture is the
   evolutionLedger idiom: flag-gated, clamped fields, single atomic append,
   never throws to the caller's hot path.

   SEQ DISCIPLINE (multi-writer honesty, the audit-chain lesson): buffer rows
   carry NO seq — several processes (session, daemon workers) may append
   concurrently and a read-modify-write counter would race. The library's
   monotonic seq is assigned by the SINGLE consolidator, in file order, from
   the persisted counter in library.json. time + source are captured HERE, at
   observation — they are the cues that move with the entry forever.
   ============================================================================ */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { estimateTokens } from './mnemeTopicDocs.js'

export interface MnemeObservation {
  ts: string
  source: string
  text: string
  topicHint?: string
}

const CAP = { text: 2000, source: 60, topicHint: 60 } as const
const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** Entries serialize as single markdown lines with a `<seq=…, source=…>`
 *  signature — a newline in text (or `,`/`<`/`>` in source) would round-trip
 *  into an entry the parser can never see: written but unreachable.
 *  Flatten at origin so buffer rows are signature-safe from birth. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')
const sigSafe = (s: string): string => s.replace(/[,<>\r\n]+/g, '-')

export function currentBufferPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'current.jsonl')
}

/**
 * Append one observation to CURRENT. No-op (false) when MNEME is off — no
 * dir, no file. Returns whether the row was written.
 */
export function appendObservation(
  input: { text: string; source: string; topicHint?: string },
  dir: string = mnemeLibraryDir(),
): boolean {
  if (!mnemeEnabled()) return false
  try {
    const text = clamp(oneLine(String(input.text ?? '')).trim(), CAP.text)
    const source = clamp(sigSafe(String(input.source ?? '')).trim(), CAP.source)
    if (!text || !source) return false
    const row: MnemeObservation = {
      ts: new Date().toISOString(),
      source,
      text,
      ...(input.topicHint ? { topicHint: clamp(String(input.topicHint).trim(), CAP.topicHint) } : {}),
    }
    mkdirSync(dir, { recursive: true })
    appendFileSync(currentBufferPath(dir), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch (e) {
    logForDebugging(`mneme appendObservation failed: ${String(e)}`)
    return false
  }
}

/** Read the buffer in file order (malformed lines skipped, named in debug). */
export function readBuffer(dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const p = currentBufferPath(dir)
  if (!existsSync(p)) return []
  const out: MnemeObservation[] = []
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as MnemeObservation
        if (typeof row?.text === 'string' && typeof row?.source === 'string' && typeof row?.ts === 'string') {
          out.push(row)
        }
      } catch {
        logForDebugging('mneme readBuffer: skipped malformed row')
      }
    }
  } catch {
    return []
  }
  return out
}

/** Estimated token size of the whole buffer (the |C| ≥ threshold trigger). */
export function bufferTokens(dir: string = mnemeLibraryDir()): number {
  return readBuffer(dir).reduce((n, r) => n + estimateTokens(r.text), 0)
}

/**
 * Rows sitting in `consuming-*` files: consumed by a consolidator that has
 * not finished (crashed, or mid-run right now). These stay VISIBLE to
 * retrieval — a crash never hides them from reads for the stale-lock window.
 */
export function readConsumingRows(dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const out: MnemeObservation[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(n => /^consuming-.*\.jsonl$/.test(n)).sort()
  } catch {
    return []
  }
  for (const name of names) {
    try {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as MnemeObservation
          if (typeof row?.text === 'string' && typeof row?.source === 'string' && typeof row?.ts === 'string') out.push(row)
        } catch {
          logForDebugging('mneme readConsumingRows: skipped malformed row')
        }
      }
    } catch {
      /* file raced away (consolidator finished) — fine */
    }
  }
  return out
}

/** Every not-yet-consolidated row: consuming-* first (older), then CURRENT.
 *  With no consuming files this is exactly readBuffer (byte-identical). */
export function pendingRows(dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const consuming = readConsumingRows(dir)
  const current = readBuffer(dir)
  return consuming.length === 0 ? current : [...consuming, ...current]
}

/** The most recent N pending observations — folded into retrieval context so
 *  a fact observed seconds ago is findable BEFORE consolidation, including
 *  rows stranded mid-consolidation by a crash. */
export function recentObservations(n: number, dir: string = mnemeLibraryDir()): MnemeObservation[] {
  const rows = pendingRows(dir)
  return rows.slice(Math.max(0, rows.length - n))
}

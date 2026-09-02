/**
 * storeRevision — the revision contract for FileStore snapshots (the
 * crash-consistency program). Pure types + stamp/parse helpers;
 * IO stays in fileStore.ts.
 *
 * OBJECT-shaped stores carry the revision IN-BAND as an additive `_rev` key
 * beside `_v` (one atomic rename covers value + revision — no sidecar, no
 * crash window between them; old readers ignore unknown keys, so
 * mixed-version sessions stay compatible). BARE-ARRAY stores (the teammate
 * mailbox) deliberately cannot be object-wrapped — their revision derives
 * from a declared `revisionOf` or stays
 * `null` (legacy: content-dedup only, honestly reported).
 */

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'

/** Additive revision key stamped on object-shaped encodes (beside `_v`). */
export const REVISION_KEY = '_rev'

export interface StoreRevision {
  /** Monotonic per-store commit counter — advances EXACTLY once per
   *  successful mutation. */
  revision: number
  /** The committing process (`pid:<n>`), diagnostics only. */
  writerId: string
  /** Unique id of the committing operation — the cross-process dedup key
   *  (a watcher echo of our own commit dedups by THIS, not raw bytes). */
  operationId: string
  /** ISO commit time (diagnostics; never used for ordering). */
  committedAt: string
  /** sha256 (hex, 16 chars) of the encoded VALUE payload (sans meta keys) —
   *  lets materialized views / doctor compare content identity without
   *  re-reading full bytes. */
  digest: string
}

export type StoreReadState = 'ready' | 'missing' | 'recoverable'

export type StoreReadResult<T> =
  | { state: 'ready'; value: T; revision: StoreRevision | null }
  | { state: 'missing'; value: T }
  | {
      state: 'recoverable'
      reason: string
      path: string
      /** The last value THIS runtime knew to be committed, when one exists
       *  (in-memory witness — never fabricated from disk). */
      lastGood?: T
    }

export type StoreChangeCause = 'local-commit' | 'watch' | 'catch-up' | 'recovery'

export interface StoreChange<T> {
  value: T
  /** The committed revision this emission observed; null for legacy
   *  unstamped bytes (the subscriber KNOWS it cannot prove continuity). */
  revision: StoreRevision | null
  cause: StoreChangeCause
  /** How many committed revisions this subscriber provably skipped since
   *  its last observation (0 when continuous or unprovable). */
  skippedRevisions: number
}

/** Digest of an encoded payload (16 hex chars — identity, not security). */
export function payloadDigest(encodedSansMeta: string): string {
  return createHash('sha256').update(encodedSansMeta).digest('hex').slice(0, 16)
}

/** Mint the next revision after `prev` (or the first). */
export function nextRevision(prev: StoreRevision | null, digest: string): StoreRevision {
  return {
    revision: (prev?.revision ?? 0) + 1,
    writerId: `pid:${process.pid}`,
    operationId: randomUUID(),
    committedAt: new Date().toISOString(),
    digest,
  }
}

/** Parse a `_rev` stamp from raw parsed JSON (object stores). Null when
 *  absent/malformed — a malformed stamp degrades to legacy, never throws. */
export function parseRevision(raw: unknown): StoreRevision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rev = (raw as Record<string, unknown>)[REVISION_KEY]
  if (!rev || typeof rev !== 'object') return null
  const r = rev as Partial<StoreRevision>
  if (
    typeof r.revision !== 'number' ||
    !Number.isFinite(r.revision) ||
    typeof r.operationId !== 'string'
  ) {
    return null
  }
  return {
    revision: r.revision,
    writerId: typeof r.writerId === 'string' ? r.writerId : 'unknown',
    operationId: r.operationId,
    committedAt: typeof r.committedAt === 'string' ? r.committedAt : '',
    digest: typeof r.digest === 'string' ? r.digest : '',
  }
}

/** Provable skip count between the last seen revision and a new one.
 *  Unprovable (either side legacy/unknown) ⇒ 0 — never a fabricated gap. */
export function skippedBetween(
  lastSeen: number | null,
  next: StoreRevision | null,
): number {
  if (lastSeen === null || next === null) return 0
  return Math.max(0, next.revision - lastSeen - 1)
}

// ============================================================================
//  render-engine/projection.ts — the flat transcript projection (law E10).
//
//  The renderable list is a PURE FUNCTION of (persisted session record, at
//  most one in-flight unsettled turn). Rows carry the record row's identity;
//  the projection introduces no second copy of any record row. Dialect
//  adapters (Anthropic-family, OpenAI-family, local) feed the SAME record —
//  wire-replay bookkeeping (request re-presentation, tool-round replay,
//  retries) lives strictly below the record and NEVER mints renderables.
//
//  THE WIRING CONTRACT (the migration lane mounts the real dialect layer on
//  exactly this seam): ingestRecordRow folds a wire-side presentation into
//  the record by RECORD identity — a re-presentation of an already-recorded
//  row (the OpenAI-family per-request replay shape, fresh wire ids and all)
//  maps to the EXISTING record row and adds nothing. Only a genuinely new
//  record row mints a renderable identity.
//
//  Dev and fixture builds assert continuously: projection(record).identities
//  has no duplicates and equals the settled ledger + live tail exactly.
// ============================================================================

import type { RowIdentity } from './contracts.js'
import type { SettledRowLedger } from './ledger.js'

/** One record row — the session record's unit of transcript truth. */
export interface RecordRow {
  readonly identity: RowIdentity
  /** The record's stable fold key: dialect adapters derive it from durable
   *  wire coordinates (round index + role + position), NEVER from per-request
   *  ids — a replayed presentation refolds to the same key. */
  readonly foldKey: string
  readonly text: string
}

/** The persisted-record shape the projection reads. */
export interface TranscriptRecord {
  readonly rows: readonly RecordRow[]
}

/** The at-most-one in-flight unsettled turn (E10). */
export interface UnsettledTurn {
  readonly identity: RowIdentity
  readonly text: string
}

export interface Projection {
  /** Renderable identities, in order: settled record rows then the live turn. */
  readonly identities: readonly RowIdentity[]
}

/** A mutable record under ingestion — the seam the dialect layer feeds. */
export class RecordIngestion {
  private readonly rows: RecordRow[] = []
  private readonly byFoldKey = new Map<string, RecordRow>()
  private refoldCount = 0

  /**
   * Fold one wire-side presentation into the record. A presentation whose
   * foldKey the record already holds IS that row — the wire's fresh ids mint
   * nothing (the law that kills the doubled-reply class at its root). The
   * return names which way it went.
   */
  ingest(presentation: { foldKey: string; wireId: string; text: string }): {
    row: RecordRow
    outcome: 'recorded' | 'refolded'
  } {
    const existing = this.byFoldKey.get(presentation.foldKey)
    if (existing) {
      this.refoldCount++
      return { row: existing, outcome: 'refolded' }
    }
    const row: RecordRow = Object.freeze({
      identity: `rec-${this.rows.length + 1}-${presentation.foldKey}`,
      foldKey: presentation.foldKey,
      text: presentation.text,
    })
    this.rows.push(row)
    this.byFoldKey.set(row.foldKey, row)
    return { row, outcome: 'recorded' }
  }

  record(): TranscriptRecord {
    return { rows: this.rows.slice() }
  }

  /** Presentations folded onto existing rows (diagnostics). */
  refolds(): number {
    return this.refoldCount
  }
}

/** The pure projection: record × live turn → renderable identities. */
export function project(record: TranscriptRecord, live: UnsettledTurn | null): Projection {
  const identities = record.rows.map(r => r.identity)
  if (live) identities.push(live.identity)
  return { identities }
}

/** Thrown by the armed flatness assertion — a duplicate renderable identity
 *  or a projection/ledger disagreement is an engine-law violation, never a
 *  paint. */
export class FlatnessViolation extends Error {}

/** E10's continuous assertion: no duplicate identities in the projection. */
export function assertFlat(projection: Projection): void {
  const seen = new Set<RowIdentity>()
  for (const id of projection.identities) {
    if (seen.has(id)) {
      throw new FlatnessViolation(`duplicate renderable identity in projection: ${id}`)
    }
    seen.add(id)
  }
}

/**
 * E10's agreement assertion: the projection equals the settled ledger + the
 * live tail exactly — same identities, same order, nothing extra on either
 * side. Runs continuously in dev/fixture drives; stays silent on a lawful
 * session.
 */
export function assertProjectionAgreement(
  projection: Projection,
  ledger: SettledRowLedger,
  live: UnsettledTurn | null,
): void {
  assertFlat(projection)
  const expected: RowIdentity[] = ledger.settledRows().map(r => r.identity)
  if (live) expected.push(live.identity)
  const got = projection.identities
  if (got.length !== expected.length) {
    throw new FlatnessViolation(
      `projection/ledger disagreement: ${got.length} renderables vs ${expected.length} settled+live`,
    )
  }
  for (let i = 0; i < expected.length; i++) {
    if (got[i] !== expected[i]) {
      throw new FlatnessViolation(
        `projection/ledger disagreement at index ${i}: ${got[i]} vs ${expected[i]}`,
      )
    }
  }
}

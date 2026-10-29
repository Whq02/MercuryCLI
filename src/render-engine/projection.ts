
import type { RowIdentity } from './contracts.js'
import type { SettledRowLedger } from './ledger.js'

export interface RecordRow {
  readonly identity: RowIdentity
  readonly foldKey: string
  readonly text: string
}

export interface TranscriptRecord {
  readonly rows: readonly RecordRow[]
}

export interface UnsettledTurn {
  readonly identity: RowIdentity
  readonly text: string
}

export interface Projection {
  readonly identities: readonly RowIdentity[]
}

export class RecordIngestion {
  private readonly rows: RecordRow[] = []
  private readonly byFoldKey = new Map<string, RecordRow>()
  private refoldCount = 0

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

  refolds(): number {
    return this.refoldCount
  }
}

export function project(record: TranscriptRecord, live: UnsettledTurn | null): Projection {
  const identities = record.rows.map(r => r.identity)
  if (live) identities.push(live.identity)
  return { identities }
}

export class FlatnessViolation extends Error {}

export function assertFlat(projection: Projection): void {
  const seen = new Set<RowIdentity>()
  for (const id of projection.identities) {
    if (seen.has(id)) {
      throw new FlatnessViolation(`duplicate renderable identity in projection: ${id}`)
    }
    seen.add(id)
  }
}

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

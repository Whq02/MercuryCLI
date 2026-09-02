// ============================================================================
//  render-engine/ledger.ts — the settled-row ledger (laws E1, E2, E10-edge).
//
//  Settlement is an application decision: the session submits final turn
//  elements as ordered batches with monotonic sequence numbers (E1). Each
//  accepted row is FROZEN — immutable, identity-keyed, appended exactly once
//  — and the ledger never rewrites, rediffs or replays it (E2). A batch seq
//  at or below the accepted high-water mark is acknowledged WITHOUT effect
//  (the retry/coalesce path), so duplication of a settled row is impossible
//  by construction. A row identity already present in the current epoch is
//  DROPPED and counted (an upstream projection fault — E10's flatness law —
//  can lose a copy here but can never gain one); fixture builds arm
//  onFlatnessViolation to turn the drop into a loud stop.
//
//  Width epochs (E7): a resize replay begins a new epoch — the accepted mark
//  resets, rows clear, and the session resubmits everything rendered at the
//  new width with fresh sequence numbers. Batches from a superseded epoch
//  are acknowledged without effect; the ledger never does cross-width row
//  arithmetic.
// ============================================================================

import type { LedgerAck, RowIdentity, SettledBatch, SettledRow } from './contracts.js'

export interface LedgerOptions {
  /** Armed in dev/fixture builds: a fresh-seq batch carrying an identity the
   *  epoch already holds is an upstream projection fault — report it loudly.
   *  The ledger drops the copy either way. */
  onFlatnessViolation?: (identity: RowIdentity, seq: number) => void
}

export class SettledRowLedger {
  private rows: SettledRow[] = []
  private readonly identities = new Set<RowIdentity>()
  private acceptedSeq = 0
  private epoch = 1
  private epochWidth: number
  private droppedCopies = 0

  constructor(
    initialWidth: number,
    private readonly options: LedgerOptions = {},
  ) {
    this.epochWidth = initialWidth
  }

  /** The current width epoch — the session stamps batches with it. */
  widthEpoch(): number {
    return this.epoch
  }

  /** The width the current epoch renders at. */
  width(): number {
    return this.epochWidth
  }

  /** The accepted high-water mark (last accepted seq of the current epoch). */
  acceptedMark(): number {
    return this.acceptedSeq
  }

  /** The next sequence number a session-side submitter may mint. */
  nextSeq(): number {
    return this.acceptedSeq + 1
  }

  /** Total settled rows held for the current epoch. */
  size(): number {
    return this.rows.length
  }

  /** Copies dropped by the flatness edge (diagnostics). */
  flatnessDrops(): number {
    return this.droppedCopies
  }

  /** The frozen row list — the flat projection's settled half. The array is
   *  a fresh copy; the rows inside are frozen objects. */
  settledRows(): readonly SettledRow[] {
    return this.rows.slice()
  }

  /** Row at index (paint feed) — frozen. */
  rowAt(index: number): SettledRow | undefined {
    return this.rows[index]
  }

  /** True when the identity is settled in the current epoch. */
  has(identity: RowIdentity): boolean {
    return this.identities.has(identity)
  }

  /**
   * Submit one ordered settled batch (E1). Acceptance appends every novel
   * row, frozen; a repeated seq or a superseded epoch acknowledges without
   * effect (E2). The ack is the session's receipt — a submitter retries by
   * resubmitting the SAME batch and gets 'repeat' back.
   */
  submit(batch: SettledBatch): LedgerAck {
    if (batch.widthEpoch !== this.epoch) {
      return { kind: 'stale-epoch', seq: batch.seq, currentEpoch: this.epoch }
    }
    if (batch.seq <= this.acceptedSeq) {
      return { kind: 'repeat', seq: batch.seq }
    }
    let novel = 0
    for (const row of batch.rows) {
      if (this.identities.has(row.identity)) {
        this.droppedCopies++
        this.options.onFlatnessViolation?.(row.identity, batch.seq)
        continue
      }
      const frozen: SettledRow = Object.freeze({
        identity: row.identity,
        lines: Object.freeze(row.lines.slice()),
      })
      this.identities.add(frozen.identity)
      this.rows.push(frozen)
      novel++
    }
    this.acceptedSeq = batch.seq
    return { kind: 'accepted', seq: batch.seq, novelRows: novel }
  }

  /**
   * Advance the width WITHOUT a replay (the 'preserve' refresh policy): the
   * epoch bumps so in-flight batches rendered at the old width come back
   * 'stale-epoch' and get re-rendered, while settled rows, identities and
   * the accepted mark all survive — history already painted stays owned,
   * and a late re-submission of an old identity still deduplicates.
   */
  advanceWidth(width: number): number {
    this.epoch++
    this.epochWidth = width
    return this.epoch
  }

  /**
   * Begin a new width epoch (E7 replay — the 'rebuild' refresh policy): the
   * accepted mark resets, rows and identities clear, and the session
   * resubmits at the new width with fresh sequence numbers. What the
   * terminal already holds is the PAINTER's affair per its refresh policy;
   * the ledger holds only current-epoch truth.
   */
  beginWidthEpoch(width: number): number {
    this.epoch++
    this.epochWidth = width
    this.rows = []
    this.identities.clear()
    this.acceptedSeq = 0
    return this.epoch
  }
}

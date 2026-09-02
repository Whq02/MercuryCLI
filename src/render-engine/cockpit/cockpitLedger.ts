// ============================================================================
//  render-engine/cockpit/cockpitLedger.ts — the cockpit's E1/E2/E10 mount:
//  the settled-row ledger fed from the transcript projection.
//
//  The cockpit's renderable list (the Messages projection: normalize →
//  filter → reorder → group → receipts → collapse) is the flat projection
//  of law E10. This owner walks it each commit and submits the STABLE
//  PREFIX — renderables that can never re-derive differently again — to the
//  engine's SettledRowLedger as ordered batches (E1). The ledger freezes
//  them (E2): one identity, one row, duplication impossible by construction,
//  and the continuous agreement assertion (projection prefix ≡ ledger, in
//  order) is the dev/fixture tripwire spec 10 E10 demands.
//
//  STABILITY IS CONSERVATIVE, BY TURN LAG. Grouping and collapse re-derive
//  freely inside the live turn (a grouped_tool_use grows as siblings arrive;
//  collapse regrouping can change derived uuids), so a renderable submits
//  only when at least one WHOLE settled turn stands between it and the live
//  edge. The boundary is the TURN HEAD — the visible user prompt row, the
//  same predicate the turn-receipt injector keys its boundaries on
//  (utils/cockpit/turnReceipt.ts isTurnBoundary): every turn has one,
//  whether or not it used tools. Rows before the lagged head never regroup
//  (a prompt row breaks every collapse adjacency), so a divergence between
//  the fed prefix and the frozen ledger is a real projection fault: counted
//  always, loud when armed.
// ============================================================================

import type { SettledRow } from '../contracts.js'
import { SettledRowLedger } from '../ledger.js'

export interface ProjectedRow {
  readonly uuid: string
  readonly kind: string
  /** The turn boundary: a visible user prompt row (isTurnBoundary). */
  readonly turnHead: boolean
  /** The renderable's text truth (search-text form) — the ledger's frozen
   *  line record for censuses and the resize replay; NOT the paint source
   *  (the cockpit's pane paints through the classic compositor whose cells
   *  the parity gate pins byte-identical). */
  readonly text: string
}

export interface CockpitLedgerReport {
  submitted: number
  settledCount: number
  divergences: number
  flatnessDrops: number
}

export interface CockpitLedgerOptions {
  /** Armed in fixture/dev drives: a prefix divergence or duplicate identity
   *  becomes a loud stop instead of a counter. */
  onViolation?: (detail: string) => void
  /** Whole settled turns kept between the ledger boundary and the live edge
   *  (default 1 — one full turn of hysteresis). */
  turnLag?: number
}

export class CockpitLedger {
  private ledger: SettledRowLedger
  private width: number
  private divergences = 0
  private seq = 0
  private replacements = 0

  constructor(
    width: number,
    private readonly options: CockpitLedgerOptions = {},
  ) {
    this.width = width
    this.ledger = this.freshLedger()
  }

  private freshLedger(): SettledRowLedger {
    return new SettledRowLedger(this.width, {
      onFlatnessViolation: (identity, seq) =>
        this.options.onViolation?.(`duplicate settled identity ${identity} at seq ${seq}`),
    })
  }

  /** HISTORY WAS REPLACED BY THE APPLICATION (a compaction boundary: the
   *  transcript legitimately loses, re-orders and RE-YIELDS rows whose
   *  identities this ledger froze). The frozen truth restarts — a fresh
   *  ledger, fresh seqs, dedupe cleared — exactly the rebuild-replay shape
   *  the engine's width epochs use. Without this, the continuous agreement
   *  and flatness tripwires fire on the FIRST /compact (armed builds die:
   *  "duplicate settled identity … at seq N"), and unarmed builds stop
   *  feeding forever. The E10 laws stay fully armed WITHIN a continuous
   *  history; only an app-declared replacement resets them. */
  resetForReplacement(): void {
    this.replacements++
    this.seq = 0
    this.ledger = this.freshLedger()
  }

  /** Replacements declared so far (diagnostics). */
  historyReplacements(): number {
    return this.replacements
  }

  ledgerRef(): SettledRowLedger {
    return this.ledger
  }

  /** The stable boundary: the index of the turn head that has `turnLag`
   *  whole turns between it and the live turn — everything BEFORE it is at
   *  least `turnLag` settled turns behind the live edge and never regroups. */
  stableBoundary(rows: readonly ProjectedRow[]): number {
    const lag = Math.max(0, this.options.turnLag ?? 1)
    const heads: number[] = []
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.turnHead) heads.push(i)
    }
    const pick = heads.length - 1 - lag
    if (pick < 0) return 0
    return heads[pick]!
  }

  /**
   * Feed one committed projection. Verifies the frozen prefix still agrees
   * (identity-for-identity, in order), then submits newly-stable rows as one
   * ordered batch. Returns the running report.
   */
  feed(rows: readonly ProjectedRow[]): CockpitLedgerReport {
    const boundary = this.stableBoundary(rows)
    const frozen = this.ledger.size()

    // E10 agreement over the frozen prefix: the projection may not reorder,
    // rename or drop what the ledger froze.
    const checkUpTo = Math.min(frozen, rows.length)
    for (let i = 0; i < checkUpTo; i++) {
      const held = this.ledger.rowAt(i)!
      if (held.identity !== rows[i]!.uuid) {
        this.divergences++
        this.options.onViolation?.(
          `projection/ledger disagreement at index ${i}: projection ${rows[i]!.uuid} vs frozen ${held.identity}`,
        )
        // The frozen truth stands; feeding stops at the fault.
        return this.report()
      }
    }
    if (rows.length < frozen) {
      this.divergences++
      this.options.onViolation?.(
        `projection shrank below the frozen prefix: ${rows.length} rows vs ${frozen} frozen`,
      )
      return this.report()
    }

    if (boundary > frozen) {
      const batchRows: SettledRow[] = []
      // Diagnostic pre-scan: name the offending PAIR when an identity in this
      // batch is already frozen or duplicated inside the batch — the bare
      // "duplicate settled identity … at seq N" cost a live hunt three
      // rebuilds; the enriched detail names both rows at the first throw.
      const seen = new Map<string, number>()
      for (let i = 0; i < frozen; i++) seen.set(this.ledger.rowAt(i)!.identity, i)
      for (let i = frozen; i < boundary; i++) {
        const row = rows[i]!
        const at = seen.get(row.uuid)
        if (at !== undefined) {
          this.options.onViolation?.(
            `duplicate settled identity ${row.uuid}: projection index ${i} (${row.kind}: ${JSON.stringify(row.text.slice(0, 80))}) repeats index ${at} (${at < frozen ? 'frozen' : rows[at]!.kind}: ${JSON.stringify((rows[at]?.text ?? this.ledger.rowAt(at)!.lines.join(' ')).slice(0, 80))})`,
          )
        }
        seen.set(row.uuid, i)
        batchRows.push({ identity: row.uuid, lines: row.text.split('\n') })
      }
      this.seq = this.ledger.nextSeq()
      this.ledger.submit({ seq: this.seq, widthEpoch: this.ledger.widthEpoch(), rows: batchRows })
    }
    return this.report()
  }

  /** The resize path (preserve policy): epoch advances, truth kept. */
  advanceWidth(width: number): void {
    this.width = width
    this.ledger.advanceWidth(width)
  }

  report(): CockpitLedgerReport {
    return {
      submitted: this.seq,
      settledCount: this.ledger.size(),
      divergences: this.divergences,
      flatnessDrops: this.ledger.flatnessDrops(),
    }
  }
}


import type { SettledRow } from '../contracts.js'
import { SettledRowLedger } from '../ledger.js'

export interface ProjectedRow {
  readonly uuid: string
  readonly kind: string
  readonly turnHead: boolean
  readonly text: string
}

export interface CockpitLedgerReport {
  submitted: number
  settledCount: number
  divergences: number
  flatnessDrops: number
}

export interface CockpitLedgerOptions {
  onViolation?: (detail: string) => void
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

  resetForReplacement(): void {
    this.replacements++
    this.seq = 0
    this.ledger = this.freshLedger()
  }

  historyReplacements(): number {
    return this.replacements
  }

  ledgerRef(): SettledRowLedger {
    return this.ledger
  }

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

  feed(rows: readonly ProjectedRow[]): CockpitLedgerReport {
    const boundary = this.stableBoundary(rows)
    const frozen = this.ledger.size()

    const checkUpTo = Math.min(frozen, rows.length)
    for (let i = 0; i < checkUpTo; i++) {
      const held = this.ledger.rowAt(i)!
      if (held.identity !== rows[i]!.uuid) {
        this.divergences++
        this.options.onViolation?.(
          `projection/ledger disagreement at index ${i}: projection ${rows[i]!.uuid} vs frozen ${held.identity}`,
        )
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


import type { LedgerAck, RowIdentity, SettledBatch, SettledRow } from './contracts.js'

export interface LedgerOptions {
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

  widthEpoch(): number {
    return this.epoch
  }

  width(): number {
    return this.epochWidth
  }

  acceptedMark(): number {
    return this.acceptedSeq
  }

  nextSeq(): number {
    return this.acceptedSeq + 1
  }

  size(): number {
    return this.rows.length
  }

  flatnessDrops(): number {
    return this.droppedCopies
  }

  settledRows(): readonly SettledRow[] {
    return this.rows.slice()
  }

  rowAt(index: number): SettledRow | undefined {
    return this.rows[index]
  }

  has(identity: RowIdentity): boolean {
    return this.identities.has(identity)
  }

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

  advanceWidth(width: number): number {
    this.epoch++
    this.epochWidth = width
    return this.epoch
  }

  beginWidthEpoch(width: number): number {
    this.epoch++
    this.epochWidth = width
    this.rows = []
    this.identities.clear()
    this.acceptedSeq = 0
    return this.epoch
  }
}

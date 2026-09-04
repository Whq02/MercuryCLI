import { logForDebugging } from 'src/utils/debug.js'
import { fluxCount } from '../../utils/flux/fluxProbe.js'

export type ContaminationReason =
  | 'selection-overlay'
  | 'search-overlay'
  | 'undelivered'
  | 'blank-reset'
  | 'self-heal'
  | 'force-redraw'
  | 'stderr-leak'
  | 'overlay-unmount'
  | 'takeover'

export class FrameLedger {
  private frameSeq = 0
  private frontFrameSeq = 0
  private deliveredSeq = 0
  private contamination: ContaminationReason | null = null
  private staleWarned = false

  assertBaseDeliverable(): void {
    if (this.frontFrameSeq !== this.deliveredSeq && this.contamination === null) {
      fluxCount('stale-frame-risk')
      if (!this.staleWarned) {
        this.staleWarned = true
        logForDebugging(
          '[ink] S8 integrity: diff base was never delivered and contamination is unset (stale-paint risk)',
          { level: 'warn' },
        )
      }
    }
  }

  commitFrame(changed = true): void {
    if (!changed) {
      fluxCount('frame-recommit')
      return
    }
    this.frontFrameSeq = ++this.frameSeq
  }

  settle(delivered: boolean, contaminate: ContaminationReason | null): void {
    if (delivered) this.deliveredSeq = this.frontFrameSeq
    this.contamination = contaminate ?? (delivered ? null : 'undelivered')
  }

  syncAfterDeliberateReset(): void {
    this.frontFrameSeq = this.deliveredSeq
  }

  contaminate(reason: ContaminationReason): void {
    this.contamination = reason
  }

  isContaminated(): boolean {
    return this.contamination !== null
  }

  contaminationReason(): ContaminationReason | null {
    return this.contamination
  }

  frontSeq(): number {
    return this.frontFrameSeq
  }

  deliveredGeneration(): number {
    return this.deliveredSeq
  }
}

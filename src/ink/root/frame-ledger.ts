// ============================================================================
//  frame-ledger.ts — T6: the frame-generation ledger.
//
//  One owner for the S8 integrity vocabulary that would otherwise live in five
//  mutated instance booleans: every composed frame gets a monotonic
//  sequence; the diff's BASE (frontFrame) must be the frame the terminal
//  actually DISPLAYS — the last delivered write — or the contamination
//  flag must already be set (full re-emit next). A violation is the
//  STALE-PAINT ghost class: patches against rows the terminal never
//  received. Asserted per frame, counted on the probe ring
//  ('stale-frame-risk'), logged once — never throws in the renderer.
//
//  Contamination is now a TYPED CAUSE, not a boolean — every site that used
//  to flip `prevFrameContaminated = true` names why, and the probe ring can
//  attribute the next full re-emit.
// ============================================================================
import { logForDebugging } from 'src/utils/debug.js'
import { fluxCount } from '../../utils/flux/fluxProbe.js'

/** Why the previous frame model can never be trusted as a diff base. */
export type ContaminationReason =
  | 'selection-overlay' // overlay cells painted over the committed grid
  | 'search-overlay'
  | 'undelivered' // the write loop reported the frame never landed
  | 'blank-reset' // a deliberate blank-prev reset (resume/repaint/alt-reset)
  | 'self-heal' // the ≥30s idle-gap full re-emit
  | 'force-redraw' // ctrl+l — the synchronous ERASE+HOME path
  | 'stderr-leak' // a stray stderr write may have corrupted the display
  | 'overlay-unmount' // invalidatePrevFrame one-shot
  | 'takeover' // launcher alt-hold handed the buffer over mid-boot

export class FrameLedger {
  private frameSeq = 0
  private frontFrameSeq = 0
  private deliveredSeq = 0
  private contamination: ContaminationReason | null = null
  private staleWarned = false

  /** The S8 assertion — run BEFORE composing a diff against frontFrame.
   *  Never throws; counts + warns once. */
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

  /** A new frame became frontFrame. */
  commitFrame(): void {
    this.frontFrameSeq = ++this.frameSeq
  }

  /** Settle the write outcome: delivery advances the delivered generation;
   *  the NEXT frame's contamination is exactly what this frame caused
   *  (overlay paint, failed delivery) — or clean. */
  settle(delivered: boolean, contaminate: ContaminationReason | null): void {
    if (delivered) this.deliveredSeq = this.frontFrameSeq
    this.contamination = contaminate ?? (delivered ? null : 'undelivered')
  }

  /** A deliberate frame-model reset (resume-main, repaint, alt blank-reset,
   *  line-count epoch): the generations sync so the reset never reads as a
   *  stale base. */
  syncAfterDeliberateReset(): void {
    this.frontFrameSeq = this.deliveredSeq
  }

  /** An external event invalidated the display model (stderr leak, overlay
   *  unmount, takeover, self-heal): the next diff must full re-emit. */
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

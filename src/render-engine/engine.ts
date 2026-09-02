// ============================================================================
//  render-engine/engine.ts — the assembled paint engine.
//
//  One engine instance owns: the settled-row ledger (E1/E2), the bounded
//  live tail (E3), the one write door (E4), cost-and-drain scheduling
//  (E5/E6), the resize settle gate (E7), transient-surface discipline (E8),
//  and the per-frame cost bound (E11). The host feeds it settlements, tail
//  updates, keystrokes and WINCH events; every terminal byte leaves through
//  the door.
//
//  The engine is flag-gated plumbing (MERCURY_RENDER_ENGINE): while the flag
//  is off no product surface constructs it, and the classic painter runs
//  byte-identically. The migration lane mounts the cockpit's surfaces onto
//  this seam; nothing here mounts them itself.
//
//  Attach contract: the terminal cursor sits at column 0 on a fresh row and
//  everything below it belongs to the engine. From then on the engine is the
//  ONLY writer on the channel.
// ============================================================================

import { BSU, ENTER_ALT_SCREEN, ESU, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../ink/termio/dec.js'
import { CURSOR_HOME, eraseToEndOfLine } from '../ink/termio/csi.js'
import { clampRowToWidth } from './ansiText.js'
import { composeTailBlock } from './compose.js'
import type {
  EngineClock,
  EngineMetrics,
  EngineProfile,
  LedgerAck,
  OverlayInput,
  SettledBatch,
  TailInput,
  Viewport,
} from './contracts.js'
import { EMPTY_TAIL, REAL_ENGINE_CLOCK } from './contracts.js'
import type { DoorSyscalls } from './door.js'
import { WriteDoor } from './door.js'
import { InlineTailPainter } from './inlinePainter.js'
import { SettledRowLedger } from './ledger.js'
import { ResizeSettleGate } from './resizeSettle.js'
import type { PaintKind } from './scheduler.js'
import { PaintScheduler } from './scheduler.js'

const SGR_RESET = '\x1b[0m'

export interface RenderEngineOptions {
  syscalls: DoorSyscalls
  viewport: Viewport
  profile: EngineProfile
  clock?: EngineClock
  /** Fixture builds arm this to turn a flatness drop into a loud stop. */
  onFlatnessViolation?: (identity: string, seq: number) => void
  /** Fixture seam: deterministic frame cost per kind (E5 provers drive the
   *  adaptive floor without wall-clock coupling). */
  frameCostForTest?: (kind: PaintKind) => number
  /** The choke bound (E6): order 256KB by default; a known-slow terminal
   *  class may tighten it. */
  chokeHighWaterBytes?: number
}

export class RenderEngine {
  private readonly clock: EngineClock
  private readonly door: WriteDoor
  private readonly ledger: SettledRowLedger
  private readonly painter = new InlineTailPainter()
  private readonly scheduler: PaintScheduler
  private readonly resizeGate: ResizeSettleGate
  private viewport: Viewport
  private profile: EngineProfile
  private tail: TailInput = EMPTY_TAIL
  private overlay: OverlayInput | null = null
  private fullscreenOpen = false
  private emittedRows = 0
  private detached = false
  private readonly m: EngineMetrics = {
    framesComposed: 0,
    framesDeferredByChoke: 0,
    framesDeferredByCostFloor: 0,
    settledRowsAppended: 0,
    settledLineWrites: 0,
    tailRowWrites: 0,
    flatnessViolationsDropped: 0,
    holdingPaints: 0,
    settledReflows: 0,
    bracketsOpened: 0,
    bracketsClosed: 0,
  }

  constructor(private readonly options: RenderEngineOptions) {
    this.clock = options.clock ?? REAL_ENGINE_CLOCK
    this.viewport = options.viewport
    this.profile = options.profile
    this.door = new WriteDoor(options.syscalls, this.clock)
    this.ledger = new SettledRowLedger(options.viewport.cols, {
      onFlatnessViolation: (identity, seq) => {
        this.m.flatnessViolationsDropped++
        options.onFlatnessViolation?.(identity, seq)
      },
    })
    this.scheduler = new PaintScheduler({
      paint: kind => this.paint(kind),
      owedBytes: () => this.door.owedBytes(),
      clock: this.clock,
      chokeHighWaterBytes: options.chokeHighWaterBytes,
    })
    this.resizeGate = new ResizeSettleGate(this.clock, e => {
      if (e.kind === 'storm-entered') {
        this.scheduler.hold()
        this.m.holdingPaints++
        // The cheap holding paint: the last frame stays in place — the
        // cheapest holding frame there is; stream deltas keep landing in
        // the model underneath (spec 04 permits exactly this).
        return
      }
      if (e.kind === 'storm-continues') return
      this.settleResize(e.cols, e.rows)
    })
  }

  // ── the session-facing seam ───────────────────────────────────────────────

  /** The ledger's monotonic sequence source for session-side submitters. */
  nextSeq(): number {
    return this.ledger.nextSeq()
  }

  /** The current width epoch (stamped onto batches by the submitter). */
  widthEpoch(): number {
    return this.ledger.widthEpoch()
  }

  /** The width settled batches render at. */
  settleWidth(): number {
    return this.ledger.width()
  }

  /** Submit one settled batch (E1). Acceptance schedules a paint; repeats
   *  and stale epochs acknowledge without painting (E2). */
  submitSettled(batch: SettledBatch): LedgerAck {
    const ack = this.ledger.submit(batch)
    if (ack.kind === 'accepted' && ack.novelRows > 0) {
      this.m.settledRowsAppended += ack.novelRows
      this.scheduler.request()
    }
    return ack
  }

  /** Replace live-tail parts (E3). Streaming, tool and status changes ride
   *  the normal demand lane. */
  updateTail(patch: Partial<TailInput>): void {
    this.tail = { ...this.tail, ...patch }
    this.scheduler.request()
  }

  /** Composer echo: the keystroke lane — immediate paint priority (E5). */
  noteKeystroke(patch?: Partial<TailInput>): void {
    if (patch) this.tail = { ...this.tail, ...patch }
    this.scheduler.requestInput()
  }

  /** Open a transient surface (E8). Non-fullscreen surfaces composite over
   *  the live tail; fullscreen surfaces borrow the alternate screen whole
   *  and settled history stays untouched either way. */
  openOverlay(overlay: OverlayInput): void {
    this.overlay = overlay
    if (overlay.fullscreen) {
      this.fullscreenOpen = true
      this.scheduler.hold()
      this.door.enqueue({ kind: 'mode', bytes: ENTER_ALT_SCREEN })
      this.paintFullscreen(overlay)
      return
    }
    this.scheduler.request()
  }

  /** Repaint an open fullscreen surface's content. */
  updateFullscreen(overlay: OverlayInput): void {
    if (!this.fullscreenOpen || !overlay.fullscreen) return
    this.overlay = overlay
    this.paintFullscreen(overlay)
  }

  /** Close the transient surface: the tail repaints; history bytes never
   *  moved (E8). */
  closeOverlay(): void {
    const wasFullscreen = this.fullscreenOpen
    this.overlay = null
    this.fullscreenOpen = false
    if (wasFullscreen) {
      this.door.enqueue({ kind: 'mode', bytes: EXIT_ALT_SCREEN })
      this.scheduler.release()
    }
    this.scheduler.request()
  }

  /** Feed one WINCH (E7): storms hold reflow; quiet settles once. */
  winch(cols: number, rows: number): void {
    this.resizeGate.winch(cols, rows)
  }

  /** Teardown: one restore unit through the door, flushed with a bounded
   *  budget so a killed paint can never leave the terminal frozen (E4's
   *  bracket law on the exit path; spec 03's teardown close). */
  detach(): void {
    if (this.detached) return
    this.detached = true
    this.scheduler.cancel()
    this.resizeGate.cancel()
    let restore = ''
    if (this.fullscreenOpen) restore += EXIT_ALT_SCREEN
    restore += SGR_RESET + SHOW_CURSOR
    if (this.profile.syncOutput) restore += ESU // closes a bracket a crash left open
    this.door.enqueue({ kind: 'teardown', bytes: restore })
    this.door.flushSync()
  }

  // ── probe ports ───────────────────────────────────────────────────────────

  metrics(): Readonly<EngineMetrics> {
    const s = this.scheduler.metrics()
    this.m.framesDeferredByChoke = s.chokeDeferrals
    this.m.framesDeferredByCostFloor = s.floorDeferrals
    return this.m
  }

  ledgerRef(): SettledRowLedger {
    return this.ledger
  }

  doorRef(): WriteDoor {
    return this.door
  }

  profileRef(): EngineProfile {
    return this.profile
  }

  // ── the paint pipeline ────────────────────────────────────────────────────

  /** Compose + enqueue one frame; returns the frame's compose cost (ms). */
  private paint(kind: PaintKind): number {
    if (this.detached || this.fullscreenOpen) return 0
    const t0 = this.clock.now()

    // Settled lines not yet painted: frozen bytes, flattened once, appended
    // once. Composition cost is a function of the live tail + the new lines
    // only — settled rows already painted never pass through here (E11).
    const settled: string[] = []
    const total = this.ledger.size()
    for (let i = this.emittedRows; i < total; i++) {
      const row = this.ledger.rowAt(i)!
      for (const line of row.lines) settled.push(clampRowToWidth(line, this.viewport.cols))
    }

    const composed = composeTailBlock(this.tail, this.overlay, this.viewport)
    const result = this.painter.paint(settled, composed.rows, composed.park, {
      forceRepaint: kind === 'settled',
    })
    this.emittedRows = total

    if (result.body !== '') {
      const bytes = this.profile.syncOutput ? BSU + result.body + ESU : result.body
      if (this.profile.syncOutput) {
        this.m.bracketsOpened++
        this.m.bracketsClosed++
      }
      this.door.enqueue({ kind: 'frame', bytes })
    }
    this.m.framesComposed++
    this.m.settledLineWrites += result.settledLinesWritten
    this.m.tailRowWrites += result.tailRowsWritten

    const measured = this.clock.now() - t0
    return this.options.frameCostForTest?.(kind) ?? measured
  }

  /** Fullscreen surface paint: home + rows, erase-to-line-end per row — the
   *  alternate screen owns the whole viewport while borrowed. */
  private paintFullscreen(overlay: OverlayInput): void {
    const EL = eraseToEndOfLine()
    let body = CURSOR_HOME
    const rows = overlay.rows.slice(0, this.viewport.rows)
    for (let i = 0; i < rows.length; i++) {
      body += EL + clampRowToWidth(rows[i]!, this.viewport.cols) + SGR_RESET
      if (i < rows.length - 1) body += '\r\n'
    }
    const bytes = this.profile.syncOutput ? BSU + body + ESU : body
    if (this.profile.syncOutput) {
      this.m.bracketsOpened++
      this.m.bracketsClosed++
    }
    this.door.enqueue({ kind: 'frame', bytes })
  }

  /** The one settled reflow after a storm's quiet (E7): the viewport takes
   *  the final size, in-flight old-width batches will come back stale-epoch,
   *  and the tail repaints whole at the new width. History already painted
   *  stays as the terminal holds it (the inline 'preserve' policy). */
  private settleResize(cols: number, rows: number): void {
    this.viewport = { cols, rows }
    this.ledger.advanceWidth(cols)
    // The settled paint force-repaints the block IN PLACE: own rows are
    // erased/rewritten at the new width (EL-clear own rows + repaint), and
    // history already painted stays as the terminal holds it — the inline
    // 'preserve' refresh policy.
    this.m.settledReflows++
    this.scheduler.paintSettled()
  }
}

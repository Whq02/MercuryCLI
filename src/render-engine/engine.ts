
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
  onFlatnessViolation?: (identity: string, seq: number) => void
  frameCostForTest?: (kind: PaintKind) => number
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
        return
      }
      if (e.kind === 'storm-continues') return
      this.settleResize(e.cols, e.rows)
    })
  }


  nextSeq(): number {
    return this.ledger.nextSeq()
  }

  widthEpoch(): number {
    return this.ledger.widthEpoch()
  }

  settleWidth(): number {
    return this.ledger.width()
  }

  submitSettled(batch: SettledBatch): LedgerAck {
    const ack = this.ledger.submit(batch)
    if (ack.kind === 'accepted' && ack.novelRows > 0) {
      this.m.settledRowsAppended += ack.novelRows
      this.scheduler.request()
    }
    return ack
  }

  updateTail(patch: Partial<TailInput>): void {
    this.tail = { ...this.tail, ...patch }
    this.scheduler.request()
  }

  noteKeystroke(patch?: Partial<TailInput>): void {
    if (patch) this.tail = { ...this.tail, ...patch }
    this.scheduler.requestInput()
  }

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

  updateFullscreen(overlay: OverlayInput): void {
    if (!this.fullscreenOpen || !overlay.fullscreen) return
    this.overlay = overlay
    this.paintFullscreen(overlay)
  }

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

  winch(cols: number, rows: number): void {
    this.resizeGate.winch(cols, rows)
  }

  detach(): void {
    if (this.detached) return
    this.detached = true
    this.scheduler.cancel()
    this.resizeGate.cancel()
    let restore = ''
    if (this.fullscreenOpen) restore += EXIT_ALT_SCREEN
    restore += SGR_RESET + SHOW_CURSOR
    if (this.profile.syncOutput) restore += ESU
    this.door.enqueue({ kind: 'teardown', bytes: restore })
    this.door.flushSync()
  }


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


  private paint(kind: PaintKind): number {
    if (this.detached || this.fullscreenOpen) return 0
    const t0 = this.clock.now()

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

  private settleResize(cols: number, rows: number): void {
    this.viewport = { cols, rows }
    this.ledger.advanceWidth(cols)
    this.m.settledReflows++
    this.scheduler.paintSettled()
  }
}

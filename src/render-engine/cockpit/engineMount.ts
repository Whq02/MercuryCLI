
import type { Writable } from 'node:stream'
import { CADENCE_MS, CHOKE_HIGH_WATER_BYTES, CHOKE_RETRY_MS, COST_FLOOR_CAP_MS } from '../scheduler.js'

export { CHOKE_RETRY_MS }
import { ResizeSettleGate } from '../resizeSettle.js'
import { StreamBodyCache } from '../stablePrefix.js'
import { renderEngineEnabled } from '../flag.js'
import { CockpitLedger } from './cockpitLedger.js'
import { MarkdownBlockBoundary } from './markdownBoundary.js'
import { RecordFold } from './recordFold.js'
import { bindTerminalDoor, terminalOwedBytes, unbindTerminalDoor } from './terminalOut.js'

export interface CockpitEngineMetrics {
  paints: number
  inputPaints: number
  chokeDeferrals: number
  floorDeferrals: number
  historyReplacements: number
  keystrokes: number
  winchStorms: number
  winchSettles: number
  refolds: number
  ledgerDivergences: number
  ledgerRows: number
  overlayOpens: number
  fullscreenOverlayOpens: number
}

export interface CockpitEngine {
  choked(): boolean
  floorMs(): number
  notePaintCost(ms: number, kind: 'normal' | 'input'): void
  noteKeystroke(): void
  consumeInputPriority(): boolean
  noteDeferral(kind: 'choke' | 'floor'): void

  armResize(hooks: { onStormEntered: () => void; onSettle: (cols: number, rows: number) => void }): void
  winch(cols: number, rows: number): boolean
  inResizeStorm(): boolean

  readonly ledger: CockpitLedger
  readonly fold: RecordFold
  noteHistoryReplaced(): void

  readonly streamBody: StreamBodyCache

  noteOverlay(open: boolean, fullscreen: boolean): void

  metrics(): Readonly<CockpitEngineMetrics>
  detach(): void
}

let mounted: CockpitEngine | null = null

export function installCockpitEngineForTest(engine: CockpitEngine | null): void {
  mounted = engine
}

export function cockpitEngine(): CockpitEngine | null {
  return mounted
}

export function engineAssertionsArmed(): boolean {
  return process.env.MERCURY_ENGINE_ASSERT === '1'
}

export interface MountOptions {
  stdout: Writable & { isTTY?: boolean; fd?: number }
  columns: number
  syncOutputNow?: () => boolean
  chokeHighWaterBytes?: number
}

export function mountCockpitEngine(options: MountOptions): CockpitEngine | null {
  if (!renderEngineEnabled()) return null
  if (options.stdout.isTTY !== true || typeof options.stdout.fd !== 'number') return null
  if (mounted !== null) return mounted

  bindTerminalDoor(options.stdout)
  const highWater = options.chokeHighWaterBytes ?? CHOKE_HIGH_WATER_BYTES
  const loud = engineAssertionsArmed()
  const violation = (detail: string): void => {
    if (loud) throw new Error(`[render-engine cockpit] ${detail}`)
  }

  const m: CockpitEngineMetrics = {
    paints: 0,
    inputPaints: 0,
    chokeDeferrals: 0,
    floorDeferrals: 0,
    historyReplacements: 0,
    keystrokes: 0,
    winchStorms: 0,
    winchSettles: 0,
    refolds: 0,
    ledgerDivergences: 0,
    ledgerRows: 0,
    overlayOpens: 0,
    fullscreenOverlayOpens: 0,
  }

  let lastCost = 0
  let inputLatch = false
  let resizeGate: ResizeSettleGate | null = null
  let resizeHooks: { onStormEntered: () => void; onSettle: (cols: number, rows: number) => void } | null = null

  const ledger = new CockpitLedger(options.columns, {
    onViolation: detail => {
      m.ledgerDivergences++
      violation(detail)
    },
  })
  const fold = new RecordFold({
    onRefold: (foldKey, firstUuid, freshUuid) => {
      m.refolds++
      violation(`refold at ${foldKey}: ${freshUuid} re-presented ${firstUuid}`)
    },
  })
  const streamBody = new StreamBodyCache(
    (text, width) => {
      const rows: string[] = []
      for (const line of text.split('\n')) {
        if (line.length <= width) rows.push(line)
        else for (let i = 0; i < line.length; i += width) rows.push(line.slice(i, i + width))
      }
      return rows
    },
    new MarkdownBlockBoundary(),
  )

  const engine: CockpitEngine = {
    choked: () => terminalOwedBytes() > highWater,
    floorMs: () => Math.max(CADENCE_MS, Math.min(2 * lastCost, COST_FLOOR_CAP_MS)),
    notePaintCost: (ms, kind) => {
      lastCost = ms
      m.paints++
      if (kind === 'input') m.inputPaints++
    },
    noteKeystroke: () => {
      m.keystrokes++
      inputLatch = true
    },
    consumeInputPriority: () => {
      const was = inputLatch
      inputLatch = false
      return was
    },
    noteDeferral: kind => {
      if (kind === 'choke') m.chokeDeferrals++
      else m.floorDeferrals++
    },
    armResize: hooks => {
      resizeHooks = hooks
      resizeGate = new ResizeSettleGate(
        {
          now: () => Date.now(),
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
        },
        e => {
          if (e.kind === 'storm-entered') {
            m.winchStorms++
            resizeHooks?.onStormEntered()
            return
          }
          if (e.kind === 'storm-continues') return
          m.winchSettles++
          ledger.advanceWidth(e.cols)
          resizeHooks?.onSettle(e.cols, e.rows)
        },
      )
    },
    winch: (cols, rows) => {
      if (resizeGate === null) return false
      resizeGate.winch(cols, rows)
      return true
    },
    inResizeStorm: () => resizeGate?.inStorm() ?? false,
    ledger,
    fold,
    noteHistoryReplaced: () => {
      m.historyReplacements++
      ledger.resetForReplacement()
    },
    streamBody,
    noteOverlay: (open, fullscreen) => {
      if (!open) return
      m.overlayOpens++
      if (fullscreen) m.fullscreenOverlayOpens++
    },
    metrics: () => {
      m.ledgerRows = ledger.report().settledCount
      return m
    },
    detach: () => {
      resizeGate?.cancel()
      unbindTerminalDoor()
      mounted = null
    },
  }
  mounted = engine
  return engine
}

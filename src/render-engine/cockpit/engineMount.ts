// ============================================================================
//  render-engine/cockpit/engineMount.ts — the cockpit's engine mount: the
//  flag-gated assembly that puts the engine's laws under the cockpit painter
//  (the amendment: THE COCKPIT STAYS — an engine swap under an
//  unchanged screen).
//
//  The engine core is presentation-strategy-agnostic; the cockpit's pane
//  painter is the classic ink compositor driving the SAME substrate:
//    · ONE DOOR (E4) — terminalOut binds the WriteDoor to the TTY fd; every
//      frame, mode toggle, pointer byte, probe and bell rides it whole.
//    · SCHEDULING FOLLOWS COST (E5) + CHOKE (E6) — the ink scheduler
//      consults these gates: adaptive floor max(cadence, 2×C) cap 200ms,
//      composition deferred while the door owes past high water, keystroke
//      demands bypass the floor.
//    · RESIZE STORM (E7) — WINCH feeds the engine's settle gate; one settled
//      repaint after 120ms quiet (the 'preserve' refresh policy).
//    · SETTLED TRUTH (E1/E2/E10) — the CockpitLedger freezes the projection's
//      stable prefix; the RecordFold guards the dialect seam.
//    · STREAM BODY (spec 02) — one StreamBodyCache over the product's
//      markdown boundary.
//
//  Probe-once law: the mount SENDS NO CAPABILITY PROBE. The ink session's
//  querier already probes 2026 once at boot; the mount adopts that latch as
//  its EngineProfile through an injected thunk — one probe per attach,
//  product-wide, exactly as spec 03 demands.
//
//  Flag OFF: mountCockpitEngine is never called; every gate reads null and
//  the classic paths run byte-identically.
// ============================================================================

import type { Writable } from 'node:stream'
import { CADENCE_MS, CHOKE_HIGH_WATER_BYTES, CHOKE_RETRY_MS, COST_FLOOR_CAP_MS } from '../scheduler.js'

/** The choke retry quantum (E6), re-exported at the mount seam — product
 *  consumers import the engine ONLY through the mount (the dormancy law's
 *  import rule). */
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
  // ── scheduler gates (E5/E6) ─────────────────────────────────────────────
  /** True while composition must be deferred (door owed > high water). */
  choked(): boolean
  /** The adaptive floor for NORMAL demands: max(cadence, 2×lastCost) cap
   *  200ms. Input demands keep the plain cadence. */
  floorMs(): number
  /** The frame's measured cost lands here after every paint. */
  notePaintCost(ms: number, kind: 'normal' | 'input'): void
  /** A keystroke arrived: the next frame request rides the input lane. */
  noteKeystroke(): void
  /** Consume the input-priority latch (the scheduler's next request). */
  consumeInputPriority(): boolean
  /** A gate held a composition back (the scheduler reports; the mount counts). */
  noteDeferral(kind: 'choke' | 'floor'): void

  // ── resize (E7) ────────────────────────────────────────────────────────
  /** Arm the storm gate with the painter's callbacks (once, at attach). */
  armResize(hooks: { onStormEntered: () => void; onSettle: (cols: number, rows: number) => void }): void
  /** Feed one WINCH. Returns true when the gate consumed it (armed). */
  winch(cols: number, rows: number): boolean
  /** Storm state (the holding-paint decision reads it). */
  inResizeStorm(): boolean

  // ── settled truth (E1/E2/E10) ──────────────────────────────────────────
  readonly ledger: CockpitLedger
  readonly fold: RecordFold
  /** The app REPLACED transcript history (compaction boundary): the frozen
   *  ledger truth restarts so re-yielded identities are recordings, not
   *  duplicates. */
  noteHistoryReplaced(): void

  // ── stream body (spec 02) ──────────────────────────────────────────────
  readonly streamBody: StreamBodyCache

  // ── surfaces (E8 bookkeeping) ──────────────────────────────────────────
  noteOverlay(open: boolean, fullscreen: boolean): void

  // ── probe ports ────────────────────────────────────────────────────────
  metrics(): Readonly<CockpitEngineMetrics>
  detach(): void
}

let mounted: CockpitEngine | null = null

/** Prover seam: install a synthetic mount (clock-driven gate tests) or
 *  clear it. Never called by product code. */
export function installCockpitEngineForTest(engine: CockpitEngine | null): void {
  mounted = engine
}

/** The live mount, or null (flag off, or not yet attached). Every consumer
 *  treats null as "classic path, unchanged". */
export function cockpitEngine(): CockpitEngine | null {
  return mounted
}

/** Fixture/dev tripwires armed? (MERCURY_ENGINE_ASSERT=1 — prover drives.) */
export function engineAssertionsArmed(): boolean {
  return process.env.MERCURY_ENGINE_ASSERT === '1'
}

export interface MountOptions {
  stdout: Writable & { isTTY?: boolean; fd?: number }
  columns: number
  /** The session's sync-output latch (the querier's probe truth) — adopted,
   *  never re-probed. Present for the doctor surface; the door carries
   *  brackets composed upstream either way. */
  syncOutputNow?: () => boolean
  chokeHighWaterBytes?: number
}

/**
 * Mount the cockpit engine (the ink attach seam calls this when the flag is
 * on and stdout is a real TTY). Idempotent per stream; a re-mount after
 * detach rebuilds cleanly.
 */
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
      // The engine cache's row model: plain wrapped lines at width (the
      // bookkeeping form; the PANE's cells come from the classic compositor,
      // pinned byte-identical by the parity gate).
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
          // The 'preserve' refresh policy (E7): the epoch advances so any
          // in-flight old-width batch acks stale; frozen truth is kept.
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

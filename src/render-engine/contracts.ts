// ============================================================================
//  render-engine/contracts.ts — the paint engine's shared types.
//
//  The render engine is the flag-gated NEW painter (MERCURY_RENDER_ENGINE):
//  a settled-row ledger feeding a damage-only painter through one write door,
//  scheduled by cost and terminal drain. The engine laws it embodies are
//  E1–E8, E10, E11 of the REPL overhaul spec (uxparity 10) as amended by
//  the ruling (uxparity 11: the cockpit is the presentation; settled
//  rows are frozen renderables painted once, never a scrollback mandate).
//  Nothing in the product consults this module while the flag is off.
// ============================================================================

/** The record row's identity — one settled renderable per identity, ever.
 *  Identities come from the SESSION RECORD (E10: renderables mint only from
 *  record rows; wire-replay bookkeeping lives below the record and never
 *  mints identities). */
export type RowIdentity = string

/** One settled renderable: physical rows rendered at the submission width.
 *  Settlement is an APPLICATION decision (E1) — the session renders a final
 *  turn element at current width and submits; nothing else ever settles
 *  content (not scroll position, not viewport pressure, not time). */
export interface SettledRow {
  readonly identity: RowIdentity
  /** The rendered physical lines, each clamped to the epoch's width. */
  readonly lines: readonly string[]
}

/** One ordered settled batch. `seq` is monotonic per width epoch; a seq at
 *  or below the ledger's accepted mark is acknowledged WITHOUT effect (E2 —
 *  the retry/coalesce path). */
export interface SettledBatch {
  readonly seq: number
  readonly widthEpoch: number
  readonly rows: readonly SettledRow[]
}

export type LedgerAck =
  /** Appended: these rows are frozen now and paint exactly once. */
  | { readonly kind: 'accepted'; readonly seq: number; readonly novelRows: number }
  /** seq at/below the accepted mark — acknowledged, nothing written. */
  | { readonly kind: 'repeat'; readonly seq: number }
  /** A batch rendered for a superseded width epoch — acknowledged, nothing
   *  written; the session re-renders at the current width and resubmits. */
  | { readonly kind: 'stale-epoch'; readonly seq: number; readonly currentEpoch: number }

/** The live tail's composed inputs (E3): the streaming turn's unsettled
 *  body, the running-tool surface, the composer, and the status strip. The
 *  HOST renders parts to rows; the ENGINE bounds, diffs, schedules and
 *  writes them. Rows are styled strings; the engine clamps each to the
 *  viewport width before painting. */
export interface TailInput {
  readonly streamRows: readonly string[]
  readonly toolRows: readonly string[]
  readonly composerRows: readonly string[]
  readonly statusRows: readonly string[]
  /** Cursor park target: row offset relative to the COMPOSER's first row
   *  plus a 0-based column. Null parks at the block's end. */
  readonly cursor: { readonly rowOffset: number; readonly col: number } | null
}

export const EMPTY_TAIL: TailInput = {
  streamRows: [],
  toolRows: [],
  composerRows: [],
  statusRows: [],
  cursor: null,
}

/** A transient surface compositing over the live tail (E8). Fullscreen
 *  surfaces borrow the alternate screen instead; either way settled history
 *  bytes stay untouched. */
export interface OverlayInput {
  readonly rows: readonly string[]
  readonly fullscreen: boolean
}

/** The capability profile the engine paints against — probed ONCE at attach
 *  (spec 03), never re-negotiated mid-session. An Apple-Terminal-class
 *  profile withholds the probe entirely (that terminal family consumes the
 *  DECRQM query as garbage), leaving sync off with zero 2026 bytes ever
 *  written. */
export interface EngineProfile {
  /** Synchronized output (DEC private mode 2026): armed wraps every frame
   *  unit in one begin/end pair; off writes zero 2026 bytes. */
  readonly syncOutput: boolean
  /** The one-line reason the doctor surface reports. */
  readonly syncWhy: string
}

/** A logical unit through the write door (E4): enqueued whole, delivered
 *  whole, in order. Brackets open and close INSIDE one unit on every path
 *  including teardown, so no sequence is ever split across the door. */
export interface Unit {
  readonly kind: 'frame' | 'mode' | 'probe' | 'bell' | 'teardown'
  readonly bytes: string
}

/** Viewport geometry. */
export interface Viewport {
  readonly cols: number
  readonly rows: number
}

/** Injectable clock — provers drive every timer deterministically. */
export interface EngineClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

export const REAL_ENGINE_CLOCK: EngineClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
}

/** Engine metrics — the provers' observation port. Counters only; nothing
 *  here drives behaviour. */
export interface EngineMetrics {
  framesComposed: number
  framesDeferredByChoke: number
  framesDeferredByCostFloor: number
  settledRowsAppended: number
  settledLineWrites: number
  tailRowWrites: number
  flatnessViolationsDropped: number
  holdingPaints: number
  settledReflows: number
  bracketsOpened: number
  bracketsClosed: number
}

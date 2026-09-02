
export type RowIdentity = string

export interface SettledRow {
  readonly identity: RowIdentity
  readonly lines: readonly string[]
}

export interface SettledBatch {
  readonly seq: number
  readonly widthEpoch: number
  readonly rows: readonly SettledRow[]
}

export type LedgerAck =
  | { readonly kind: 'accepted'; readonly seq: number; readonly novelRows: number }
  | { readonly kind: 'repeat'; readonly seq: number }
  | { readonly kind: 'stale-epoch'; readonly seq: number; readonly currentEpoch: number }

export interface TailInput {
  readonly streamRows: readonly string[]
  readonly toolRows: readonly string[]
  readonly composerRows: readonly string[]
  readonly statusRows: readonly string[]
  readonly cursor: { readonly rowOffset: number; readonly col: number } | null
}

export const EMPTY_TAIL: TailInput = {
  streamRows: [],
  toolRows: [],
  composerRows: [],
  statusRows: [],
  cursor: null,
}

export interface OverlayInput {
  readonly rows: readonly string[]
  readonly fullscreen: boolean
}

export interface EngineProfile {
  readonly syncOutput: boolean
  readonly syncWhy: string
}

export interface Unit {
  readonly kind: 'frame' | 'mode' | 'probe' | 'bell' | 'teardown'
  readonly bytes: string
}

export interface Viewport {
  readonly cols: number
  readonly rows: number
}

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

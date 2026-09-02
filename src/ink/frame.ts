// Frame records, the empty-frame factory, the patch vocabulary the differ
// emits and the writer consumes, and the screen-clear decision.

import {
  createScreen,
  type CharPool,
  type HyperlinkPool,
  type Screen,
  type StylePool,
} from './cell-grid.js'
import type { ScrollHint } from './compose-walk.js'
import type { Cursor } from './cursor.js'

export type FlickerReason = 'resize' | 'offscreen' | 'clear'

export type Patch =
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | {
      type: 'clearTerminal'
      reason: FlickerReason
      debug?: { triggerY: number; prevLine: string; nextLine: string }
    }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; col: number }
  | { type: 'carriageReturn' }
  | { type: 'hyperlink'; uri: string }
  | { type: 'styleStr'; str: string }

export type Diff = Patch[]

export type Frame = {
  readonly screen: Screen
  readonly viewport: { readonly width: number; readonly height: number }
  readonly cursor: Cursor
  readonly scrollHint?: ScrollHint | null
  readonly scrollDrainPending?: boolean
}

/**
 * A zero-by-zero screen with a viewport of the given rows and columns and a
 * visible cursor at the origin. The zero-sized screen is significant: the
 * alternate-screen blank reset deliberately does NOT use this shape (a
 * zero-height base sends the writer down its newline-advancing growth path,
 * which scrolls the alternate buffer).
 */
export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  return {
    screen: createScreen(columns, 0, stylePool, charPool, hyperlinkPool),
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  }
}

/**
 * `resize` when either viewport dimension changed; otherwise `offscreen`
 * when either frame's screen reaches its viewport height; otherwise no
 * clear.
 */
export function shouldClearScreen(
  prevFrame: Frame,
  frame: Frame,
): FlickerReason | undefined {
  if (
    prevFrame.viewport.width !== frame.viewport.width ||
    prevFrame.viewport.height !== frame.viewport.height
  ) {
    return 'resize'
  }
  if (
    frame.screen.height >= frame.viewport.height ||
    prevFrame.screen.height >= prevFrame.viewport.height
  ) {
    return 'offscreen'
  }
  return undefined
}

export type FlickerRecord = {
  desiredHeight: number
  availableHeight: number
  reason: FlickerReason
}

/** Per-frame phase timings; the field names are contract data consumed
 *  outside this slice. `commit` is 0 when the frame carried no React
 *  commit; `yogaLive` growth is a leak signal. */
export type FramePhases = {
  renderer: number
  diff: number
  optimize: number
  write: number
  /** The PRE-optimise patch count. */
  patches: number
  yoga: number
  commit: number
  yogaVisited: number
  yogaMeasured: number
  yogaCacheHits: number
  yogaLive: number
}

export type FrameEvent = {
  durationMs: number
  phases?: FramePhases
  flickers: FlickerRecord[]
}

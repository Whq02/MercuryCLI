
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

export type FramePhases = {
  renderer: number
  diff: number
  optimize: number
  write: number
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

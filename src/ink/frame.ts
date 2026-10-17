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

type ClearCause = { triggerY: number; prevLine: string; nextLine: string }

type NoPayload = Record<never, never>

type PatchPayloads = {
  stdout: { content: string }
  styleStr: { str: string }
  hyperlink: { uri: string }
  cursorMove: { x: number; y: number }
  cursorTo: { col: number }
  clear: { count: number }
  clearTerminal: { reason: FlickerReason; debug?: ClearCause }
  cursorHide: NoPayload
  cursorShow: NoPayload
  carriageReturn: NoPayload
}

export type Patch = { [Kind in keyof PatchPayloads]: { type: Kind } & PatchPayloads[Kind] }[keyof PatchPayloads]

export type Diff = Patch[]

type Viewport = { readonly width: number; readonly height: number }

export type Frame = {
  readonly screen: Screen
  readonly viewport: Viewport
  readonly cursor: Cursor
  readonly scrollHint?: ScrollHint | null
  readonly scrollDrainPending?: boolean
}

const homeCursor = (): Cursor => ({ x: 0, y: 0, visible: true })

export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  const viewport: Viewport = { width: columns, height: rows }
  const screen = createScreen(viewport.width, 0, stylePool, charPool, hyperlinkPool)
  return { screen, viewport, cursor: homeCursor() }
}

export type FlickerRecord = {
  desiredHeight: number
  availableHeight: number
  reason: FlickerReason
}

type TimedPhase = 'renderer' | 'diff' | 'optimize' | 'write' | 'yoga' | 'commit'

type LayoutCounter = 'yogaVisited' | 'yogaMeasured' | 'yogaCacheHits' | 'yogaLive'

export type FramePhases = { [Phase in TimedPhase]: number } & { patches: number } & {
  [Counter in LayoutCounter]: number
}

export type FrameEvent = {
  durationMs: number
  phases?: FramePhases
  flickers: FlickerRecord[]
}

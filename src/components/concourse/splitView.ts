
import { chatOnlyBoot } from '../../context/surfaceRoute.js'

export const BOARD_PANE_MIN_COLS = 80

export const CHAT_PANE_MIN_COLS = 40

export const SPLIT_MIN_ROWS = 22

export const SPLIT_DIVIDER_COLS = 1

export const SPLIT_RATIOS = ['board-min', 'even', 'chat-min'] as const
export type SplitRatio = (typeof SPLIT_RATIOS)[number]

export function splitMinCols(): number {
  return BOARD_PANE_MIN_COLS + SPLIT_DIVIDER_COLS + CHAT_PANE_MIN_COLS
}

export function splitAvailableAt(cols: number, rows: number): boolean {
  return cols >= splitMinCols() && rows >= SPLIT_MIN_ROWS
}

export interface SplitGeometry {
  boardCols: number
  chatCols: number
  dividerCol: number
}

export function splitGeometryAt(cols: number, ratio: SplitRatio): SplitGeometry {
  const floor = BOARD_PANE_MIN_COLS
  const ceil = Math.max(floor, cols - SPLIT_DIVIDER_COLS - CHAT_PANE_MIN_COLS)
  const ideal =
    ratio === 'board-min' ? floor : ratio === 'even' ? Math.floor((cols - SPLIT_DIVIDER_COLS) / 2) : ceil
  const boardCols = Math.max(floor, Math.min(ceil, ideal))
  return {
    boardCols,
    chatCols: Math.max(0, cols - SPLIT_DIVIDER_COLS - boardCols),
    dividerCol: boardCols,
  }
}

export function splitNeedsFrameLine(cols: number, rows: number): string {
  const narrow = cols < splitMinCols()
  const short = rows < SPLIT_MIN_ROWS
  if (narrow && short) {
    return `split needs ${splitMinCols()} columns and ${SPLIT_MIN_ROWS} rows — this frame is ${cols}×${rows}`
  }
  if (short) {
    return `split needs ${SPLIT_MIN_ROWS} rows for two panes — this frame is ${cols}×${rows}`
  }
  return `split needs ${splitMinCols()} columns (board ${BOARD_PANE_MIN_COLS} + chat ${CHAT_PANE_MIN_COLS} + the divider) — this frame is ${cols}`
}


let on = false
let ratio: SplitRatio = 'board-min'
let version = 0
const listeners = new Set<() => void>()

function bump(): void {
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

export function subscribeSplitView(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function splitViewVersion(): number {
  return version
}

export function splitViewOn(): boolean {
  return on
}

export function splitViewRatio(): SplitRatio {
  return ratio
}

export function splitActiveOf(facts: { on: boolean; cols: number; rows: number; plainWorld: boolean }): boolean {
  return facts.on && !facts.plainWorld && splitAvailableAt(facts.cols, facts.rows)
}

export function splitActiveAt(cols: number, rows: number): boolean {
  return splitActiveOf({ on, cols, rows, plainWorld: chatOnlyBoot() })
}

export type SplitToggleOutcome =
  | { ok: true; on: boolean }
  | { ok: false; code: 'plain-world' | 'too-narrow' | 'too-short'; reason: string }

export function splitToggleDecisionOf(facts: {
  on: boolean
  cols: number
  rows: number
  plainWorld: boolean
}): SplitToggleOutcome {
  if (facts.on) return { ok: true, on: false }
  if (facts.plainWorld) {
    return {
      ok: false,
      code: 'plain-world',
      reason: 'no split in the plain world — there is no board to split with',
    }
  }
  if (!splitAvailableAt(facts.cols, facts.rows)) {
    return {
      ok: false,
      code: facts.cols < splitMinCols() ? 'too-narrow' : 'too-short',
      reason: splitNeedsFrameLine(facts.cols, facts.rows),
    }
  }
  return { ok: true, on: true }
}

export function toggleSplitView(cols: number, rows: number): SplitToggleOutcome {
  const decision = splitToggleDecisionOf({ on, cols, rows, plainWorld: chatOnlyBoot() })
  if (decision.ok) {
    on = decision.on
    bump()
  }
  return decision
}

export type SplitNudgeOutcome = { moved: true; ratio: SplitRatio } | { moved: false; ratio: SplitRatio }

export function nudgeSplitRatio(dir: -1 | 1): SplitNudgeOutcome {
  const at = SPLIT_RATIOS.indexOf(ratio)
  const next = Math.max(0, Math.min(SPLIT_RATIOS.length - 1, at + dir))
  if (next === at) return { moved: false, ratio }
  ratio = SPLIT_RATIOS[next]!
  bump()
  return { moved: true, ratio }
}

export type SplitCollapse = { collapsed: false } | { collapsed: true; line: string }

export function collapseSplitForFrame(cols: number, rows: number): SplitCollapse {
  if (!on || splitAvailableAt(cols, rows)) return { collapsed: false }
  on = false
  bump()
  return { collapsed: true, line: `split collapsed — ${splitNeedsFrameLine(cols, rows)}` }
}

export function _resetSplitViewForTesting(): void {
  on = false
  ratio = 'board-min'
  bump()
}

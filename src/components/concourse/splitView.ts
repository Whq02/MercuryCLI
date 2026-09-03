// ============================================================================
//  splitView — THE SPLIT FRAME's one state + geometry owner.
//  The board and the focused chat side by side, as one VIEW
//  STATE of the concourse stop: the strip's stops do not change, the route
//  does not change, and nothing here mints a session, a connector or a host
//  — the chat side reads THE one focused slot (the bridge law), so this
//  module owns booleans and columns only.
//
//  Laws carried here (pure, injectable — the pins drive them without a
//  boot):
//   · availability: split exists only while the frame affords BOTH lawful
//     minimums — the board's own too-small floor (80 cols) and the chat
//     pane's floor — plus the divider column, AND the board pane's row
//     floor (24 rows — the profile refuses under it whatever the width);
//     below any of those the toggle answers one honest line naming the
//     failing dimension and CHANGES NOTHING;
//   · the plain world (`--chat` / concourse off) has no split: there is no
//     board to split with — the toggle refuses honestly (the key is not
//     taught there and reaches nothing);
//   · geometry: the board keeps its lawful minimum and the chat pane takes
//     the rest (the default named ratio); `[` / `]` nudge the divider
//     between the THREE named ratios, every one clamped so both minimums
//     hold at any width;
//   · resize: dropping below the threshold COLLAPSES split back to the full
//     board (the store turns off — re-widening does not auto-re-split; the
//     toggle is the operator's) with one honest line at the caller.
//
//  Store idiom: module-scoped, React-free, useSyncExternalStore-compatible
//  (the surfaceRoute pattern). Split state is process-lifetime — a route
//  round trip (shift+→ into the full chat and back) returns to the same
//  view state, exactly like the screen's presentation capsule.
// ============================================================================

import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS } from '../../ink/viewportFloor.js'

/** The board pane's lawful minimum — the concourse's own too-small floor,
 *  read from its one owner (resolveConcourseProfile refuses below the
 *  viewport floor's columns; the board pane must never be a frame the board
 *  itself calls too small). */
export const BOARD_PANE_MIN_COLS = VIEWPORT_FLOOR_COLS

/** The chat pane's floor: the mirror pipeline stays legible here (the row
 *  peek already renders it near this width); the DEFAULT ratio gives the
 *  chat side the whole rest of the frame, so this floor is the worst case,
 *  never the usual one. */
export const CHAT_PANE_MIN_COLS = 40

/** THE ROWS LEG of the same law: the board pane keeps its columns at ANY
 *  frame width, but the concourse profile refuses under the viewport floor's
 *  ROWS too (resolveConcourseProfile) — a split that stands on a frame one
 *  row short paints the board pane's too-small refusal INSIDE a live split:
 *  half a refusal, half a chat (the SP-9 half-frame class). The floor is
 *  read from its one owner (ink/viewportFloor — 6cb0eaa made the profile
 *  read it too; importing ConcourseLayout here would cycle); the agreement
 *  is PINNED in scripts/switchboard/prove-split-view.ts leg F. */
export const SPLIT_MIN_ROWS = VIEWPORT_FLOOR_ROWS

/** The divider between the panes — one column of rule glyphs. */
export const SPLIT_DIVIDER_COLS = 1

/** The named ratios `[` / `]` walk (v1 — no drag): the board at its lawful
 *  minimum with the chat taking the rest (the default), an even
 *  share, and the mirror image (the chat at ITS minimum). Every ratio is
 *  clamped so both minimums hold — at the threshold width all three
 *  coincide, honestly. */
export const SPLIT_RATIOS = ['board-min', 'even', 'chat-min'] as const
export type SplitRatio = (typeof SPLIT_RATIOS)[number]

/** The narrowest frame that affords both minimums plus the divider. */
export function splitMinCols(): number {
  return BOARD_PANE_MIN_COLS + SPLIT_DIVIDER_COLS + CHAT_PANE_MIN_COLS
}

/** Pure: does this frame afford the split at all? Rows are REQUIRED — an
 *  optional dimension is how the rows hole shipped in the first place (every
 *  caller must answer the whole frame). */
export function splitAvailableAt(cols: number, rows: number): boolean {
  return cols >= splitMinCols() && rows >= SPLIT_MIN_ROWS
}

export interface SplitGeometry {
  boardCols: number
  chatCols: number
  /** 0-based column of the divider rule (= boardCols). */
  dividerCol: number
}

/** Pure: the pane columns at a frame width under a named ratio — both
 *  minimums hold by clamping (callers gate on splitAvailableAt first; an
 *  unaffordable frame still answers a lawful clamp, never negatives). */
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

/** The one honest sentence for a frame that cannot split — the toggle's
 *  refusal and the resize collapse both speak it (one owner). It names the
 *  FAILING dimension(s): the width-only sentence is byte-identical to the
 *  pre-rows-law line (pinned — leg F5). */
export function splitNeedsFrameLine(cols: number, rows: number): string {
  const narrow = cols < splitMinCols()
  const short = rows < SPLIT_MIN_ROWS
  if (narrow && short) {
    return `split needs ${splitMinCols()} columns and ${SPLIT_MIN_ROWS} rows — this frame is ${cols}×${rows}`
  }
  if (short) {
    return `split needs ${SPLIT_MIN_ROWS} rows (the board pane's own floor) — this frame is ${cols}×${rows}`
  }
  return `split needs ${splitMinCols()} columns (board ${BOARD_PANE_MIN_COLS} + chat ${CHAT_PANE_MIN_COLS} + the divider) — this frame is ${cols}`
}

// ── the store ────────────────────────────────────────────────────────────────

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
      /* a throwing subscriber never blocks the others */
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

/** The operator's toggle state (the raw switch — pane composition derives
 *  through splitActiveAt so a narrow frame never half-paints). */
export function splitViewOn(): boolean {
  return on
}

export function splitViewRatio(): SplitRatio {
  return ratio
}

/** Pure over injected facts: does the split COMPOSE right now? The switch
 *  on, the frame affording, and not the plain world — paint derives from
 *  this every frame, so a narrow beat can never tear a half-split before
 *  the collapse effect commits. */
export function splitActiveOf(facts: { on: boolean; cols: number; rows: number; plainWorld: boolean }): boolean {
  return facts.on && !facts.plainWorld && splitAvailableAt(facts.cols, facts.rows)
}

/** The live read: the store, the frame the caller measured, and the
 *  router's own plain-world fact. */
export function splitActiveAt(cols: number, rows: number): boolean {
  return splitActiveOf({ on, cols, rows, plainWorld: chatOnlyBoot() })
}

export type SplitToggleOutcome =
  | { ok: true; on: boolean }
  | { ok: false; code: 'plain-world' | 'too-narrow' | 'too-short'; reason: string }

/** Pure decision over injected facts — the pins drive every world/width
 *  without a boot; toggleSplitView commits it. Turning OFF always works;
 *  turning ON needs the full stage and the width. */
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

/** THE TOGGLE (`s` on the board): flips the view state, or answers the one
 *  honest line and changes nothing. */
export function toggleSplitView(cols: number, rows: number): SplitToggleOutcome {
  const decision = splitToggleDecisionOf({ on, cols, rows, plainWorld: chatOnlyBoot() })
  if (decision.ok) {
    on = decision.on
    bump()
  }
  return decision
}

export type SplitNudgeOutcome = { moved: true; ratio: SplitRatio } | { moved: false; ratio: SplitRatio }

/** `[` / `]` — the divider between the named ratios. `[` walks the board
 *  toward its minimum (the divider left), `]` grows the board (the divider
 *  right). Ends clamp: no wrap, no surprise. Only meaningful while on. */
export function nudgeSplitRatio(dir: -1 | 1): SplitNudgeOutcome {
  const at = SPLIT_RATIOS.indexOf(ratio)
  const next = Math.max(0, Math.min(SPLIT_RATIOS.length - 1, at + dir))
  if (next === at) return { moved: false, ratio }
  ratio = SPLIT_RATIOS[next]!
  bump()
  return { moved: true, ratio }
}

export type SplitCollapse = { collapsed: false } | { collapsed: true; line: string }

/** THE RESIZE LAW: a frame that stopped affording the split — either
 *  minimum column, OR the board pane's own row floor (the rows
 *  leg) — collapses split back to the full board: the store turns
 *  OFF (re-growing does not auto-re-split; the toggle is the operator's)
 *  and the caller paints the returned honest line. A no-op while off or
 *  while the frame affords. */
export function collapseSplitForFrame(cols: number, rows: number): SplitCollapse {
  if (!on || splitAvailableAt(cols, rows)) return { collapsed: false }
  on = false
  bump()
  return { collapsed: true, line: `split collapsed — ${splitNeedsFrameLine(cols, rows)}` }
}

/** Proof seam — split state is process-lifetime. */
export function _resetSplitViewForTesting(): void {
  on = false
  ratio = 'board-min'
  bump()
}

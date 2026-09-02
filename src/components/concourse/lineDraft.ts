// ============================================================================
//  lineDraft.ts — the Concourse's ONE single-line editing core:
//  grapheme-safe caret motion and edits over a plain {text, caret} value.
//
//  Every Concourse text editor (the new-session/redirect draft, the board
//  filter, the advanced title) routes its keys through these pure ops, so
//  Backspace/Delete/arrows/Home/End behave identically everywhere and a
//  surrogate pair or combining cluster can never be split — the screen's
//  retired `.slice(0, -1)` backspace halved emoji. The caret is a UTF-16
//  offset that is ALWAYS on a grapheme boundary (Intl.Segmenter, the same
//  engine as utils/Cursor.ts); insert accepts whole payloads (typed chars
//  and bracketed-paste bodies alike — lands paste as editor text).
//
//  caretLens() is the shared render window: a displayWidth-budgeted
//  before/at/after split that keeps the caret visible wherever it sits
//  (the strip's tail-truncation cannot — a mid-string caret would scroll
//  out of the lens). Pure.
// ============================================================================

import { getGraphemeSegmenter } from '../../utils/intl.js'
import { displayWidth } from '../mercury-ui/glyphs.js'

export interface LineDraft {
  text: string
  /** UTF-16 offset, always on a grapheme boundary (0..text.length). */
  caret: number
}

/** Grapheme boundary offsets for text: [0, ..., text.length]. */
export function graphemeBoundaries(text: string): number[] {
  const out = [0]
  if (text.length === 0) return out
  for (const seg of getGraphemeSegmenter().segment(text)) {
    out.push(seg.index + seg.segment.length)
  }
  return out
}

/** Snap an arbitrary offset to the nearest boundary at or below it. */
export function clampCaret(text: string, caret: number): number {
  if (caret <= 0) return 0
  if (caret >= text.length) return text.length
  const bounds = graphemeBoundaries(text)
  let best = 0
  for (const b of bounds) {
    if (b <= caret) best = b
    else break
  }
  return best
}

export function insertAt(d: LineDraft, payload: string): LineDraft {
  const caret = clampCaret(d.text, d.caret)
  return {
    text: d.text.slice(0, caret) + payload + d.text.slice(caret),
    caret: caret + payload.length,
  }
}

export function backspaceAt(d: LineDraft): LineDraft {
  const caret = clampCaret(d.text, d.caret)
  if (caret === 0) return { text: d.text, caret }
  const bounds = graphemeBoundaries(d.text)
  const at = bounds.indexOf(caret)
  const prev = bounds[Math.max(0, at - 1)] ?? 0
  return { text: d.text.slice(0, prev) + d.text.slice(caret), caret: prev }
}

export function deleteAt(d: LineDraft): LineDraft {
  const caret = clampCaret(d.text, d.caret)
  if (caret >= d.text.length) return { text: d.text, caret }
  const bounds = graphemeBoundaries(d.text)
  const at = bounds.indexOf(caret)
  const next = bounds[at + 1] ?? d.text.length
  return { text: d.text.slice(0, caret) + d.text.slice(next), caret }
}

export function caretLeft(d: LineDraft): LineDraft {
  const caret = clampCaret(d.text, d.caret)
  if (caret === 0) return { text: d.text, caret }
  const bounds = graphemeBoundaries(d.text)
  const at = bounds.indexOf(caret)
  return { text: d.text, caret: bounds[Math.max(0, at - 1)] ?? 0 }
}

export function caretRight(d: LineDraft): LineDraft {
  const caret = clampCaret(d.text, d.caret)
  if (caret >= d.text.length) return { text: d.text, caret }
  const bounds = graphemeBoundaries(d.text)
  const at = bounds.indexOf(caret)
  return { text: d.text, caret: bounds[Math.min(bounds.length - 1, at + 1)] ?? d.text.length }
}

export function caretHome(d: LineDraft): LineDraft {
  return { text: d.text, caret: 0 }
}

export function caretEnd(d: LineDraft): LineDraft {
  return { text: d.text, caret: d.text.length }
}

/** The ONE caret-motion router every Concourse editor consumes (
 *  never a hand-rolled per-surface approximation): maps an arrow/home/end
 *  chord to its shared caret op, or null for a non-motion key. Returning the
 *  OP (not an applied value) lets callers use functional state updates, so a
 *  burst of motions inside one input batch each move from the LATEST draft
 *  (a value-applying router loses all but one step to closure staleness). */
export function editorMotionOp(key: {
  leftArrow: boolean
  rightArrow: boolean
  home: boolean
  end: boolean
}): ((d: LineDraft) => LineDraft) | null {
  if (key.leftArrow) return caretLeft
  if (key.rightArrow) return caretRight
  if (key.home) return caretHome
  if (key.end) return caretEnd
  return null
}

// (paste is TEXT): the one-line editor boundary — newline/tab runs
// fold to a single space and the remaining C0/DEL control bytes drop. Built
// from char codes so no source literal ever holds a raw control byte.
const FOLD_WS = new RegExp('[' + String.fromCharCode(13) + String.fromCharCode(10) + String.fromCharCode(9) + ']+', 'g')
const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g')
export function singleLine(s: string): string {
  return s.replace(FOLD_WS, ' ').replace(CTRL, '')
}

// Phase-2 surface parity (challenger CU-09+AR-2, the ratified minimum
// floor): the CONVERSATION composers (coordinator + attached session) must
// never silently degrade a multiline paste. editorText is their insert
// boundary — CRLF/CR normalize to LF, LF SURVIVES, TAB folds to a space,
// and the remaining C0/DEL control bytes drop. The one-line editors (board
// filter, strip title, agent name) keep singleLine above unchanged.
const LF = String.fromCharCode(10)
const CRLF_OR_CR = new RegExp(String.fromCharCode(13) + String.fromCharCode(10) + '?', 'g')
const TAB = new RegExp(String.fromCharCode(9), 'g')
const CTRL_KEEP_LF = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(9) + String.fromCharCode(11) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
  'g',
)
export function editorText(s: string): string {
  return s.replace(CRLF_OR_CR, LF).replace(TAB, ' ').replace(CTRL_KEEP_LF, '')
}

/** The draft split into logical lines with the caret located (render aid for
 *  the multiline composers — pure, grapheme-safe because LF is always its
 *  own grapheme boundary). */
export function draftLines(d: LineDraft): { lines: string[]; caretLine: number; caretCol: number } {
  const caret = clampCaret(d.text, d.caret)
  const lines = d.text.split(LF)
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const end = offset + lines[i]!.length
    if (caret <= end) return { lines, caretLine: i, caretCol: caret - offset }
    offset = end + 1 // the LF separator
  }
  return { lines, caretLine: lines.length - 1, caretCol: lines[lines.length - 1]!.length }
}

/** The composer strip's caret-following draft window — THE one owner of the
 *  window/indicator arithmetic (the strip's paint, the geometry budget and
 *  click-to-caret all read these numbers; a second derivation is how an
 *  unbudgeted `… +N more line(s)` row broke the switchboard column).
 *  `bandBudget` bounds the WHOLE band (window rows + one row per hidden-line
 *  indicator); the window shrinks (never below 1) until the band fits, so
 *  bandRows ≤ max(bandBudget, 1 + indicators). */
export interface DraftWindow {
  windowStart: number
  windowRows: number
  hiddenAbove: number
  hiddenBelow: number
  /** windowRows + one row per painted indicator — the strip's true height. */
  bandRows: number
}
export function draftWindow(d: LineDraft, bandBudget: number): DraftWindow {
  const lines = draftLines(d)
  const total = lines.lines.length
  let windowRows = Math.max(1, Math.min(3, total, Math.max(1, bandBudget)))
  for (;;) {
    const windowStart = Math.max(
      0,
      Math.min(lines.caretLine - (windowRows - 1), total - windowRows),
    )
    const hiddenAbove = windowStart
    const hiddenBelow = Math.max(0, total - windowStart - windowRows)
    const bandRows = windowRows + (hiddenAbove > 0 ? 1 : 0) + (hiddenBelow > 0 ? 1 : 0)
    if (bandRows <= bandBudget || windowRows <= 1) {
      return { windowStart, windowRows, hiddenAbove, hiddenBelow, bandRows }
    }
    windowRows -= 1
  }
}

/** IA-7 (the PromptInput graduation floor): VERTICAL caret motion for
 *  multiline drafts — ↑/↓ move to the same column on the adjacent line
 *  (clamped to its length), the focused chat's own line-walk semantics. On a
 *  single-line draft both return null so the surface keeps its own ↑↓
 *  meaning (example walk, history). */
export function caretVerticalOp(
  key: { upArrow: boolean; downArrow: boolean },
  d: LineDraft,
): ((d: LineDraft) => LineDraft) | null {
  if (!key.upArrow && !key.downArrow) return null
  const { lines, caretLine, caretCol } = draftLines(d)
  if (lines.length <= 1) return null
  const target = key.upArrow ? caretLine - 1 : caretLine + 1
  if (target < 0 || target >= lines.length) return null
  return cur => {
    const l = draftLines(cur)
    const t = key.upArrow ? l.caretLine - 1 : l.caretLine + 1
    if (t < 0 || t >= l.lines.length) return cur
    let offset = 0
    for (let i = 0; i < t; i++) offset += l.lines[i]!.length + 1
    return { text: cur.text, caret: offset + Math.min(l.caretCol, l.lines[t]!.length) }
  }
}

// ── the shared composer UNDO core (CU-09+AR-2 floor: ctrl+_ undoes) ─────────
// One bounded history per composer mount: consecutive single-grapheme typing
// coalesces into one step (the focused chat's atomic-group grammar), while a
// paste, a delete run boundary, or a send-clear each snapshot. Pure data —
// callers hold it in a ref and record BEFORE applying each edit.

export type DraftEditKind = 'type' | 'delete' | 'paste' | 'clear'

export interface DraftUndo {
  stack: LineDraft[]
  lastKind: DraftEditKind | null
}

const UNDO_CAP = 100

export function newDraftUndo(): DraftUndo {
  return { stack: [], lastKind: null }
}

/** Record the PRE-edit draft. Consecutive 'type' (and consecutive 'delete')
 *  edits coalesce — only the run's first pre-state is kept. */
export function recordDraftEdit(u: DraftUndo, prev: LineDraft, kind: DraftEditKind): void {
  if ((kind === 'type' || kind === 'delete') && u.lastKind === kind) return
  u.stack.push({ text: prev.text, caret: prev.caret })
  if (u.stack.length > UNDO_CAP) u.stack.shift()
  u.lastKind = kind
}

/** Pop the newest snapshot (null when nothing to undo). Resets coalescing so
 *  the next edit always snapshots. */
export function undoDraft(u: DraftUndo): LineDraft | null {
  const prev = u.stack.pop() ?? null
  u.lastKind = null
  return prev
}

export interface CaretLens {
  /** Text before the caret cell, windowed to the budget. */
  before: string
  /** The grapheme under the caret (empty at end-of-text — render a space). */
  at: string
  /** Text after the caret cell, windowed to the budget. */
  after: string
  /** True when the window dropped leading text (render a left ellipsis). */
  clippedLeft: boolean
  /** True when the window dropped trailing text. */
  clippedRight: boolean
}

/**
 * A displayWidth-budgeted window around the caret: the caret cell is always
 * inside the window, preceding text fills ~60% of the remaining budget and
 * the tail takes the rest — grapheme-safe on both edges.
 */
export function caretLens(d: LineDraft, width: number): CaretLens {
  const caret = clampCaret(d.text, d.caret)
  const bounds = graphemeBoundaries(d.text)
  const at = bounds.indexOf(caret)
  const atEnd = caret >= d.text.length
  const atText = atEnd ? '' : d.text.slice(caret, bounds[at + 1] ?? d.text.length)
  const atWidth = atEnd ? 1 : Math.max(1, displayWidth(atText))
  const budget = Math.max(0, width - atWidth)
  const beforeBudget = Math.ceil(budget * 0.6)

  // Walk graphemes leftward from the caret until the before-budget is spent.
  let beforeStart = at
  let beforeWidth = 0
  while (beforeStart > 0) {
    const gStart = bounds[beforeStart - 1]!
    const gEnd = bounds[beforeStart]!
    const w = displayWidth(d.text.slice(gStart, gEnd))
    if (beforeWidth + w > beforeBudget) break
    beforeWidth += w
    beforeStart -= 1
  }
  // Walk graphemes rightward from after the caret cell with the rest.
  const afterBudget = budget - beforeWidth
  let afterEnd = atEnd ? at : at + 1
  let afterWidth = 0
  while (afterEnd < bounds.length - 1) {
    const gStart = bounds[afterEnd]!
    const gEnd = bounds[afterEnd + 1]!
    const w = displayWidth(d.text.slice(gStart, gEnd))
    if (afterWidth + w > afterBudget) break
    afterWidth += w
    afterEnd += 1
  }
  return {
    before: d.text.slice(bounds[beforeStart]!, caret),
    at: atText,
    after: atEnd ? '' : d.text.slice(bounds[at + 1] ?? d.text.length, bounds[afterEnd]!),
    clippedLeft: beforeStart > 0,
    clippedRight: (bounds[afterEnd] ?? d.text.length) < d.text.length,
  }
}

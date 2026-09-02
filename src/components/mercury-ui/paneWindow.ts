// ============================================================================
//  paneWindow — cursor-following window math (pure; Sol 5.6 WS6).
//
//  ONE slice function for list surfaces that show `span` of `total` rows and
//  must keep the selection visible: the window centers on `sel`, clamps to
//  the ends, and NEVER leaves `sel` outside [start, end). Every row is
//  reachable by walking ↑/↓ — no fixed first-N slice, no dead tail.
// ============================================================================

export interface PaneWindow {
  start: number
  end: number
  /** Rows hidden above/below the window (for the ↑N / ↓N indicators). */
  above: number
  below: number
}

export function paneWindow(total: number, sel: number, span: number): PaneWindow {
  const n = Math.max(0, total)
  const s = Math.max(1, span)
  if (n <= s) return { start: 0, end: n, above: 0, below: 0 }
  const clampedSel = Math.min(Math.max(0, sel), n - 1)
  const start = Math.min(Math.max(0, clampedSel - (s >> 1)), n - s)
  const end = start + s
  return { start, end, above: start, below: n - end }
}

/** (the H wheel law): an EXPLICIT scroll window — the wheel scrolls
 *  pane content INDEPENDENTLY of selection (`start` is the operator's scroll
 *  position, clamped to the ends); the selection stays a keyboard/click act
 *  and may legitimately sit outside a scrolled window. */
export function scrolledWindow(total: number, start: number, span: number): PaneWindow {
  const n = Math.max(0, total)
  const s = Math.max(1, span)
  if (n <= s) return { start: 0, end: n, above: 0, below: 0 }
  const st = Math.min(Math.max(0, start), n - s)
  return { start: st, end: st + s, above: st, below: n - (st + s) }
}

/** A grouped list's chrome-aware fit: shrink a window until its content rows
 *  PLUS the group headings it straddles PLUS the more-line tile `budget`
 *  exactly. `windowFor(span)` is the caller's window function (selection-
 *  follow or explicit scroll); `groupOf(index)` names the row's group.
 *
 *  ONE ROW PER STEP is the law: a window's heading count is a property of
 *  the window (a smaller window straddles fewer groups), so subtracting a
 *  whole overshoot at once threw rows away the chrome never needed — the
 *  reference board at 142×38 painted one session over an empty pane. The
 *  more-line always survives to tell the truth about what shed; content
 *  rows outrank ornament, so the fit never returns fewer than 1 row for a
 *  non-empty list. */
export function fitGroupedWindow(
  total: number,
  budget: number,
  windowFor: (span: number) => PaneWindow,
  groupOf: (index: number) => string,
): PaneWindow {
  const chromeOf = (w: PaneWindow): number => {
    const groups = new Set<string>()
    for (let i = w.start; i < w.end; i++) groups.add(groupOf(i))
    const moreLine = w.above > 0 || w.below > 0 ? 1 : 0
    return groups.size + moreLine
  }
  let span = Math.max(0, Math.min(total, budget))
  let win = windowFor(span)
  while (span > 1 && win.end - win.start + chromeOf(win) > budget) {
    span -= 1
    win = windowFor(span)
  }
  return win
}

/** The variable-height fit — fitGroupedWindow's general form for lists whose
 *  rows PAINT different heights (a focused row that expands by a bordered
 *  card and detail lines; straddled section headings; more-line tiles).
 *  `measure(window)` returns the window's TOTAL painted lines under the
 *  caller's own paint law; the window shrinks ONE ROW PER STEP (the
 *  fitGroupedWindow law — chrome is a property of the window) until the
 *  measure fits `budget`. An index-span window over expanding rows is
 *  exactly the tail-clip class: the span fits by COUNT while the focused
 *  row's expansion overflows the modal slot, which bottom-clips the very
 *  row the cursor is on. Never returns fewer than 1 row for a non-empty
 *  list — the cursor row outranks every ornament. */
export function fitMeasuredWindow(
  total: number,
  budget: number,
  windowFor: (span: number) => PaneWindow,
  measure: (w: PaneWindow) => number,
): PaneWindow {
  let span = Math.max(0, Math.min(total, Math.max(1, budget)))
  let win = windowFor(span)
  while (span > 1 && measure(win) > budget) {
    span -= 1
    win = windowFor(span)
  }
  return win
}

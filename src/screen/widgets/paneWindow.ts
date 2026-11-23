
export interface PaneWindow {
  start: number
  end: number
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

export function scrolledWindow(total: number, start: number, span: number): PaneWindow {
  const n = Math.max(0, total)
  const s = Math.max(1, span)
  if (n <= s) return { start: 0, end: n, above: 0, below: 0 }
  const st = Math.min(Math.max(0, start), n - s)
  return { start: st, end: st + s, above: st, below: n - (st + s) }
}

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

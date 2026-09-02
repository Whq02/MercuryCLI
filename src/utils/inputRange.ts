
export interface InputRange {
  start: number
  end: number
}

export const CHIP_PATTERN =
  String.raw`\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]`
const CHIP_RE = new RegExp(CHIP_PATTERN, 'g')

export function expandRangeToChips(text: string, range: InputRange): InputRange {
  let { start, end } = range
  CHIP_RE.lastIndex = 0
  for (const m of text.matchAll(CHIP_RE)) {
    const cs = m.index
    const ce = m.index + m[0].length
    if (start < ce && end > cs) {
      if (start > cs) start = cs
      if (end < ce) end = ce
    }
  }
  return { start, end }
}

export function spliceInputRange(
  text: string,
  range: InputRange,
  insert: string,
): { text: string; cursorOffset: number; range: InputRange } {
  const clamped: InputRange = {
    start: Math.max(0, Math.min(range.start, text.length)),
    end: Math.max(0, Math.min(range.end, text.length)),
  }
  const safe = expandRangeToChips(text, clamped)
  const next = text.slice(0, safe.start) + insert + text.slice(safe.end)
  return { text: next, cursorOffset: safe.start + insert.length, range: safe }
}

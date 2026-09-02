// ============================================================================
//  The composer's text document + caret model.
//
//  A MeasuredText is an immutable, NFC-normalised document measured at a
//  column width: wrapped display lines, grapheme boundaries and word
//  boundaries are computed lazily and cached for the document's lifetime.
//  A Cursor is a document + a code-unit offset (+ a stored selection length
//  it never carries forward): every movement, edit and kill returns a NEW
//  caret with a zero selection — the composer owns selection state itself.
//
//  Reference chips (`[Pasted text #N]` / `[Image #N]` / truncated-text
//  tokens) are ATOMIC on the paths the operator drives: horizontal steps hop
//  them whole, and word/token deletions and operator-over-motion ranges snap
//  out of them. The guarantee is deliberately path-scoped — vertical moves,
//  position jumps and character find can land inside a chip (see the spec).
//  Every chip guard derives from the ONE exported pattern source in
//  utils/inputRange.ts.
//
//  The module also owns the process-global kill ring shared by all input
//  fields, and the vim character classes the vim modules reuse.
// ============================================================================

import {
  getGraphemeSegmenter,
  getWordSegmenter,
  firstGrapheme,
} from './intl.js'
import { stringWidth } from '../ink/stringWidth.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { CHIP_PATTERN } from './inputRange.js'

// ── vim character classes (exported; the text-object finder reuses them) ────

/** A vim word character: any Unicode letter, number, mark, or underscore. */
export const VIM_WORD_CHAR_REGEX = /[\p{L}\p{N}\p{M}_]/u
/** Regular whitespace. */
export const WHITESPACE_REGEX = /\s/

export function isVimWordChar(ch: string): boolean {
  return VIM_WORD_CHAR_REGEX.test(ch)
}
export function isVimWhitespace(ch: string): boolean {
  return WHITESPACE_REGEX.test(ch)
}
/** Anything non-empty that is neither a word character nor whitespace. */
export function isVimPunctuation(ch: string): boolean {
  return ch.length > 0 && !isVimWordChar(ch) && !isVimWhitespace(ch)
}

// ── chip machinery (ONE pattern source; anchored per use) ───────────────────

const CHIP_END_RE = new RegExp(`(?:${CHIP_PATTERN})$`)
const CHIP_START_RE = new RegExp(`^(?:${CHIP_PATTERN})`)

function chipScanRe(): RegExp {
  return new RegExp(CHIP_PATTERN, 'g')
}

// ── wrapped-line record ─────────────────────────────────────────────────────

export class WrappedLine {
  constructor(
    /** The line's raw text (untrimmed — display trimming is the projection's). */
    readonly text: string,
    /** Offset of this line's text in the source document. */
    readonly startOffset: number,
    /** True when this line STARTS a logical line (line 0, or preceded by \n). */
    readonly isPrecededByNewline: boolean,
    /** True when a newline terminates this line in the source. */
    readonly endsWithNewline: boolean,
  ) {}

  get length(): number {
    return this.text.length
  }

  equals(other: WrappedLine): boolean {
    return (
      this.text === other.text &&
      this.startOffset === other.startOffset &&
      this.isPrecededByNewline === other.isPrecededByNewline &&
      this.endsWithNewline === other.endsWithNewline
    )
  }
}

type WordBoundary = { start: number; end: number; isWordLike: boolean }

// ── the measured document ───────────────────────────────────────────────────

export class MeasuredText {
  /** The NFC-normalised text every offset refers to. */
  readonly text: string
  readonly columns: number

  private wrappedLines: WrappedLine[] | null = null
  private graphemeStarts: number[] | null = null
  private wordBoundaries: WordBoundary[] | null = null

  constructor(text: string, columns: number) {
    this.text = text.normalize('NFC')
    this.columns = columns
  }

  get lineCount(): number {
    return this.lines().length
  }

  private lines(): WrappedLine[] {
    if (this.wrappedLines) return this.wrappedLines
    const wrapped = wrapAnsi(this.text, Math.max(1, this.columns), {
      hard: true,
      trim: false,
    }).split('\n')
    const out: WrappedLine[] = []
    let pos = 0
    for (let i = 0; i < wrapped.length; i++) {
      const lineText = wrapped[i]!
      let start: number
      if (lineText.length > 0) {
        const idx = this.text.indexOf(lineText, pos)
        if (idx === -1) {
          // The wrapper and the source disagree — an internal invariant
          // violation, never silently absorbed.
          throw new Error(
            `MeasuredText: wrapped line ${i} not found in source text`,
          )
        }
        start = idx
      } else {
        // A blank display line corresponds to the position of its own
        // newline character (pos already advanced past the previous line's
        // terminator).
        start = pos
      }
      const end = start + lineText.length
      const ends = this.text[end] === '\n'
      out.push(
        new WrappedLine(
          lineText,
          start,
          i === 0 ? true : this.text[start - 1] === '\n',
          ends,
        ),
      )
      pos = end + (ends ? 1 : 0)
    }
    this.wrappedLines = out
    return out
  }

  getWrappedLines(): WrappedLine[] {
    return this.lines()
  }

  /** Display strings: a wrap CONTINUATION has its leading whitespace
   *  trimmed; a line that starts a logical line keeps its indentation. */
  getWrappedText(): string[] {
    return this.lines().map(line => this.displayTextOf(line))
  }

  private displayTextOf(line: WrappedLine): string {
    return line.isPrecededByNewline ? line.text : line.text.replace(/^\s+/, '')
  }

  private trimCountOf(line: WrappedLine): number {
    return line.text.length - this.displayTextOf(line).length
  }

  // ── grapheme boundaries ──────────────────────────────────────────────────

  private graphemes(): number[] {
    if (this.graphemeStarts) return this.graphemeStarts
    const starts: number[] = []
    for (const seg of getGraphemeSegmenter().segment(this.text)) {
      starts.push(seg.index)
    }
    this.graphemeStarts = starts
    return starts
  }

  /** The next grapheme boundary strictly after `offset` (clamped to length). */
  nextOffset(offset: number): number {
    const starts = this.graphemes()
    for (let i = 0; i < starts.length; i++) {
      if (starts[i]! > offset) return starts[i]!
    }
    return this.text.length
  }

  /** The previous grapheme boundary strictly before `offset` (floor 0). */
  prevOffset(offset: number): number {
    const starts = this.graphemes()
    let prev = 0
    for (let i = 0; i < starts.length; i++) {
      if (starts[i]! >= offset) break
      prev = starts[i]!
    }
    return prev
  }

  /** Snap DOWN to the grapheme boundary at or before `offset`. */
  snapToGraphemeBoundary(offset: number): number {
    const clamped = Math.max(0, Math.min(offset, this.text.length))
    if (clamped === this.text.length) return clamped
    const starts = this.graphemes()
    let snapped = 0
    for (let i = 0; i < starts.length; i++) {
      if (starts[i]! > clamped) break
      snapped = starts[i]!
    }
    return snapped
  }

  // ── word boundaries (locale segmentation) ────────────────────────────────

  getWordBoundaries(): WordBoundary[] {
    if (this.wordBoundaries) return this.wordBoundaries
    const out: WordBoundary[] = []
    for (const seg of getWordSegmenter().segment(this.text)) {
      out.push({
        start: seg.index,
        end: seg.index + seg.segment.length,
        isWordLike: Boolean(seg.isWordLike),
      })
    }
    this.wordBoundaries = out
    return out
  }

  // ── display-width ↔ string-index conversion ──────────────────────────────

  /** Display cells occupied by `text` up to code-unit `index`. */
  stringIndexToDisplayWidth(text: string, index: number): number {
    return stringWidth(text.slice(0, index))
  }

  /** The code-unit index in `text` whose leading slice fills `targetWidth`
   *  cells, accumulated grapheme by grapheme (clamped to the text length). */
  displayWidthToStringIndex(text: string, targetWidth: number): number {
    let width = 0
    let index = 0
    for (const seg of getGraphemeSegmenter().segment(text)) {
      const w = stringWidth(seg.segment)
      if (width + w > targetWidth) return seg.index
      width += w
      index = seg.index + seg.segment.length
    }
    return index
  }

  // ── position ↔ offset ────────────────────────────────────────────────────

  getPositionFromOffset(offset: number): { line: number; column: number } {
    const lines = this.lines()
    const clamped = Math.max(0, Math.min(offset, this.text.length))
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const end = line.startOffset + line.text.length + (line.endsWithNewline ? 1 : 0)
      const isLast = i === lines.length - 1
      if (clamped < end || (isLast && clamped >= end)) {
        if (clamped < line.startOffset) return { line: i, column: 0 }
        const display = this.displayTextOf(line)
        if (isLast && clamped > line.startOffset + line.text.length) {
          return { line: i, column: stringWidth(display) }
        }
        const rel = Math.min(clamped - line.startOffset, line.text.length)
        const trim = this.trimCountOf(line)
        if (rel <= trim) return { line: i, column: 0 }
        return {
          line: i,
          column: this.stringIndexToDisplayWidth(display, rel - trim),
        }
      }
    }
    const last = lines.length - 1
    return {
      line: last,
      column: stringWidth(this.displayTextOf(lines[last]!)),
    }
  }

  getOffsetFromPosition(position: { line: number; column: number }): number {
    const lines = this.lines()
    const lineIdx = Math.max(0, Math.min(position.line, lines.length - 1))
    const line = lines[lineIdx]!
    const display = this.displayTextOf(line)
    const trim = this.trimCountOf(line)
    const idx = this.displayWidthToStringIndex(display, Math.max(0, position.column))
    // Clamp to the line's end; on a newline-terminated line the maximum
    // (startOffset + length) sits ON the newline itself — one past the text.
    const offset = line.startOffset + trim + idx
    return Math.min(offset, line.startOffset + line.text.length)
  }

  /** Display width, in cells, of the given wrapped display line. */
  getLineLength(line: number): number {
    const lines = this.lines()
    const clamped = Math.max(0, Math.min(line, lines.length - 1))
    return stringWidth(this.displayTextOf(lines[clamped]!))
  }
}

// ── the caret ───────────────────────────────────────────────────────────────

export class Cursor {
  readonly offset: number
  readonly selection: number
  readonly measuredText: MeasuredText

  constructor(measuredText: MeasuredText, offset: number = 0, selection: number = 0) {
    this.measuredText = measuredText
    this.offset = Math.max(0, Math.min(offset, measuredText.text.length))
    this.selection = selection
  }

  /** Build from raw text and a terminal column count. The document measures
   *  one column NARROWER than the terminal so the block cursor always has a
   *  cell to occupy at the right edge. */
  static fromText(
    text: string,
    columns: number,
    offset: number = 0,
    selection: number = 0,
  ): Cursor {
    return new Cursor(new MeasuredText(text, Math.max(1, columns - 1)), offset, selection)
  }

  get text(): string {
    return this.measuredText.text
  }

  // ── predicates ───────────────────────────────────────────────────────────

  /** Offset AND document identity: carets over separately constructed
   *  documents are never equal (motion loops detect no-progress with this). */
  equals(other: Cursor): boolean {
    return this.offset === other.offset && this.measuredText === other.measuredText
  }

  isAtStart(): boolean {
    return this.offset === 0
  }

  isAtEnd(): boolean {
    return this.offset === this.text.length
  }

  // ── chips ────────────────────────────────────────────────────────────────

  /** The chip whose token ends exactly at `offset`, or null. */
  chipEndingAt(offset: number): { start: number; end: number } | null {
    const m = CHIP_END_RE.exec(this.text.slice(0, offset))
    if (!m) return null
    return { start: offset - m[0]!.length, end: offset }
  }

  /** The chip whose token starts exactly at `offset`, or null. */
  chipStartingAt(offset: number): { start: number; end: number } | null {
    const m = CHIP_START_RE.exec(this.text.slice(offset))
    if (!m) return null
    return { start: offset, end: offset + m[0]!.length }
  }

  /** Snap an offset that fell strictly INSIDE a chip out to the chip's
   *  start or end; offsets on a boundary (or outside) pass through. */
  snapOutOfImageRef(offset: number, direction: 'start' | 'end'): number {
    const re = chipScanRe()
    for (const m of this.text.matchAll(re)) {
      const start = m.index
      const end = m.index + m[0]!.length
      if (offset > start && offset < end) {
        return direction === 'start' ? start : end
      }
      if (start > offset) break
    }
    return offset
  }

  // ── horizontal movement (chip-hopping) ───────────────────────────────────

  /** The caret unmoved — but every movement/edit result reports a ZERO
   * selection, whatever the receiver's selection was (item 74), so a
   *  boundary no-op must still drop a live selection. */
  private atSelf(): Cursor {
    return this.selection === 0 ? this : new Cursor(this.measuredText, this.offset)
  }

  left(): Cursor {
    if (this.offset === 0) return this.atSelf()
    const chip = this.chipEndingAt(this.offset)
    if (chip) return new Cursor(this.measuredText, chip.start)
    return new Cursor(this.measuredText, this.measuredText.prevOffset(this.offset))
  }

  right(): Cursor {
    if (this.isAtEnd()) return this.atSelf()
    const chip = this.chipStartingAt(this.offset)
    if (chip) return new Cursor(this.measuredText, chip.end)
    return new Cursor(this.measuredText, this.measuredText.nextOffset(this.offset))
  }

  // ── vertical movement (display lines) ────────────────────────────────────

  getPosition(): { line: number; column: number } {
    return this.measuredText.getPositionFromOffset(this.offset)
  }

  up(): Cursor {
    const { line, column } = this.getPosition()
    if (line === 0) return this.atSelf()
    return new Cursor(
      this.measuredText,
      this.measuredText.getOffsetFromPosition({ line: line - 1, column }),
    )
  }

  down(): Cursor {
    const { line, column } = this.getPosition()
    if (line >= this.measuredText.lineCount - 1) return this.atSelf()
    return new Cursor(
      this.measuredText,
      this.measuredText.getOffsetFromPosition({ line: line + 1, column }),
    )
  }

  // ── line boundaries (display) ────────────────────────────────────────────

  /** Two-step: already at column 0 (and not on the first line) walks to the
   *  START of the previous display line, so repeated presses climb. */
  startOfLine(): Cursor {
    const { line, column } = this.getPosition()
    if (column === 0 && line > 0) {
      return new Cursor(
        this.measuredText,
        this.measuredText.getOffsetFromPosition({ line: line - 1, column: 0 }),
      )
    }
    return new Cursor(
      this.measuredText,
      this.measuredText.getOffsetFromPosition({ line, column: 0 }),
    )
  }

  endOfLine(): Cursor {
    const { line } = this.getPosition()
    return new Cursor(
      this.measuredText,
      this.measuredText.getOffsetFromPosition({
        line,
        column: this.measuredText.getLineLength(line),
      }),
    )
  }

  /** Reproduced defect, ruled unreachable (zero callers): the anchored
   *  search always matches at index 0, so this is column 0 of the current
   *  display line — plain start-of-line minus the two-step walk-up. Kept
   *  exported for class-surface parity. */
  firstNonBlankInLine(): Cursor {
    const { line } = this.getPosition()
    return new Cursor(
      this.measuredText,
      this.measuredText.getOffsetFromPosition({ line, column: 0 }),
    )
  }

  // ── line boundaries (logical \n lines) ───────────────────────────────────

  private logicalLineStart(offset: number): number {
    const idx = this.text.lastIndexOf('\n', offset - 1)
    return idx === -1 ? 0 : idx + 1
  }

  private logicalLineEnd(offset: number): number {
    const idx = this.text.indexOf('\n', offset)
    return idx === -1 ? this.text.length : idx
  }

  startOfLogicalLine(): Cursor {
    return new Cursor(this.measuredText, this.logicalLineStart(this.offset))
  }

  endOfLogicalLine(): Cursor {
    return new Cursor(this.measuredText, this.logicalLineEnd(this.offset))
  }

  firstNonBlankInLogicalLine(): Cursor {
    const start = this.logicalLineStart(this.offset)
    const end = this.logicalLineEnd(this.offset)
    const line = this.text.slice(start, end)
    const m = /\S/.exec(line)
    return new Cursor(this.measuredText, m ? start + m.index : end)
  }

  /** Preserve the code-unit distance from the line start, clamp to the
   *  target line's length, then snap DOWN to a grapheme boundary. */
  upLogicalLine(): Cursor {
    const start = this.logicalLineStart(this.offset)
    if (start === 0) return new Cursor(this.measuredText, 0)
    const column = this.offset - start
    const prevStart = this.logicalLineStart(start - 1)
    const prevEnd = start - 1
    const target = Math.min(prevStart + column, prevEnd)
    return new Cursor(this.measuredText, this.measuredText.snapToGraphemeBoundary(target))
  }

  downLogicalLine(): Cursor {
    const end = this.logicalLineEnd(this.offset)
    if (end === this.text.length) {
      return new Cursor(this.measuredText, this.text.length)
    }
    const start = this.logicalLineStart(this.offset)
    const column = this.offset - start
    const nextStart = end + 1
    const nextEnd = this.logicalLineEnd(nextStart)
    const target = Math.min(nextStart + column, nextEnd)
    return new Cursor(this.measuredText, this.measuredText.snapToGraphemeBoundary(target))
  }

  // ── absolute jumps ───────────────────────────────────────────────────────

  startOfFirstLine(): Cursor {
    return new Cursor(this.measuredText, 0)
  }

  /** Just after the final newline; a newline-free document falls back to
   *  display start-of-line INCLUDING its two-step walk-up. */
  startOfLastLine(): Cursor {
    const idx = this.text.lastIndexOf('\n')
    if (idx === -1) return this.startOfLine()
    return new Cursor(this.measuredText, idx + 1)
  }

  /** 1-indexed LOGICAL lines, clamped into range. */
  goToLine(lineNumber: number): Cursor {
    const lines = this.text.split('\n')
    const target = Math.max(1, Math.min(lineNumber, lines.length))
    let offset = 0
    for (let i = 0; i < target - 1; i++) offset += lines[i]!.length + 1
    return new Cursor(this.measuredText, offset)
  }

  endOfFile(): Cursor {
    return new Cursor(this.measuredText, this.text.length)
  }

  // ── word movement (locale segmentation) ──────────────────────────────────

  private wordLikeBoundaries(): WordBoundary[] {
    return this.measuredText.getWordBoundaries().filter(b => b.isWordLike)
  }

  /** The start of the next word-like segment strictly after the caret. */
  nextWord(): Cursor {
    if (this.isAtEnd()) return this.atSelf()
    for (const w of this.wordLikeBoundaries()) {
      if (w.start > this.offset) return new Cursor(this.measuredText, w.start)
    }
    return new Cursor(this.measuredText, this.text.length)
  }

  prevWord(): Cursor {
    if (this.offset === 0) return this.atSelf()
    const words = this.wordLikeBoundaries()
    // Strictly inside a word (after its start, at or before its end).
    for (const w of words) {
      if (this.offset > w.start && this.offset <= w.end) {
        return new Cursor(this.measuredText, w.start)
      }
    }
    let candidate = 0
    for (const w of words) {
      if (w.start < this.offset) candidate = w.start
      else break
    }
    return new Cursor(this.measuredText, candidate)
  }

  /** The offset of the word's final grapheme. */
  private lastCharOf(w: WordBoundary): number {
    return this.measuredText.prevOffset(w.end)
  }

  endOfWord(): Cursor {
    if (this.isAtEnd()) return this.atSelf()
    const words = this.wordLikeBoundaries()
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      const last = this.lastCharOf(w)
      if (this.offset >= w.start && this.offset < w.end) {
        // Inside; on the last character means take the NEXT word's last.
        if (this.offset < last) return new Cursor(this.measuredText, last)
        const next = words[i + 1]
        if (!next) return this.atSelf()
        return new Cursor(this.measuredText, this.lastCharOf(next))
      }
      if (w.start > this.offset) {
        return new Cursor(this.measuredText, last)
      }
    }
    return this.atSelf()
  }

  // ── vim word movement (grapheme steps + vim classes) ─────────────────────

  private charAt(offset: number): string {
    if (offset >= this.text.length) return ''
    return this.text.slice(offset, this.measuredText.nextOffset(offset))
  }

  private classOf(ch: string): 'word' | 'space' | 'punct' | 'none' {
    if (ch === '') return 'none'
    if (isVimWhitespace(ch)) return 'space'
    if (isVimWordChar(ch)) return 'word'
    return 'punct'
  }

  nextVimWord(): Cursor {
    const doc = this.measuredText
    let pos = this.offset
    const cls = this.classOf(this.charAt(pos))
    if (cls === 'word' || cls === 'punct') {
      while (pos < this.text.length && this.classOf(this.charAt(pos)) === cls) {
        pos = doc.nextOffset(pos)
      }
    }
    while (pos < this.text.length && this.classOf(this.charAt(pos)) === 'space') {
      pos = doc.nextOffset(pos)
    }
    return new Cursor(doc, pos)
  }

  endOfVimWord(): Cursor {
    const doc = this.measuredText
    let pos = doc.nextOffset(this.offset)
    while (pos < this.text.length && this.classOf(this.charAt(pos)) === 'space') {
      pos = doc.nextOffset(pos)
    }
    if (pos >= this.text.length) return new Cursor(doc, this.text.length)
    const cls = this.classOf(this.charAt(pos))
    // Advance while the NEXT grapheme is of the same class — landing ON the
    // word's last character.
    while (pos < this.text.length) {
      const next = doc.nextOffset(pos)
      if (next >= this.text.length || this.classOf(this.charAt(next)) !== cls) break
      pos = next
    }
    return new Cursor(doc, pos)
  }

  prevVimWord(): Cursor {
    const doc = this.measuredText
    if (this.offset === 0) return this.atSelf()
    let pos = doc.prevOffset(this.offset)
    while (pos > 0 && this.classOf(this.charAt(pos)) === 'space') {
      pos = doc.prevOffset(pos)
    }
    if (pos === 0 && this.classOf(this.charAt(pos)) === 'space') {
      return new Cursor(doc, 0)
    }
    const cls = this.classOf(this.charAt(pos))
    while (pos > 0) {
      const prev = doc.prevOffset(pos)
      if (this.classOf(this.charAt(prev)) !== cls) break
      pos = prev
    }
    return new Cursor(doc, pos)
  }

  // ── WORD movement (whitespace-delimited; single-step ⇒ chip hopping) ─────

  private wsAt(cursor: Cursor): boolean {
    const ch = cursor.charAt(cursor.offset)
    return ch !== '' && isVimWhitespace(ch)
  }

  nextWORD(): Cursor {
    let c: Cursor = this
    while (!c.isAtEnd() && !this.wsAt(c)) {
      const n = c.right()
      if (n.offset === c.offset) break
      c = n
    }
    while (!c.isAtEnd() && this.wsAt(c)) {
      const n = c.right()
      if (n.offset === c.offset) break
      c = n
    }
    return c
  }

  endOfWORD(): Cursor {
    if (this.isAtEnd()) return this.atSelf()
    let c: Cursor = this
    const followingIsBreak = (cur: Cursor): boolean => {
      const n = cur.right()
      return n.offset === cur.offset || n.isAtEnd()
        ? n.offset === cur.offset || this.wsAt(n) || n.isAtEnd()
        : this.wsAt(n)
    }
    if (!this.wsAt(c) && followingIsBreak(c)) {
      // Already on a WORD's last character: step forward and take the NEXT
      // WORD's end.
      c = c.right()
    }
    while (!c.isAtEnd() && this.wsAt(c)) {
      const n = c.right()
      if (n.offset === c.offset) break
      c = n
    }
    while (!c.isAtEnd()) {
      const n = c.right()
      if (n.offset === c.offset || n.isAtEnd() || this.wsAt(n)) break
      c = n
    }
    return c
  }

  prevWORD(): Cursor {
    if (this.offset === 0) return this.atSelf()
    let c: Cursor = this
    const leftChar = this.text[c.offset - 1] ?? ''
    if (leftChar !== '' && isVimWhitespace(leftChar)) {
      c = c.left()
    }
    while (c.offset > 0 && this.wsAt(c)) {
      const l = c.left()
      if (l.offset === c.offset) break
      c = l
    }
    while (c.offset > 0 && !isVimWhitespace(this.text[c.offset - 1] ?? ' ')) {
      const l = c.left()
      if (l.offset === c.offset) break
      c = l
    }
    return c
  }

  // ── editing ──────────────────────────────────────────────────────────────

  /** Replace the half-open range between this caret and `end` with
   *  `insertString`, returning a caret on the REBUILT document positioned
   *  after the insertion. The document is NFC-normalised as a whole, so the
   *  caret must be measured against the normalised PREFIX-plus-insertion, not
   *  `start + insertString.normalize().length`: when the insertion composes
   *  with the character before the caret (a combining mark, a Hangul jungseong)
   *  the join absorbs code units the isolated length does not know about, and
   *  the caret would land one position too far right — the next keystroke then
   *  inserts after the wrong character (W6 input-encoding: combining-mark caret
   *  overshoots). The suffix is appended after, and the source document was
   *  already NFC, so it cannot compose backward into the insertion. */
  modifyText(end: Cursor, insertString: string = ''): Cursor {
    const start = Math.min(this.offset, end.offset)
    const stop = Math.max(this.offset, end.offset)
    const prefixWithInsert = this.text.slice(0, start) + insertString
    const next = prefixWithInsert + this.text.slice(stop)
    const doc = new MeasuredText(next, this.measuredText.columns)
    return new Cursor(doc, prefixWithInsert.normalize('NFC').length)
  }

  insert(s: string): Cursor {
    return this.modifyText(this, s)
  }

  /** Delete forward one grapheme; a no-op at end of text. */
  del(): Cursor {
    if (this.isAtEnd()) return this.atSelf()
    return this.modifyText(new Cursor(this.measuredText, this.measuredText.nextOffset(this.offset)))
  }

  /** Delete backward one step; a no-op at start of text. */
  backspace(): Cursor {
    if (this.offset === 0) return this.atSelf()
    const target = this.left()
    return target.modifyText(this)
  }

  // ── kill-style deletions ─────────────────────────────────────────────────

  deleteToLineStart(): { cursor: Cursor; killed: string } {
    if (this.offset > 0 && this.text[this.offset - 1] === '\n') {
      // Delete exactly the newline so repeated presses clear across lines.
      const start = new Cursor(this.measuredText, this.offset - 1)
      return { cursor: start.modifyText(this), killed: '\n' }
    }
    const start = this.startOfLine()
    const killed = this.text.slice(start.offset, this.offset)
    return { cursor: start.modifyText(this), killed }
  }

  deleteToLineEnd(): { cursor: Cursor; killed: string } {
    if (this.text[this.offset] === '\n') {
      const end = new Cursor(this.measuredText, this.offset + 1)
      return { cursor: this.modifyText(end), killed: '\n' }
    }
    const end = this.endOfLine()
    const killed = this.text.slice(this.offset, end.offset)
    return { cursor: this.modifyText(end), killed }
  }

  deleteToLogicalLineEnd(): Cursor {
    if (this.text[this.offset] === '\n') {
      return this.modifyText(new Cursor(this.measuredText, this.offset + 1))
    }
    return this.modifyText(this.endOfLogicalLine())
  }

  deleteWordBefore(): { cursor: Cursor; killed: string } {
    if (this.offset === 0) return { cursor: this, killed: '' }
    const boundary = this.prevWord().offset
    const start = this.snapOutOfImageRef(boundary, 'start')
    const killed = this.text.slice(start, this.offset)
    return {
      cursor: new Cursor(this.measuredText, start).modifyText(this),
      killed,
    }
  }

  deleteWordAfter(): Cursor {
    if (this.isAtEnd()) return this.atSelf()
    const boundary = this.nextWord().offset
    const end = this.snapOutOfImageRef(boundary, 'end')
    return this.modifyText(new Cursor(this.measuredText, end))
  }

  /** Backspace-eats-a-chip. Returns null when there is nothing to do.
   *  `@`-mentions are deliberately NOT tokens — users correct path typos
   *  character by character. */
  deleteTokenBefore(): Cursor | null {
    // A chip starting exactly at the caret is the "chip selected" state:
    // delete it forward, plus one following space when present.
    const selected = this.chipStartingAt(this.offset)
    if (selected) {
      let end = selected.end
      if (this.text[end] === ' ') end += 1
      return this.modifyText(new Cursor(this.measuredText, end))
    }
    if (this.offset === 0) return null
    const after = this.text[this.offset]
    if (after !== undefined && !/\s/.test(after)) return null
    const before = this.text.slice(0, this.offset)
    const m = CHIP_END_RE.exec(before)
    if (!m) return null
    const chipStart = this.offset - m[0]!.length
    const preceding = before.slice(0, chipStart)
    if (preceding !== '' && !/\s$/.test(preceding)) return null
    return new Cursor(this.measuredText, chipStart).modifyText(this)
  }

  // ── character find (vim f/F/t/T semantics) ───────────────────────────────

  findCharacter(char: string, type: 'f' | 'F' | 't' | 'T', count: number = 1): number | null {
    const doc = this.measuredText
    if (char === '') return null
    let remaining = Math.max(1, count)
    if (type === 'f' || type === 't') {
      let pos = doc.nextOffset(this.offset)
      while (pos < this.text.length) {
        if (this.charAt(pos) === char) {
          remaining -= 1
          if (remaining === 0) {
            if (type === 'f') return pos
            return Math.max(this.offset, doc.prevOffset(pos))
          }
        }
        pos = doc.nextOffset(pos)
      }
      return null
    }
    let pos = this.offset > 0 ? doc.prevOffset(this.offset) : -1
    while (pos >= 0) {
      if (this.charAt(pos) === char) {
        remaining -= 1
        if (remaining === 0) {
          if (type === 'F') return pos
          return Math.min(this.offset, doc.nextOffset(pos))
        }
      }
      if (pos === 0) break
      pos = doc.prevOffset(pos)
    }
    return null
  }

  // ── viewport ─────────────────────────────────────────────────────────────

  /** The composer viewport's start line. With NO history the window lands
   *  centred on the caret (first paint, programmatic jumps). WITH
   *  `previousStart` the window is a STABLE BAND:
   *  it holds still while the caret moves inside it (one scrolloff row of
   *  margin where the window affords one) and scrolls only when the caret
   *  leaves — the rigid centring scrolled the WHOLE draft one row per ↑/↓
   *  press, rubberbanding the text under a caret that never visually
   *  moved. */
  getViewportStartLine(maxVisibleLines?: number, previousStart?: number): number {
    if (!maxVisibleLines || maxVisibleLines <= 0) return 0
    const lineCount = this.measuredText.lineCount
    if (lineCount <= maxVisibleLines) return 0
    const { line } = this.getPosition()
    const clampStart = (s: number): number =>
      Math.max(0, Math.min(s, lineCount - maxVisibleLines))
    if (previousStart !== undefined) {
      const held = clampStart(previousStart)
      const margin = maxVisibleLines >= 6 ? 1 : 0
      if (line >= held + margin && line <= held + maxVisibleLines - 1 - margin) {
        return held
      }
      if (line < held + margin) return clampStart(line - margin)
      return clampStart(line - maxVisibleLines + 1 + margin)
    }
    return clampStart(line - Math.floor(maxVisibleLines / 2))
  }

  getViewportCharOffset(maxVisibleLines?: number, previousStart?: number): number {
    const start = this.getViewportStartLine(maxVisibleLines, previousStart)
    if (start === 0) return 0
    return this.measuredText.getWrappedLines()[start]!.startOffset
  }

  getViewportCharEnd(maxVisibleLines?: number, previousStart?: number): number {
    if (!maxVisibleLines || maxVisibleLines <= 0) return this.text.length
    const start = this.getViewportStartLine(maxVisibleLines, previousStart)
    const lines = this.measuredText.getWrappedLines()
    const after = start + maxVisibleLines
    if (after >= lines.length) return this.text.length
    return lines[after]!.startOffset
  }

  // ── rendering ────────────────────────────────────────────────────────────

  render(
    cursorChar: string,
    mask: string,
    invert: (s: string) => string,
    ghostText?: { text: string; dim: (s: string) => string },
    maxVisibleLines?: number,
  ): string {
    const doc = this.measuredText
    const lines = doc.getWrappedLines()
    const { line: caretLine, column: caretColumn } = this.getPosition()
    const start = this.getViewportStartLine(maxVisibleLines)
    const end =
      !maxVisibleLines || maxVisibleLines <= 0
        ? lines.length
        : Math.min(lines.length, start + maxVisibleLines)

    const lastLineIdx = lines.length - 1
    const out: string[] = []
    for (let i = start; i < end; i++) {
      const raw = lines[i]!
      let display = raw.isPrecededByNewline ? raw.text : raw.text.replace(/^\s+/, '')

      if (mask) {
        // Every earlier line is FULLY masked (a wrapped secret must not leak
        // its head); the DOCUMENT-last line keeps its trailing six graphemes.
        display = this.maskLine(display, mask, i === lastLineIdx)
      }

      if (i !== caretLine) {
        out.push(display.replace(/\s+$/, ''))
        continue
      }
      out.push(
        this.renderCaretLine(display, caretColumn, cursorChar, invert, ghostText, i === lastLineIdx),
      )
    }
    return out.join('\n')
  }

  private maskLine(display: string, mask: string, isDocumentLastLine: boolean): string {
    const graphemes: string[] = []
    for (const seg of getGraphemeSegmenter().segment(display)) graphemes.push(seg.segment)
    if (!isDocumentLastLine) {
      return mask.repeat(graphemes.length)
    }
    const visible = 6
    if (graphemes.length <= visible) return display
    const maskedCount = graphemes.length - visible
    return mask.repeat(maskedCount) + graphemes.slice(maskedCount).join('')
  }

  private renderCaretLine(
    display: string,
    caretColumn: number,
    cursorChar: string,
    invert: (s: string) => string,
    ghostText: { text: string; dim: (s: string) => string } | undefined,
    isDocumentLastLine: boolean,
  ): string {
    const showGhost =
      ghostText !== undefined &&
      ghostText.text.length > 0 &&
      isDocumentLastLine &&
      this.isAtEnd()

    // Split by accumulating display widths across graphemes.
    let before = ''
    let atCaret = ''
    let after = ''
    let width = 0
    for (const seg of getGraphemeSegmenter().segment(display)) {
      const w = stringWidth(seg.segment)
      if (atCaret === '' && width + w > caretColumn) {
        atCaret = seg.segment
      } else if (atCaret === '') {
        before += seg.segment
      } else {
        after += seg.segment
      }
      width += w
    }

    const hidden = cursorChar === ''

    if (showGhost) {
      const ghostFirst = firstGrapheme(ghostText.text)
      const ghostRest = ghostText.text.slice(ghostFirst.length)
      const cell = hidden ? ghostFirst : invert(ghostFirst)
      return before + cell + (ghostRest ? ghostText.dim(ghostRest) : '')
    }

    if (atCaret === '') {
      // Caret at or past the line's end: the caret cell is the cursor
      // character itself (nothing when the cursor is hidden).
      return before + (hidden ? '' : invert(cursorChar))
    }
    const cell = hidden ? atCaret : invert(atCaret)
    return before + cell + after.replace(/\s+$/, '')
  }
}

// ── the kill ring (module-global; ONE ring for every input field) ───────────

const KILL_RING_CAPACITY = 10

const killRing: string[] = []
let lastActionWasKill = false
let lastActionWasYank = false
let yankRegion: { start: number; length: number } | null = null
let ringCursor = 0

export function pushToKillRing(text: string, direction: 'prepend' | 'append' = 'append'): void {
  if (!text) return
  if (lastActionWasKill && killRing.length > 0) {
    killRing[0] = direction === 'prepend' ? text + killRing[0]! : killRing[0]! + text
  } else {
    killRing.unshift(text)
    while (killRing.length > KILL_RING_CAPACITY) killRing.pop()
  }
  lastActionWasKill = true
  lastActionWasYank = false
  yankRegion = null
  ringCursor = 0
}

/** Called when the operator does something that is not a kill, so the next
 *  kill starts a fresh entry. */
export function resetKillAccumulation(): void {
  lastActionWasKill = false
}

export function getLastKill(): string {
  return killRing[0] ?? ''
}

/** Entry by index with wrap-around (modulo; safe for negative indices). */
export function getKillRingItem(index: number): string {
  const n = killRing.length
  if (n === 0) return ''
  return killRing[((index % n) + n) % n] ?? ''
}

export function getKillRingSize(): number {
  return killRing.length
}

export function clearKillRing(): void {
  killRing.length = 0
  lastActionWasKill = false
  lastActionWasYank = false
  yankRegion = null
  ringCursor = 0
}

export function recordYank(start: number, length: number): void {
  yankRegion = { start, length }
  lastActionWasYank = true
  ringCursor = 0
}

export function canYankPop(): boolean {
  return lastActionWasYank && killRing.length > 1
}

export function yankPop(): { text: string; start: number; length: number } | null {
  if (!canYankPop() || !yankRegion) return null
  ringCursor = (ringCursor + 1) % killRing.length
  return {
    text: killRing[ringCursor] ?? '',
    start: yankRegion.start,
    length: yankRegion.length,
  }
}

export function updateYankLength(length: number): void {
  if (yankRegion) yankRegion = { start: yankRegion.start, length }
}

export function resetYankState(): void {
  lastActionWasYank = false
  yankRegion = null
}

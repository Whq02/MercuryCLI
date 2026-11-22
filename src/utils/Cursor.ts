import {
  getGraphemeSegmenter,
  getWordSegmenter,
  firstGrapheme,
} from './intl.js'
import { stringWidth } from '../ink/stringWidth.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { CHIP_PATTERN } from './inputRange.js'
import { notBuilt } from '../pi/holes.js'


const VIM_WORD_CHAR_REGEX = /[\p{L}\p{N}\p{M}_]/u
const WHITESPACE_REGEX = /\s/

export function isVimWordChar(ch: string): boolean {
  return VIM_WORD_CHAR_REGEX.test(ch)
}
export function isVimWhitespace(ch: string): boolean {
  return WHITESPACE_REGEX.test(ch)
}


const CHIP_END_RE = new RegExp(`(?:${CHIP_PATTERN})$`)
const CHIP_START_RE = new RegExp(`^(?:${CHIP_PATTERN})`)

function chipScanRe(): RegExp {
  return new RegExp(CHIP_PATTERN, 'g')
}


class WrappedLine {
  constructor(
    readonly text: string,
    readonly startOffset: number,
    readonly isPrecededByNewline: boolean,
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


export class MeasuredText {
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
          throw new Error(
            `MeasuredText: wrapped line ${i} not found in source text`,
          )
        }
        start = idx
      } else {
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

  private displayTextOf(line: WrappedLine): string {
    return line.isPrecededByNewline ? line.text : line.text.replace(/^\s+/, '')
  }

  private trimCountOf(line: WrappedLine): number {
    return line.text.length - this.displayTextOf(line).length
  }


  private graphemes(): number[] {
    if (this.graphemeStarts) return this.graphemeStarts
    const starts: number[] = []
    for (const seg of getGraphemeSegmenter().segment(this.text)) {
      starts.push(seg.index)
    }
    this.graphemeStarts = starts
    return starts
  }

  nextOffset(offset: number): number {
    return notBuilt('src/utils/Cursor.ts:134')
  }

  prevOffset(offset: number): number {
    return notBuilt('src/utils/Cursor.ts:142')
  }

  snapToGraphemeBoundary(offset: number): number {
    return notBuilt('src/utils/Cursor.ts:152')
  }


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


  stringIndexToDisplayWidth(text: string, index: number): number {
    return stringWidth(text.slice(0, index))
  }

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
    const offset = line.startOffset + trim + idx
    return Math.min(offset, line.startOffset + line.text.length)
  }

  getLineLength(line: number): number {
    const lines = this.lines()
    const clamped = Math.max(0, Math.min(line, lines.length - 1))
    return stringWidth(this.displayTextOf(lines[clamped]!))
  }

  getLineEndOffset(line: number): number {
    const lines = this.lines()
    const clamped = Math.max(0, Math.min(line, lines.length - 1))
    const row = lines[clamped]!
    if (clamped === lines.length - 1) return row.startOffset + row.text.length
    return row.startOffset + row.text.replace(/\s+$/, '').length
  }
}

export type SelectionPaint = {
  start: number
  end: number
  paint: (text: string) => string
}

function paintSelected(display: string, lineStart: number, selection: SelectionPaint | undefined): string {
  return notBuilt('src/utils/Cursor.ts:258')
}


export class Cursor {
  readonly offset: number
  readonly selection: number
  readonly measuredText: MeasuredText

  constructor(measuredText: MeasuredText, offset?: number, selection?: number) {
    notBuilt('src/utils/Cursor.ts:272')
  }

  static fromText(
    text: string,
    columns: number,
    offset?: number,
    selection?: number,
  ): Cursor {
    return notBuilt('src/utils/Cursor.ts:278')
  }

  get text(): string {
    return notBuilt('src/utils/Cursor.ts:287')
  }


  equals(other: Cursor): boolean {
    return notBuilt('src/utils/Cursor.ts:292')
  }

  isAtStart(): boolean {
    return notBuilt('src/utils/Cursor.ts:296')
  }

  isAtEnd(): boolean {
    return notBuilt('src/utils/Cursor.ts:300')
  }


  chipEndingAt(offset: number): { start: number; end: number } | null {
    return notBuilt('src/utils/Cursor.ts:305')
  }

  chipStartingAt(offset: number): { start: number; end: number } | null {
    return notBuilt('src/utils/Cursor.ts:311')
  }

  snapOutOfImageRef(offset: number, direction: 'start' | 'end'): number {
    return notBuilt('src/utils/Cursor.ts:317')
  }


  atSelf(): Cursor {
    return notBuilt('src/utils/Cursor.ts:322')
  }

  left(): Cursor {
    return notBuilt('src/utils/Cursor.ts:326')
  }

  right(): Cursor {
    return notBuilt('src/utils/Cursor.ts:333')
  }


  getPosition(): { line: number; column: number } {
    return notBuilt('src/utils/Cursor.ts:341')
  }

  up(): Cursor {
    return notBuilt('src/utils/Cursor.ts:345')
  }

  down(): Cursor {
    return notBuilt('src/utils/Cursor.ts:349')
  }


  startOfLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:354')
  }

  endOfLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:358')
  }

  firstNonBlankInLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:362')
  }


  logicalLineStart(offset: number): number {
    return notBuilt('src/utils/Cursor.ts:365')
  }

  logicalLineEnd(offset: number): number {
    return notBuilt('src/utils/Cursor.ts:370')
  }

  startOfLogicalLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:375')
  }

  endOfLogicalLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:379')
  }

  firstNonBlankInLogicalLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:383')
  }

  upLogicalLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:385')
  }

  downLogicalLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:389')
  }


  startOfFirstLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:394')
  }

  startOfLastLine(): Cursor {
    return notBuilt('src/utils/Cursor.ts:398')
  }

  goToLine(lineNumber: number): Cursor {
    return notBuilt('src/utils/Cursor.ts:404')
  }


  wordLikeBoundaries(): WordBoundary[] {
    return notBuilt('src/utils/Cursor.ts:407')
  }

  nextWord(): Cursor {
    return notBuilt('src/utils/Cursor.ts:411')
  }

  prevWord(): Cursor {
    return notBuilt('src/utils/Cursor.ts:413')
  }

  lastCharOf(w: WordBoundary): number {
    return notBuilt('src/utils/Cursor.ts:417')
  }

  endOfWord(): Cursor {
    return notBuilt('src/utils/Cursor.ts:421')
  }


  charAt(offset: number): string {
    return notBuilt('src/utils/Cursor.ts:426')
  }

  classOf(ch: string): 'word' | 'space' | 'punct' | 'none' {
    return notBuilt('src/utils/Cursor.ts:431')
  }

  isEmptyLine(offset: number): boolean {
    return notBuilt('src/utils/Cursor.ts:438')
  }

  nextVimWord(): Cursor {
    return notBuilt('src/utils/Cursor.ts:442')
  }

  endOfVimWord(): Cursor {
    return notBuilt('src/utils/Cursor.ts:446')
  }

  prevVimWord(): Cursor {
    return notBuilt('src/utils/Cursor.ts:450')
  }


  wsAt(cursor: Cursor): boolean {
    return notBuilt('src/utils/Cursor.ts:455')
  }

  nextWORD(): Cursor {
    return notBuilt('src/utils/Cursor.ts:460')
  }

  endOfWORD(): Cursor {
    return notBuilt('src/utils/Cursor.ts:464')
  }

  prevWORD(): Cursor {
    return notBuilt('src/utils/Cursor.ts:468')
  }


  modifyText(end: Cursor, insertString?: string): Cursor {
    return notBuilt('src/utils/Cursor.ts:473')
  }

  insert(s: string): Cursor {
    return notBuilt('src/utils/Cursor.ts:477')
  }

  del(): Cursor {
    return notBuilt('src/utils/Cursor.ts:481')
  }

  backspace(): Cursor {
    return notBuilt('src/utils/Cursor.ts:486')
  }


  deleteToLineStart(): { cursor: Cursor; killed: string } {
    return notBuilt('src/utils/Cursor.ts:493')
  }

  deleteToLineEnd(): { cursor: Cursor; killed: string } {
    return notBuilt('src/utils/Cursor.ts:497')
  }

  deleteWordBefore(): { cursor: Cursor; killed: string } {
    return notBuilt('src/utils/Cursor.ts:501')
  }

  deleteWordAfter(): Cursor {
    return notBuilt('src/utils/Cursor.ts:505')
  }

  deleteTokenBefore(): Cursor | null {
    return notBuilt('src/utils/Cursor.ts:512')
  }


  findCharacter(char: string, type: 'f' | 'F' | 't' | 'T', count?: number): number | null {
    return notBuilt('src/utils/Cursor.ts:517')
  }


  getViewportStartLine(maxVisibleLines?: number, previousStart?: number): number {
    return notBuilt('src/utils/Cursor.ts:522')
  }

  getViewportCharOffset(maxVisibleLines?: number, previousStart?: number): number {
    return notBuilt('src/utils/Cursor.ts:526')
  }

  getViewportCharEnd(maxVisibleLines?: number, previousStart?: number): number {
    return notBuilt('src/utils/Cursor.ts:532')
  }


  render(
    cursorChar: string,
    mask: string,
    invert: (s: string) => string,
    ghostText?: { text: string; dim: (s: string) => string },
    maxVisibleLines?: number,
    selection?: SelectionPaint,
    viewportStart?: number,
  ): string {
    return notBuilt('src/utils/Cursor.ts:537')
  }

  maskLine(display: string, mask: string, isDocumentLastLine: boolean): string {
    return notBuilt('src/utils/Cursor.ts:549')
  }

  renderCaretLine(
    display: string,
    caretColumn: number,
    cursorChar: string,
    invert: (s: string) => string,
    ghostText: { text: string; dim: (s: string) => string } | undefined,
    isDocumentLastLine: boolean,
    lineStart?: number,
    selection?: SelectionPaint,
  ): string {
    return notBuilt('src/utils/Cursor.ts:553')
  }
}

function modifyTextOf(this: Cursor, end: Cursor, insertString: string = ''): Cursor {
  const start = Math.min(this.offset, end.offset)
  const stop = Math.max(this.offset, end.offset)
  const prefixWithInsert = this.text.slice(0, start) + insertString
  const next = prefixWithInsert + this.text.slice(stop)
  const doc = new MeasuredText(next, this.measuredText.columns)
  return new Cursor(doc, prefixWithInsert.normalize('NFC').length)
}

function downOf(this: Cursor): Cursor {
  const { line, column } = this.getPosition()
  if (line >= this.measuredText.lineCount - 1) return this.atSelf()
  return new Cursor(
    this.measuredText,
    this.measuredText.getOffsetFromPosition({ line: line + 1, column }),
  )
}

function upOf(this: Cursor): Cursor {
  const { line, column } = this.getPosition()
  if (line === 0) return this.atSelf()
  return new Cursor(
    this.measuredText,
    this.measuredText.getOffsetFromPosition({ line: line - 1, column }),
  )
}

function renderCaretLineOf(
  this: Cursor,
  display: string,
  caretColumn: number,
  cursorChar: string,
  invert: (s: string) => string,
  ghostText: { text: string; dim: (s: string) => string } | undefined,
  isDocumentLastLine: boolean,
  lineStart = 0,
  selection?: SelectionPaint,
): string {
  const showGhost =
    ghostText !== undefined &&
    ghostText.text.length > 0 &&
    isDocumentLastLine &&
    this.isAtEnd()

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
  const paintedBefore = paintSelected(before, lineStart, selection)

  if (showGhost) {
    const ghostFirst = firstGrapheme(ghostText.text)
    const ghostRest = ghostText.text.slice(ghostFirst.length)
    const cell = hidden ? ghostFirst : invert(ghostFirst)
    return paintedBefore + cell + (ghostRest ? ghostText.dim(ghostRest) : '')
  }

  if (atCaret === '') {
    return paintedBefore + (hidden ? '' : invert(cursorChar))
  }
  const cell = hidden ? paintSelected(atCaret, lineStart + before.length, selection) : invert(atCaret)
  return (
    paintedBefore +
    cell +
    paintSelected(after.replace(/\s+$/, ''), lineStart + before.length + atCaret.length, selection)
  )
}

function renderOf(
  this: Cursor,
  cursorChar: string,
  mask: string,
  invert: (s: string) => string,
  ghostText?: { text: string; dim: (s: string) => string },
  maxVisibleLines?: number,
  selection?: SelectionPaint,
  viewportStart?: number,
): string {
  const doc = this.measuredText
  const lines = doc.getWrappedLines()
  const { line: caretLine, column: caretColumn } = this.getPosition()
  const start = viewportStart ?? this.getViewportStartLine(maxVisibleLines)
  const end =
    !maxVisibleLines || maxVisibleLines <= 0
      ? lines.length
      : Math.min(lines.length, start + maxVisibleLines)

  const lastLineIdx = lines.length - 1
  const painted = mask ? undefined : selection
  const out: string[] = []
  for (let i = start; i < end; i++) {
    const raw = lines[i]!
    let display = raw.isPrecededByNewline ? raw.text : raw.text.replace(/^\s+/, '')
    const lineStart = raw.startOffset + raw.text.length - display.length

    if (mask) {
      display = this.maskLine(display, mask, i === lastLineIdx)
    }

    if (i !== caretLine) {
      out.push(paintSelected(display.replace(/\s+$/, ''), lineStart, painted))
      continue
    }
    out.push(
      this.renderCaretLine(display, caretColumn, cursorChar, invert, ghostText, i === lastLineIdx, lineStart, painted),
    )
  }
  return out.join('\n')
}

function findCharacterOf(this: Cursor, char: string, type: 'f' | 'F' | 't' | 'T', count: number = 1): number | null {
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

function endOfWORDOf(this: Cursor): Cursor {
  if (this.isAtEnd()) return this.atSelf()
  let c: Cursor = this
  const followingIsBreak = (cur: Cursor): boolean => {
    const n = cur.right()
    return n.offset === cur.offset || n.isAtEnd()
      ? n.offset === cur.offset || this.wsAt(n) || n.isAtEnd()
      : this.wsAt(n)
  }
  if (!this.wsAt(c) && followingIsBreak(c)) {
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

function prevWORDOf(this: Cursor): Cursor {
  if (this.offset === 0) return this.atSelf()
  let c: Cursor = this
  const leftChar = this.text[c.offset - 1] ?? ''
  if (leftChar !== '' && isVimWhitespace(leftChar)) {
    c = c.left()
  }
  while (c.offset > 0 && this.wsAt(c)) {
    if (this.isEmptyLine(c.offset)) return c
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

function prevVimWordOf(this: Cursor): Cursor {
  const doc = this.measuredText
  if (this.offset === 0) return this.atSelf()
  let pos = doc.prevOffset(this.offset)
  while (pos > 0 && this.classOf(this.charAt(pos)) === 'space') {
    if (this.isEmptyLine(pos)) return new Cursor(doc, pos)
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

function getViewportStartLineOf(this: Cursor, maxVisibleLines?: number, previousStart?: number): number {
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

function deleteTokenBeforeOf(this: Cursor): Cursor | null {
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

function endOfWordOf(this: Cursor): Cursor {
  if (this.isAtEnd()) return this.atSelf()
  const words = this.wordLikeBoundaries()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const last = this.lastCharOf(w)
    if (this.offset >= w.start && this.offset < w.end) {
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

function nextWORDOf(this: Cursor): Cursor {
  let c: Cursor = this
  while (!c.isAtEnd() && !this.wsAt(c)) {
    const n = c.right()
    if (n.offset === c.offset) break
    c = n
  }
  while (!c.isAtEnd() && this.wsAt(c)) {
    if (c.offset > this.offset && this.isEmptyLine(c.offset)) break
    const n = c.right()
    if (n.offset === c.offset) break
    c = n
  }
  return c
}

function endOfVimWordOf(this: Cursor): Cursor {
  const doc = this.measuredText
  let pos = doc.nextOffset(this.offset)
  while (pos < this.text.length && this.classOf(this.charAt(pos)) === 'space') {
    pos = doc.nextOffset(pos)
  }
  if (pos >= this.text.length) return new Cursor(doc, this.text.length)
  const cls = this.classOf(this.charAt(pos))
  while (pos < this.text.length) {
    const next = doc.nextOffset(pos)
    if (next >= this.text.length || this.classOf(this.charAt(next)) !== cls) break
    pos = next
  }
  return new Cursor(doc, pos)
}

function nextVimWordOf(this: Cursor): Cursor {
  const doc = this.measuredText
  let pos = this.offset
  const cls = this.classOf(this.charAt(pos))
  if (cls === 'word' || cls === 'punct') {
    while (pos < this.text.length && this.classOf(this.charAt(pos)) === cls) {
      pos = doc.nextOffset(pos)
    }
  }
  while (pos < this.text.length && this.classOf(this.charAt(pos)) === 'space') {
    if (pos > this.offset && this.isEmptyLine(pos)) break
    pos = doc.nextOffset(pos)
  }
  return new Cursor(doc, pos)
}

function prevWordOf(this: Cursor): Cursor {
  if (this.offset === 0) return this.atSelf()
  const words = this.wordLikeBoundaries()
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

function startOfLineOf(this: Cursor): Cursor {
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

function downLogicalLineOf(this: Cursor): Cursor {
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

function snapOutOfImageRefOf(this: Cursor, offset: number, direction: 'start' | 'end'): number {
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

function maskLineOf(this: Cursor, display: string, mask: string, isDocumentLastLine: boolean): string {
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

function deleteWordBeforeOf(this: Cursor): { cursor: Cursor; killed: string } {
  if (this.offset === 0) return { cursor: this, killed: '' }
  const boundary = this.prevWord().offset
  const start = this.snapOutOfImageRef(boundary, 'start')
  const killed = this.text.slice(start, this.offset)
  return {
    cursor: new Cursor(this.measuredText, start).modifyText(this),
    killed,
  }
}

function endOfLineOf(this: Cursor): Cursor {
  const { line } = this.getPosition()
  return new Cursor(
    this.measuredText,
    this.measuredText.getOffsetFromPosition({
      line,
      column: this.measuredText.getLineLength(line),
    }),
  )
}

function deleteToLineEndOf(this: Cursor): { cursor: Cursor; killed: string } {
  if (this.text[this.offset] === '\n') {
    const end = new Cursor(this.measuredText, this.offset + 1)
    return { cursor: this.modifyText(end), killed: '\n' }
  }
  const end = this.endOfLine()
  const killed = this.text.slice(this.offset, end.offset)
  return { cursor: this.modifyText(end), killed }
}

function deleteToLineStartOf(this: Cursor): { cursor: Cursor; killed: string } {
  if (this.offset > 0 && this.text[this.offset - 1] === '\n') {
    const start = new Cursor(this.measuredText, this.offset - 1)
    return { cursor: start.modifyText(this), killed: '\n' }
  }
  const start = this.startOfLine()
  const killed = this.text.slice(start.offset, this.offset)
  return { cursor: start.modifyText(this), killed }
}

function upLogicalLineOf(this: Cursor): Cursor {
  const start = this.logicalLineStart(this.offset)
  if (start === 0) return new Cursor(this.measuredText, 0)
  const column = this.offset - start
  const prevStart = this.logicalLineStart(start - 1)
  const prevEnd = start - 1
  const target = Math.min(prevStart + column, prevEnd)
  return new Cursor(this.measuredText, this.measuredText.snapToGraphemeBoundary(target))
}


const KILL_RING_CAPACITY = 10

const killRing: string[] = []

export function pushToKillRing(text: string, direction?: 'prepend' | 'append'): void {
  return notBuilt('src/utils/Cursor.ts:1064')
}

export function resetKillAccumulation(): void {
  return notBuilt('src/utils/Cursor.ts:1078')
}

export function getLastKill(): string {
  return notBuilt('src/utils/Cursor.ts:1082')
}

export function getKillRingItem(index: number): string {
  return notBuilt('src/utils/Cursor.ts:1086')
}

export function getKillRingSize(): number {
  return notBuilt('src/utils/Cursor.ts:1092')
}

export function clearKillRing(): void {
  return notBuilt('src/utils/Cursor.ts:1096')
}

export function recordYank(start: number, length: number): void {
  return notBuilt('src/utils/Cursor.ts:1104')
}

export function canYankPop(): boolean {
  return notBuilt('src/utils/Cursor.ts:1110')
}

export function yankPop(): { text: string; start: number; length: number } | null {
  return notBuilt('src/utils/Cursor.ts:1114')
}

export function updateYankLength(length: number): void {
  return notBuilt('src/utils/Cursor.ts:1124')
}

export function resetYankState(): void {
  return notBuilt('src/utils/Cursor.ts:1128')
}

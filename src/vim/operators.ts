
import { countCharInString } from '../utils/stringUtils.js'
import { lastGrapheme } from '../utils/intl.js'
import type { Cursor } from '../utils/Cursor.js'
import { resolveMotion, isInclusiveMotion, isLinewiseMotion } from './motions.js'
import { findTextObject } from './textObjects.js'
import type { FindType, Operator, RecordedChange, TextObjScope } from './types.js'

export type OperatorContext = {
  cursor: Cursor
  text: string
  setText: (text: string) => void
  setOffset: (offset: number) => void
  enterInsert: (offset: number) => void
  getRegister: () => string
  setRegister: (content: string, linewise: boolean) => void
  getLastFind: () => { type: FindType; char: string } | null
  setLastFind: (type: FindType, char: string) => void
  recordChange: (change: RecordedChange) => void
}


function lastGraphemeStart(text: string): number {
  if (text.length === 0) return 0
  return text.length - lastGrapheme(text).length
}

function linewiseContent(range: string): string {
  return range.endsWith('\n') ? range : `${range}\n`
}

function applyOperator(
  op: Operator,
  start: number,
  end: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const range = ctx.text.slice(start, end)
  ctx.setRegister(linewise ? linewiseContent(range) : range, linewise)
  if (op === 'yank') {
    ctx.setOffset(start)
    return
  }
  const newText = ctx.text.slice(0, start) + ctx.text.slice(end)
  ctx.setText(newText)
  if (op === 'delete') {
    ctx.setOffset(Math.min(start, lastGraphemeStart(newText)))
  } else {
    ctx.enterInsert(start)
  }
}

function offsetOfLine(lines: string[], idx: number): number {
  let offset = 0
  for (let i = 0; i < idx; i++) offset += lines[i]!.length + 1
  return offset
}

function displayLineIndex(ctx: OperatorContext, lines: string[]): number {
  return Math.min(ctx.cursor.getPosition().line, lines.length - 1)
}


export function executeOperatorMotion(
  op: Operator,
  motion: string,
  count: number,
  ctx: OperatorContext,
): void {
  const cursor = ctx.cursor
  let start: number
  let end: number

  if (op === 'change' && (motion === 'w' || motion === 'W')) {
    let c = cursor
    for (let i = 0; i < count - 1; i++) {
      c = motion === 'w' ? c.nextVimWord() : c.nextWORD()
    }
    const wordEnd = motion === 'w' ? c.endOfVimWord() : c.endOfWORD()
    start = cursor.offset
    end = cursor.measuredText.nextOffset(wordEnd.offset)
    if (end <= start) return
  } else {
    const target = resolveMotion(motion, cursor, count)
    if (target.equals(cursor)) return
    start = Math.min(cursor.offset, target.offset)
    end = Math.max(cursor.offset, target.offset)
    if (isLinewiseMotion(motion)) {
      const nl = ctx.text.indexOf('\n', end)
      if (nl !== -1) {
        end = nl + 1
      } else {
        end = ctx.text.length
        if (start > 0 && ctx.text[start - 1] === '\n') start -= 1
      }
    } else if (isInclusiveMotion(motion) && target.offset > cursor.offset) {
      end = cursor.measuredText.nextOffset(target.offset)
    }
  }

  start = cursor.snapOutOfImageRef(start, 'start')
  end = cursor.snapOutOfImageRef(end, 'end')

  applyOperator(op, start, end, isLinewiseMotion(motion), ctx)
  ctx.recordChange({ type: 'operator', op, motion, count })
}


export function executeOperatorFind(
  op: Operator,
  findType: FindType,
  char: string,
  count: number,
  ctx: OperatorContext,
): void {
  const target = ctx.cursor.findCharacter(char, findType, count)
  if (target === null) return
  const lo = Math.min(ctx.cursor.offset, target)
  const hi = Math.max(ctx.cursor.offset, target)
  applyOperator(op, lo, ctx.cursor.measuredText.nextOffset(hi), false, ctx)
  ctx.setLastFind(findType, char)
  ctx.recordChange({ type: 'operatorFind', op, find: findType, char, count })
}


export function executeOperatorTextObj(
  op: Operator,
  scope: TextObjScope,
  objType: string,
  count: number,
  ctx: OperatorContext,
): void {
  const range = findTextObject(ctx.text, ctx.cursor.offset, objType, scope === 'inner')
  if (!range) return
  applyOperator(op, range.start, range.end, false, ctx)
  ctx.recordChange({ type: 'operatorTextObj', op, objType, scope, count })
}


export function executeLineOp(op: Operator, count: number, ctx: OperatorContext): void {
  const lines = ctx.text.split('\n')
  const lineIdx = countCharInString(ctx.text.slice(0, ctx.cursor.offset), '\n')
  const affected = Math.min(count, lines.length - lineIdx)
  if (affected <= 0) return

  const lineStart = offsetOfLine(lines, lineIdx)
  let rangeEnd = lineStart
  for (let i = 0; i < affected; i++) rangeEnd += lines[lineIdx + i]!.length + 1
  const reachedEnd = rangeEnd > ctx.text.length
  if (reachedEnd) rangeEnd = ctx.text.length

  const range = ctx.text.slice(lineStart, rangeEnd)
  ctx.setRegister(linewiseContent(range), true)

  if (op === 'yank') {
    ctx.setOffset(lineStart)
  } else if (op === 'delete') {
    let delStart = lineStart
    if (reachedEnd && delStart > 0 && ctx.text[delStart - 1] === '\n') delStart -= 1
    const newText = ctx.text.slice(0, delStart) + ctx.text.slice(rangeEnd)
    ctx.setText(newText)
    ctx.setOffset(Math.min(delStart, lastGraphemeStart(newText)))
  } else {
    if (lines.length === 1) {
      ctx.setText('')
      ctx.enterInsert(0)
    } else {
      const replacement = reachedEnd ? '' : '\n'
      const newText = ctx.text.slice(0, lineStart) + replacement + ctx.text.slice(rangeEnd)
      ctx.setText(newText)
      ctx.enterInsert(lineStart)
    }
  }
  const motion = op === 'delete' ? 'd' : op === 'change' ? 'c' : 'y'
  ctx.recordChange({ type: 'operator', op, motion, count })
}


export function executeX(count: number, ctx: OperatorContext): void {
  const cursor = ctx.cursor
  if (cursor.isAtEnd()) return
  let end = cursor.offset
  for (let i = 0; i < count && end < ctx.text.length; i++) {
    end = cursor.measuredText.nextOffset(end)
  }
  ctx.setRegister(ctx.text.slice(cursor.offset, end), false)
  const newText = ctx.text.slice(0, cursor.offset) + ctx.text.slice(end)
  ctx.setText(newText)
  ctx.setOffset(Math.min(cursor.offset, lastGraphemeStart(newText)))
  ctx.recordChange({ type: 'x', count })
}


export function executeReplace(char: string, count: number, ctx: OperatorContext): void {
  const cursor = ctx.cursor
  let end = cursor.offset
  let replaced = 0
  while (replaced < count && end < ctx.text.length) {
    end = cursor.measuredText.nextOffset(end)
    replaced++
  }
  if (replaced === 0) return
  const newText =
    ctx.text.slice(0, cursor.offset) + char.repeat(replaced) + ctx.text.slice(end)
  ctx.setText(newText)
  ctx.setOffset(cursor.offset + (replaced - 1) * char.length)
  ctx.recordChange({ type: 'replace', char, count })
}


export function executeToggleCase(count: number, ctx: OperatorContext): void {
  const cursor = ctx.cursor
  if (cursor.isAtEnd()) return
  let pos = cursor.offset
  let toggled = ''
  let handled = 0
  while (handled < count && pos < ctx.text.length) {
    const next = cursor.measuredText.nextOffset(pos)
    const grapheme = ctx.text.slice(pos, next)
    toggled += grapheme === grapheme.toUpperCase() ? grapheme.toLowerCase() : grapheme.toUpperCase()
    pos = next
    handled++
  }
  const newText = ctx.text.slice(0, cursor.offset) + toggled + ctx.text.slice(pos)
  ctx.setText(newText)
  ctx.setOffset(cursor.offset + toggled.length)
  ctx.recordChange({ type: 'toggleCase', count })
}


export function executeJoin(count: number, ctx: OperatorContext): void {
  const lines = ctx.text.split('\n')
  const lineIdx = displayLineIndex(ctx, lines)
  if (lineIdx >= lines.length - 1) return
  const joinCount = Math.min(count, lines.length - 1 - lineIdx)
  const lineStart = offsetOfLine(lines, lineIdx)
  let accumulated = lines[lineIdx]!
  const seam = lineStart + accumulated.length
  for (let i = 1; i <= joinCount; i++) {
    const appended = lines[lineIdx + i]!.replace(/^\s+/, '')
    if (appended !== '') {
      if (accumulated !== '' && !accumulated.endsWith(' ')) accumulated += ' '
      accumulated += appended
    }
  }
  const newText = [
    ...lines.slice(0, lineIdx),
    accumulated,
    ...lines.slice(lineIdx + joinCount + 1),
  ].join('\n')
  ctx.setText(newText)
  ctx.setOffset(seam)
  ctx.recordChange({ type: 'join', count })
}


export function executePaste(after: boolean, count: number, ctx: OperatorContext): void {
  const register = ctx.getRegister()
  if (register === '') return
  const linewise = register.endsWith('\n')
  if (linewise) {
    const contentLines = register.slice(0, -1).split('\n')
    const lines = ctx.text.split('\n')
    const lineIdx = displayLineIndex(ctx, lines)
    const copies: string[] = []
    for (let i = 0; i < count; i++) copies.push(...contentLines)
    const insertAt = after ? lineIdx + 1 : lineIdx
    const newLines = [...lines.slice(0, insertAt), ...copies, ...lines.slice(insertAt)]
    ctx.setText(newLines.join('\n'))
    ctx.setOffset(offsetOfLine(newLines, insertAt))
  } else {
    const insertion = register.repeat(count)
    const cursor = ctx.cursor
    const pos =
      after && !cursor.isAtEnd() ? cursor.measuredText.nextOffset(cursor.offset) : cursor.offset
    const newText = ctx.text.slice(0, pos) + insertion + ctx.text.slice(pos)
    ctx.setText(newText)
    ctx.setOffset(Math.max(pos, pos + insertion.length - lastGrapheme(insertion).length))
  }
}


const INDENT_UNIT = '  '

export function executeIndent(dir: '>' | '<', count: number, ctx: OperatorContext): void {
  const lines = ctx.text.split('\n')
  const lineIdx = displayLineIndex(ctx, lines)
  const affected = Math.min(count, lines.length - lineIdx)
  for (let i = 0; i < affected; i++) {
    const idx = lineIdx + i
    const line = lines[idx]!
    if (dir === '>') {
      lines[idx] = INDENT_UNIT + line
    } else if (line.startsWith(INDENT_UNIT)) {
      lines[idx] = line.slice(INDENT_UNIT.length)
    } else if (line.startsWith('\t')) {
      lines[idx] = line.slice(1)
    } else {
      lines[idx] = line.replace(/^\s{1,2}/, '')
    }
  }
  ctx.setText(lines.join('\n'))
  const current = lines[lineIdx]!
  const firstNonBlank = /\S/.exec(current)
  ctx.setOffset(offsetOfLine(lines, lineIdx) + (firstNonBlank ? firstNonBlank.index : current.length))
  ctx.recordChange({ type: 'indent', dir, count })
}


export function executeOpenLine(direction: 'above' | 'below', ctx: OperatorContext): void {
  const lines = ctx.text.split('\n')
  const lineIdx = displayLineIndex(ctx, lines)
  const insertAt = direction === 'below' ? lineIdx + 1 : lineIdx
  const newLines = [...lines.slice(0, insertAt), '', ...lines.slice(insertAt)]
  ctx.setText(newLines.join('\n'))
  ctx.enterInsert(offsetOfLine(newLines, insertAt))
  ctx.recordChange({ type: 'openLine', direction })
}


function applyLinewiseBetween(
  op: Operator,
  motion: 'G' | 'gg',
  count: number,
  targetOffset: number,
  ctx: OperatorContext,
): void {
  const text = ctx.text
  const lo = Math.min(ctx.cursor.offset, targetOffset)
  const hi = Math.max(ctx.cursor.offset, targetOffset)
  let start = text.lastIndexOf('\n', lo - 1) + 1
  const hiLineEnd = text.indexOf('\n', hi)
  const reachedEnd = hiLineEnd === -1
  const end = reachedEnd ? text.length : hiLineEnd + 1

  ctx.setRegister(linewiseContent(text.slice(start, end)), true)
  if (op === 'yank') {
    ctx.setOffset(start)
  } else if (op === 'delete') {
    if (reachedEnd && start > 0 && text[start - 1] === '\n') start -= 1
    const newText = text.slice(0, start) + text.slice(end)
    ctx.setText(newText)
    ctx.setOffset(Math.min(start, lastGraphemeStart(newText)))
  } else {
    if (start === 0 && end === text.length) {
      ctx.setText('')
      ctx.enterInsert(0)
    } else {
      const replacement = reachedEnd ? '' : '\n'
      const newText = text.slice(0, start) + replacement + text.slice(end)
      ctx.setText(newText)
      ctx.enterInsert(start)
    }
  }
  ctx.recordChange({ type: 'operator', op, motion, count })
}

export function executeOperatorG(op: Operator, count: number, ctx: OperatorContext): void {
  const target = count > 0 ? ctx.cursor.goToLine(count) : ctx.cursor.startOfLastLine()
  if (target.equals(ctx.cursor)) return
  applyLinewiseBetween(op, 'G', count, target.offset, ctx)
}

export function executeOperatorGg(op: Operator, count: number, ctx: OperatorContext): void {
  const target = count > 0 ? ctx.cursor.goToLine(count) : ctx.cursor.startOfFirstLine()
  if (target.equals(ctx.cursor)) return
  applyLinewiseBetween(op, 'gg', count, target.offset, ctx)
}

import { countCharInString } from '../../../platform/text/strings.js'
import { lastGrapheme } from '../../../platform/text/textSegments.js'
import type { Cursor } from './textCursor.js'
import { resolveMotion, isInclusiveMotion, isLinewiseMotion } from './motions.js'
import { findTextObject } from './textObjects.js'
import type { FindType, Operator, RecordedChange, TextObjScope } from './vimState.js'

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

function linewiseRegisterText(content: string): string {
  if (content.endsWith('\n')) return content
  if (content.startsWith('\n')) return `${content.slice(1)}\n`
  return `${content}\n`
}

function applyOperator(
  op: Operator,
  start: number,
  end: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  const content = ctx.text.slice(start, end)
  ctx.setRegister(linewise ? linewiseRegisterText(content) : content, linewise)
  if (op === 'yank') {
    ctx.setOffset(start)
    return
  }

  const newText = ctx.text.slice(0, start) + ctx.text.slice(end)
  ctx.setText(newText)
  if (op === 'change') {
    ctx.enterInsert(start)
  } else {
    ctx.setOffset(newText.length === 0 ? 0 : Math.min(start, lastGraphemeStart(newText)))
  }
}

function logicalLineIndex(ctx: OperatorContext): number {
  return countCharInString(ctx.text.slice(0, ctx.cursor.offset), '\n')
}

function applyLineRange(
  op: Operator,
  lines: string[],
  startLine: number,
  endLine: number,
  ctx: OperatorContext,
): void {
  const yanked = `${lines.slice(startLine, endLine + 1).join('\n')}\n`
  ctx.setRegister(yanked, true)
  if (op === 'yank') {
    ctx.setOffset(offsetOfLine(lines, startLine))
    return
  }

  if (op === 'change') {
    const newLines = [...lines.slice(0, startLine), '', ...lines.slice(endLine + 1)]
    ctx.setText(newLines.join('\n'))
    ctx.enterInsert(offsetOfLine(newLines, startLine))
    return
  }

  const newLines = [...lines.slice(0, startLine), ...lines.slice(endLine + 1)]
  if (newLines.length === 0) {
    ctx.setText('')
    ctx.setOffset(0)
    return
  }
  ctx.setText(newLines.join('\n'))
  const targetLine = Math.min(startLine, newLines.length - 1)
  ctx.setOffset(offsetOfLine(newLines, targetLine))
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
    if ((motion === 'gj' || motion === 'gk') && Math.abs(target.getPosition().line - cursor.getPosition().line) !== count) return
    start = Math.min(cursor.offset, target.offset)
    end = Math.max(cursor.offset, target.offset)
    if (isLinewiseMotion(motion)) {
      const prevNl = start > 0 ? ctx.text.lastIndexOf('\n', start - 1) : -1
      start = prevNl === -1 ? 0 : prevNl + 1
      const nl = ctx.text.indexOf('\n', end)
      if (nl !== -1) {
        end = nl + 1
      } else {
        end = ctx.text.length
        if (start > 0 && ctx.text[start - 1] === '\n') start -= 1
      }
    } else if (isInclusiveMotion(motion) && target.offset > cursor.offset) {
      end = cursor.measuredText.nextOffset(target.offset)
    } else if (motion === 'w' || motion === 'W') {
      const lastStart = resolveMotion(motion, cursor, count - 1).offset
      const lineEnd = ctx.text.indexOf('\n', lastStart)
      if (lineEnd > lastStart && end > lineEnd) end = lineEnd
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

  let start: number
  let end: number
  if (findType === 'f' || findType === 't') {
    start = ctx.cursor.offset
    end = ctx.cursor.measuredText.nextOffset(target)
  } else {
    start = target
    end = ctx.cursor.offset
  }
  if (end <= start) return

  start = ctx.cursor.snapOutOfImageRef(start, 'start')
  end = ctx.cursor.snapOutOfImageRef(end, 'end')

  ctx.setLastFind(findType, char)
  applyOperator(op, start, end, false, ctx)
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

  const start = ctx.cursor.snapOutOfImageRef(range.start, 'start')
  const end = ctx.cursor.snapOutOfImageRef(range.end, 'end')

  applyOperator(op, start, end, false, ctx)
  ctx.recordChange({ type: 'operatorTextObj', op, scope, objType, count })
}


export function executeLineOp(op: Operator, count: number, ctx: OperatorContext): void {
  const lines = ctx.text.split('\n')
  const startLine = logicalLineIndex(ctx)
  const endLine = Math.min(startLine + Math.max(1, count) - 1, lines.length - 1)
  applyLineRange(op, lines, startLine, endLine, ctx)
}


export function executeX(count: number, ctx: OperatorContext): void {
  const start = ctx.cursor.offset
  const lineEnd = ctx.text.indexOf('\n', start)
  const limit = lineEnd === -1 ? ctx.text.length : lineEnd
  if (start >= limit) return

  let end = start
  for (let i = 0; i < count && end < limit; i++) {
    const next = ctx.cursor.measuredText.nextOffset(end)
    if (next <= end || next > limit) break
    end = next
  }
  if (end <= start) return

  end = ctx.cursor.snapOutOfImageRef(end, 'end')
  const deleted = ctx.text.slice(start, end)
  ctx.setRegister(deleted, false)

  const newText = ctx.text.slice(0, start) + ctx.text.slice(end)
  ctx.setText(newText)

  const lineStart = start > 0 ? newText.lastIndexOf('\n', start - 1) + 1 : 0
  const nextNl = newText.indexOf('\n', lineStart)
  const newLimit = nextNl === -1 ? newText.length : nextNl
  if (start < newLimit) {
    ctx.setOffset(start)
  } else if (newLimit > lineStart) {
    ctx.setOffset(lineStart + lastGraphemeStart(newText.slice(lineStart, newLimit)))
  } else {
    ctx.setOffset(lineStart)
  }
  ctx.recordChange({ type: 'x', count })
}


export function executeReplace(char: string, count: number, ctx: OperatorContext): void {
  const start = ctx.cursor.offset
  const lineEnd = ctx.text.indexOf('\n', start)
  const limit = lineEnd === -1 ? ctx.text.length : lineEnd
  if (start >= limit) return

  let end = start
  let replaced = 0
  while (replaced < count && end < limit) {
    const next = ctx.cursor.measuredText.nextOffset(end)
    if (next <= end || next > limit) break
    end = next
    replaced++
  }
  if (replaced === 0) return

  const replacement = char.repeat(replaced)
  const newText = ctx.text.slice(0, start) + replacement + ctx.text.slice(end)
  ctx.setText(newText)
  ctx.setOffset(start + lastGraphemeStart(replacement))
  ctx.recordChange({ type: 'replace', char, count })
}


export function executeToggleCase(count: number, ctx: OperatorContext): void {
  const start = ctx.cursor.offset
  const lineEnd = ctx.text.indexOf('\n', start)
  const limit = lineEnd === -1 ? ctx.text.length : lineEnd
  if (start >= limit) return

  let end = start
  let toggled = ''
  for (let i = 0; i < count && end < limit; i++) {
    const next = ctx.cursor.measuredText.nextOffset(end)
    if (next <= end || next > limit) break
    const ch = ctx.text.slice(end, next)
    const upper = ch.toUpperCase()
    toggled += ch === upper ? ch.toLowerCase() : upper
    end = next
  }
  if (end <= start) return

  const newText = ctx.text.slice(0, start) + toggled + ctx.text.slice(end)
  ctx.setText(newText)

  const lineStart = start > 0 ? newText.lastIndexOf('\n', start - 1) + 1 : 0
  const nextNl = newText.indexOf('\n', lineStart)
  const newLimit = nextNl === -1 ? newText.length : nextNl
  const afterPos = start + toggled.length
  if (afterPos < newLimit) {
    ctx.setOffset(afterPos)
  } else if (newLimit > lineStart) {
    ctx.setOffset(lineStart + lastGraphemeStart(newText.slice(lineStart, newLimit)))
  } else {
    ctx.setOffset(lineStart)
  }
  ctx.recordChange({ type: 'toggleCase', count })
}


export function executeJoin(count: number, ctx: OperatorContext): void {
  const lines = ctx.text.split('\n')
  const curLine = logicalLineIndex(ctx)
  const joins = Math.min(Math.max(1, count), lines.length - 1 - curLine)
  if (joins <= 0) return

  const lineStart = offsetOfLine(lines, curLine)
  let merged = lines[curLine]!
  let seamOffset = lineStart + merged.length

  for (let i = 1; i <= joins; i++) {
    const next = lines[curLine + i]!.trimStart()
    seamOffset = lineStart + merged.length
    if (merged.length > 0 && next.length > 0) {
      merged = `${merged} ${next}`
    } else {
      merged = `${merged}${next}`
    }
  }

  const newLines = [...lines.slice(0, curLine), merged, ...lines.slice(curLine + joins + 1)]
  ctx.setText(newLines.join('\n'))
  if (merged.length === 0) {
    ctx.setOffset(lineStart)
  } else {
    ctx.setOffset(Math.min(seamOffset, lineStart + lastGraphemeStart(merged)))
  }
  ctx.recordChange({ type: 'join', count })
}


export function executePaste(after: boolean, count: number, ctx: OperatorContext): void {
  const reg = ctx.getRegister()
  if (!reg) return
  const times = Math.max(1, count)

  if (reg.endsWith('\n')) {
    const blockLines = reg.slice(0, -1).split('\n')
    const pastedLines: string[] = []
    for (let i = 0; i < times; i++) pastedLines.push(...blockLines)

    const lines = ctx.text.split('\n')
    const curLine = logicalLineIndex(ctx)
    const insertAt = after ? curLine + 1 : curLine
    const newLines = [...lines.slice(0, insertAt), ...pastedLines, ...lines.slice(insertAt)]
    ctx.setText(newLines.join('\n'))
    ctx.setOffset(offsetOfLine(newLines, insertAt))
    return
  }

  const inserted = reg.repeat(times)
  const atLineEnd = ctx.cursor.offset >= ctx.text.length || ctx.text[ctx.cursor.offset] === '\n'
  const insertPos =
    after && !atLineEnd
      ? ctx.cursor.measuredText.nextOffset(ctx.cursor.offset)
      : ctx.cursor.offset
  const newText = ctx.text.slice(0, insertPos) + inserted + ctx.text.slice(insertPos)
  ctx.setText(newText)
  ctx.setOffset(insertPos + lastGraphemeStart(inserted))
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
  ctx.setOffset(offsetOfLine(lines, lineIdx) + (firstNonBlank ? firstNonBlank.index : lastGraphemeStart(current)))
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

export function executeOperatorG(op: Operator, count: number, ctx: OperatorContext): void {
  const cursor = ctx.cursor
  const target = count > 0 ? cursor.goToLine(count) : cursor.startOfLastLine()
  if (target.equals(cursor)) return
  const lines = ctx.text.split('\n')
  const curLine = logicalLineIndex(ctx)
  const targetLine = countCharInString(ctx.text.slice(0, target.offset), '\n')
  applyLineRange(op, lines, Math.min(curLine, targetLine), Math.max(curLine, targetLine), ctx)
  ctx.recordChange({ type: 'operator', op, motion: 'G', count })
}

export function executeOperatorGg(op: Operator, count: number, ctx: OperatorContext): void {
  const cursor = ctx.cursor
  const target = count > 0 ? cursor.goToLine(count) : cursor.startOfFirstLine()
  if (target.equals(cursor)) return
  const lines = ctx.text.split('\n')
  const curLine = logicalLineIndex(ctx)
  const targetLine = countCharInString(ctx.text.slice(0, target.offset), '\n')
  applyLineRange(op, lines, Math.min(curLine, targetLine), Math.max(curLine, targetLine), ctx)
  ctx.recordChange({ type: 'operator', op, motion: 'gg', count })
}

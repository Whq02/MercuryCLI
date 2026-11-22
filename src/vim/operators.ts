import { countCharInString } from '../utils/stringUtils.js'
import { lastGrapheme } from '../utils/intl.js'
import type { Cursor } from '../utils/Cursor.js'
import { resolveMotion, isInclusiveMotion, isLinewiseMotion } from './motions.js'
import { findTextObject } from './textObjects.js'
import type { FindType, Operator, RecordedChange, TextObjScope } from './types.js'
import { notBuilt } from '../pi/holes.js'

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

function applyOperator(
  op: Operator,
  start: number,
  end: number,
  linewise: boolean,
  ctx: OperatorContext,
): void {
  return notBuilt('src/vim/operators.ts:32')
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
  return notBuilt('src/vim/operators.ts:115')
}


export function executeOperatorTextObj(
  op: Operator,
  scope: TextObjScope,
  objType: string,
  count: number,
  ctx: OperatorContext,
): void {
  return notBuilt('src/vim/operators.ts:132')
}


export function executeLineOp(op: Operator, count: number, ctx: OperatorContext): void {
  return notBuilt('src/vim/operators.ts:146')
}


export function executeX(count: number, ctx: OperatorContext): void {
  return notBuilt('src/vim/operators.ts:185')
}


export function executeReplace(char: string, count: number, ctx: OperatorContext): void {
  return notBuilt('src/vim/operators.ts:200')
}


export function executeToggleCase(count: number, ctx: OperatorContext): void {
  return notBuilt('src/vim/operators.ts:217')
}


export function executeJoin(count: number, ctx: OperatorContext): void {
  return notBuilt('src/vim/operators.ts:241')
}


export function executePaste(after: boolean, count: number, ctx: OperatorContext): void {
  return notBuilt('src/vim/operators.ts:267')
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
  return notBuilt('src/vim/operators.ts:368')
}

export function executeOperatorGg(op: Operator, count: number, ctx: OperatorContext): void {
  return notBuilt('src/vim/operators.ts:374')
}

import { resolveMotion } from './motions.js'
import {
  executeIndent,
  executeJoin,
  executeLineOp,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorG,
  executeOperatorGg,
  executeOperatorMotion,
  executeOperatorTextObj,
  executePaste,
  executeReplace,
  executeToggleCase,
  executeX,
  type OperatorContext,
} from './operators.js'
import {
  FIND_KEYS,
  isOperatorKey,
  isTextObjScopeKey,
  MAX_VIM_COUNT,
  OPERATORS,
  SIMPLE_MOTIONS,
  TEXT_OBJ_SCOPES,
  TEXT_OBJ_TYPES,
  type CommandState,
  type FindType,
  type Operator,
} from './types.js'

export type TransitionContext = OperatorContext & {
  onDotRepeat?: () => void
  onUndo?: () => void
}

type TransitionResult = {
  next?: CommandState
  execute?: () => void
}

const IDLE: CommandState = { type: 'idle' }

const isDigit = (input: string): boolean => /^[0-9]$/.test(input)
const isSimpleMotion = (input: string): boolean =>
  (SIMPLE_MOTIONS as readonly string[]).includes(input)
const isFindKey = (input: string): input is FindType =>
  (FIND_KEYS as readonly string[]).includes(input)
const isTextObjType = (input: string): boolean =>
  (TEXT_OBJ_TYPES as readonly string[]).includes(input)
const clampCount = (count: number): number => Math.min(count, MAX_VIM_COUNT)

const REVERSE_FIND: Record<FindType, FindType> = { f: 'F', F: 'f', t: 'T', T: 't' }
const effectiveCount = (count: number): number => (count > 0 ? count : 1)

function transitionNormal(count: number, inCount: boolean, input: string, ctx: TransitionContext): TransitionResult {
  if (isDigit(input)) {
    if (inCount) {
      return { next: { type: 'count', count: clampCount(count * 10 + Number(input)) } }
    }
    if (input !== '0') {
      return { next: { type: 'count', count: Number(input) } }
    }
  }

  if (isOperatorKey(input)) {
    return { next: { type: 'operator', operator: OPERATORS[input], count } }
  }

  if (isSimpleMotion(input)) {
    const n = effectiveCount(count)
    return {
      next: IDLE,
      execute: () => ctx.setOffset(resolveMotion(input, ctx.cursor, n).offset),
    }
  }

  if (isFindKey(input)) {
    return { next: { type: 'find', findType: input, count } }
  }

  if (input === ';' || input === ',') {
    const n = effectiveCount(count)
    const reverse = input === ','
    return {
      next: IDLE,
      execute: () => {
        const last = ctx.getLastFind()
        if (!last) return
        const findType = reverse ? REVERSE_FIND[last.type] : last.type
        const pos = ctx.cursor.findCharacter(last.char, findType, n)
        if (pos !== null) ctx.setOffset(pos)
      },
    }
  }

  if (input === 'g') return { next: { type: 'g', count } }
  if (input === 'r') return { next: { type: 'replace', count } }
  if (input === '>' || input === '<') return { next: { type: 'indent', direction: input, count } }

  const n = effectiveCount(count)
  switch (input) {
    case '~':
      return { next: IDLE, execute: () => executeToggleCase(n, ctx) }
    case 'x':
      return { next: IDLE, execute: () => executeX(n, ctx) }
    case 'J':
      return { next: IDLE, execute: () => executeJoin(n, ctx) }
    case 'p':
      return { next: IDLE, execute: () => executePaste(true, n, ctx) }
    case 'P':
      return { next: IDLE, execute: () => executePaste(false, n, ctx) }
    case 'D':
      return { next: IDLE, execute: () => executeOperatorMotion('delete', '$', n, ctx) }
    case 'C':
      return { next: IDLE, execute: () => executeOperatorMotion('change', '$', n, ctx) }
    case 'Y':
      return { next: IDLE, execute: () => executeLineOp('yank', n, ctx) }
    case 'G':
      return {
        next: IDLE,
        execute: () => {
          const target = count > 0 ? ctx.cursor.goToLine(count) : ctx.cursor.startOfLastLine()
          ctx.setOffset(target.offset)
        },
      }
    case '.':
      return { next: IDLE, execute: () => ctx.onDotRepeat?.() }
    case 'u':
      return { next: IDLE, execute: () => ctx.onUndo?.() }
    case 'i':
      return { next: IDLE, execute: () => ctx.enterInsert(ctx.cursor.offset) }
    case 'I':
      return { next: IDLE, execute: () => ctx.enterInsert(ctx.cursor.firstNonBlankInLogicalLine().offset) }
    case 'a':
      return {
        next: IDLE,
        execute: () => {
          const c = ctx.cursor
          const atLineEnd = c.offset >= ctx.text.length || ctx.text[c.offset] === '\n'
          ctx.enterInsert(atLineEnd ? c.offset : c.measuredText.nextOffset(c.offset))
        },
      }
    case 'A':
      return { next: IDLE, execute: () => ctx.enterInsert(ctx.cursor.endOfLogicalLine().offset) }
    case 'o':
      return { next: IDLE, execute: () => executeOpenLine('below', ctx) }
    case 'O':
      return { next: IDLE, execute: () => executeOpenLine('above', ctx) }
    default:
      return { next: IDLE }
  }
}

function transitionOperator(
  operator: Operator,
  count: number,
  motionCount: number | null,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (isDigit(input)) {
    const nextMotionCount =
      motionCount === null
        ? Number(input)
        : clampCount(motionCount * 10 + Number(input))
    return { next: { type: 'operatorCount', operator, count, motionCount: nextMotionCount } }
  }

  const rawCount =
    motionCount !== null ? clampCount((count || 1) * motionCount) : count
  const totalCount =
    motionCount !== null ? clampCount((count || 1) * motionCount) : effectiveCount(count)

  if (isOperatorKey(input) && OPERATORS[input] === operator) {
    return { next: IDLE, execute: () => executeLineOp(operator, totalCount, ctx) }
  }

  if (isTextObjScopeKey(input)) {
    return { next: { type: 'operatorTextObj', operator, count: totalCount, scope: TEXT_OBJ_SCOPES[input] } }
  }

  if (isFindKey(input)) {
    return { next: { type: 'operatorFind', operator, count: totalCount, findType: input } }
  }

  if (isSimpleMotion(input)) {
    return { next: IDLE, execute: () => executeOperatorMotion(operator, input, totalCount, ctx) }
  }

  if (input === 'G') {
    return { next: IDLE, execute: () => executeOperatorG(operator, rawCount, ctx) }
  }

  if (input === 'g') {
    return { next: { type: 'operatorG', operator, count: rawCount } }
  }

  return { next: IDLE }
}

export function transition(
  state: CommandState,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  switch (state.type) {
    case 'idle':
      return transitionNormal(0, false, input, ctx)
    case 'count':
      return transitionNormal(state.count, true, input, ctx)
    case 'operator':
      return transitionOperator(state.operator, state.count, null, input, ctx)
    case 'operatorCount':
      return transitionOperator(state.operator, state.count, state.motionCount, input, ctx)
    case 'g':
      if (input === 'j') {
        const n = effectiveCount(state.count)
        return { next: IDLE, execute: () => ctx.setOffset(resolveMotion('gj', ctx.cursor, n).offset) }
      }
      if (input === 'k') {
        const n = effectiveCount(state.count)
        return { next: IDLE, execute: () => ctx.setOffset(resolveMotion('gk', ctx.cursor, n).offset) }
      }
      if (input === 'g') {
        const line = state.count > 0 ? state.count : 1
        return { next: IDLE, execute: () => ctx.setOffset(ctx.cursor.goToLine(line).offset) }
      }
      return { next: IDLE }
    case 'operatorG':
      if (input === 'j') {
        const n = effectiveCount(state.count)
        return { next: IDLE, execute: () => executeOperatorMotion(state.operator, 'gj', n, ctx) }
      }
      if (input === 'k') {
        const n = effectiveCount(state.count)
        return { next: IDLE, execute: () => executeOperatorMotion(state.operator, 'gk', n, ctx) }
      }
      if (input === 'g') {
        return { next: IDLE, execute: () => executeOperatorGg(state.operator, state.count, ctx) }
      }
      return { next: IDLE }
    case 'replace':
      if (input === '') return { next: IDLE }
      return { next: IDLE, execute: () => executeReplace(input, effectiveCount(state.count), ctx) }
    case 'find':
      if (input === '') return { next: IDLE }
      return {
        next: IDLE,
        execute: () => {
          ctx.setLastFind(state.findType, input)
          const pos = ctx.cursor.findCharacter(input, state.findType, effectiveCount(state.count))
          if (pos !== null) ctx.setOffset(pos)
        },
      }
    case 'indent':
      if (input === state.direction) {
        return { next: IDLE, execute: () => executeIndent(state.direction, effectiveCount(state.count), ctx) }
      }
      return { next: IDLE }
    case 'operatorFind':
      if (input === '') return { next: IDLE }
      return {
        next: IDLE,
        execute: () => executeOperatorFind(state.operator, state.findType, input, effectiveCount(state.count), ctx),
      }
    case 'operatorTextObj':
      if (isTextObjType(input)) {
        return {
          next: IDLE,
          execute: () => executeOperatorTextObj(state.operator, state.scope, input, effectiveCount(state.count), ctx),
        }
      }
      return { next: IDLE }
  }
}

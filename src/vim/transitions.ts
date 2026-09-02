// ============================================================================
//  The NORMAL-mode command state machine: one transition per waiting state.
//  A transition either moves to a new waiting state or produces an action
//  to execute; after an executing transition the HOST hook resets to idle.
//  Handling is exhaustive over the CommandState union.
// ============================================================================

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
  onUndo?: () => void
  onDotRepeat?: () => void
}

export type TransitionResult = {
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

/** Repeat the stored find; `,` flips the direction. Only the caret moves —
 *  the stored last find is never rewritten, so later repeats keep the
 *  original direction. */
function repeatLastFind(reversed: boolean, ctx: TransitionContext): void {
  const last = ctx.getLastFind()
  if (!last) return
  const flip: Record<FindType, FindType> = { f: 'F', F: 'f', t: 'T', T: 't' }
  const type = reversed ? flip[last.type] : last.type
  const target = ctx.cursor.findCharacter(last.char, type, 1)
  if (target !== null) ctx.setOffset(target)
}

/**
 * The shared normal-input handling, reachable from idle (count 0 = none)
 * and from the count state (parsed count). Returns null for unrecognised
 * input.
 */
function sharedNormalInput(
  input: string,
  typedCount: number,
  ctx: TransitionContext,
): TransitionResult | null {
  const effective = typedCount || 1
  if (isOperatorKey(input)) {
    return { next: { type: 'operator', operator: OPERATORS[input], count: typedCount } }
  }
  if (isSimpleMotion(input)) {
    return {
      execute: () => ctx.setOffset(resolveMotion(input, ctx.cursor, effective).offset),
    }
  }
  if (isFindKey(input)) {
    return { next: { type: 'find', findType: input, count: typedCount } }
  }
  switch (input) {
    case 'g':
      return { next: { type: 'g', count: typedCount } }
    case 'r':
      return { next: { type: 'replace', count: typedCount } }
    case '>':
    case '<':
      return { next: { type: 'indent', direction: input, count: typedCount } }
    case '~':
      return { execute: () => executeToggleCase(effective, ctx) }
    case 'x':
      return { execute: () => executeX(effective, ctx) }
    case 'J':
      return { execute: () => executeJoin(effective, ctx) }
    case 'p':
      return { execute: () => executePaste(true, effective, ctx) }
    case 'P':
      return { execute: () => executePaste(false, effective, ctx) }
    case 'D':
      // Always count 1.
      return { execute: () => executeOperatorMotion('delete', '$', 1, ctx) }
    case 'C':
      return { execute: () => executeOperatorMotion('change', '$', 1, ctx) }
    case 'Y':
      return { execute: () => executeLineOp('yank', effective, ctx) }
    case 'G':
      return {
        execute: () => {
          const target =
            typedCount > 0 ? ctx.cursor.goToLine(typedCount) : ctx.cursor.startOfLastLine()
          ctx.setOffset(target.offset)
        },
      }
    case '.':
      return { execute: () => ctx.onDotRepeat?.() }
    case 'u':
      return { execute: () => ctx.onUndo?.() }
    case ';':
      return { execute: () => repeatLastFind(false, ctx) }
    case ',':
      return { execute: () => repeatLastFind(true, ctx) }
    case 'i':
      return { execute: () => ctx.enterInsert(ctx.cursor.offset) }
    case 'I':
      return {
        execute: () => ctx.enterInsert(ctx.cursor.firstNonBlankInLogicalLine().offset),
      }
    case 'a':
      return {
        execute: () =>
          ctx.enterInsert(
            ctx.cursor.isAtEnd()
              ? ctx.cursor.offset
              : ctx.cursor.measuredText.nextOffset(ctx.cursor.offset),
          ),
      }
    case 'A':
      return { execute: () => ctx.enterInsert(ctx.cursor.endOfLogicalLine().offset) }
    case 'o':
      return { execute: () => executeOpenLine('below', ctx) }
    case 'O':
      return { execute: () => executeOpenLine('above', ctx) }
    default:
      return null
  }
}

/** The operator-state input handling shared by `operator` (motion count 1)
 *  and `operatorCount` (a concrete effective count, possibly 0 — an
 *  effective count of zero resolves the motion zero times and therefore
 *  does nothing). */
function operatorInput(
  operator: Operator,
  motionCount: number,
  gCount: number,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (isOperatorKey(input) && OPERATORS[input] === operator) {
    return { execute: () => executeLineOp(operator, motionCount, ctx) }
  }
  if (isTextObjScopeKey(input)) {
    return {
      next: {
        type: 'operatorTextObj',
        operator,
        count: motionCount,
        scope: TEXT_OBJ_SCOPES[input],
      },
    }
  }
  if (isFindKey(input)) {
    return { next: { type: 'operatorFind', operator, count: motionCount, findType: input } }
  }
  if (isSimpleMotion(input)) {
    return { execute: () => executeOperatorMotion(operator, input, motionCount, ctx) }
  }
  if (input === 'G') {
    return { execute: () => executeOperatorG(operator, gCount, ctx) }
  }
  if (input === 'g') {
    return { next: { type: 'operatorG', operator, count: gCount } }
  }
  return { next: IDLE }
}

export function transition(
  state: CommandState,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  switch (state.type) {
    case 'idle': {
      if (/^[1-9]$/.test(input)) {
        return { next: { type: 'count', count: Number(input) } }
      }
      // `0` is the start-of-logical-line motion, never a count prefix.
      const handled = sharedNormalInput(input, 0, ctx)
      // Unrecognised input does nothing and leaves the state unchanged.
      return handled ?? {}
    }

    case 'count': {
      if (isDigit(input)) {
        return { next: { type: 'count', count: clampCount(state.count * 10 + Number(input)) } }
      }
      const handled = sharedNormalInput(input, state.count, ctx)
      return handled ?? { next: IDLE }
    }

    case 'operator': {
      if (isDigit(input)) {
        // EVERY digit enters operatorCount here, `0` included — unlike
        // idle. So `d0` parks in operatorCount with a zero motion count.
        return {
          next: {
            type: 'operatorCount',
            operator: state.operator,
            count: state.count,
            motionCount: Number(input),
          },
        }
      }
      return operatorInput(state.operator, state.count || 1, state.count, input, ctx)
    }

    case 'operatorCount': {
      if (isDigit(input)) {
        return {
          next: {
            ...state,
            motionCount: clampCount(state.motionCount * 10 + Number(input)),
          },
        }
      }
      // The effective count is the operator count MULTIPLIED by the motion
      // count (zero stays zero: the motion resolves zero times).
      const effective = (state.count || 1) * state.motionCount
      return operatorInput(state.operator, effective, effective, input, ctx)
    }

    case 'operatorFind':
      // The very next input is the literal target — including characters
      // that are commands elsewhere, and including empty input (which finds
      // nothing and changes nothing).
      return {
        execute: () =>
          executeOperatorFind(state.operator, state.findType, input, state.count || 1, ctx),
      }

    case 'operatorTextObj': {
      if (isTextObjType(input)) {
        return {
          execute: () =>
            executeOperatorTextObj(state.operator, state.scope, input, state.count || 1, ctx),
        }
      }
      return { next: IDLE }
    }

    case 'find':
      return {
        execute: () => {
          const target = ctx.cursor.findCharacter(input, state.findType, state.count || 1)
          if (target !== null) {
            ctx.setOffset(target)
            ctx.setLastFind(state.findType, input)
          }
        },
      }

    case 'g': {
      if (input === 'j' || input === 'k') {
        const motion = input === 'j' ? 'gj' : 'gk'
        return {
          execute: () => ctx.setOffset(resolveMotion(motion, ctx.cursor, state.count || 1).offset),
        }
      }
      if (input === 'g') {
        return {
          execute: () => {
            const target =
              state.count > 1 ? ctx.cursor.goToLine(state.count) : ctx.cursor.startOfFirstLine()
            ctx.setOffset(target.offset)
          },
        }
      }
      return { next: IDLE }
    }

    case 'operatorG': {
      if (input === 'j' || input === 'k') {
        const motion = input === 'j' ? 'gj' : 'gk'
        return {
          execute: () => executeOperatorMotion(state.operator, motion, state.count || 1, ctx),
        }
      }
      if (input === 'g') {
        return { execute: () => executeOperatorGg(state.operator, state.count, ctx) }
      }
      return { next: IDLE }
    }

    case 'replace': {
      // EMPTY input cancels: the host delivers backspace/delete to the
      // literal-character states as an empty string, and vim abandons `r`
      // on a backspace rather than replacing with nothing.
      if (input === '') return { next: IDLE }
      return { execute: () => executeReplace(input, state.count || 1, ctx) }
    }

    case 'indent': {
      if (input === state.direction) {
        return { execute: () => executeIndent(state.direction, state.count || 1, ctx) }
      }
      return { next: IDLE }
    }
  }
}

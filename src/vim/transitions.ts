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
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type TransitionContext = Unbuilt

type TransitionResult = Unbuilt

const IDLE: CommandState = { type: 'idle' }

const isDigit = (input: string): boolean => /^[0-9]$/.test(input)
const isSimpleMotion = (input: string): boolean =>
  (SIMPLE_MOTIONS as readonly string[]).includes(input)
const isFindKey = (input: string): input is FindType =>
  (FIND_KEYS as readonly string[]).includes(input)
const isTextObjType = (input: string): boolean =>
  (TEXT_OBJ_TYPES as readonly string[]).includes(input)
const clampCount = (count: number): number => Math.min(count, MAX_VIM_COUNT)

export function transition(
  state: CommandState,
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  return notBuilt('src/vim/transitions.ts:181')
}

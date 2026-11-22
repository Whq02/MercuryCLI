import type { Unbuilt } from '../pi/holes.js'

export const OPERATORS = { d: 'delete', c: 'change', y: 'yank' } as const
export const TEXT_OBJ_SCOPES = { i: 'inner', a: 'around' } as const
export const FIND_KEYS = ['f', 'F', 't', 'T'] as const
export const SIMPLE_MOTIONS = ['h', 'l', 'j', 'k', 'w', 'b', 'e', 'W', 'B', 'E', '0', '^', '$'] as const
export const TEXT_OBJ_TYPES = ['w', 'W', '"', "'", '`', '(', ')', 'b', '[', ']', '{', '}', 'B', '<', '>'] as const
export const MAX_VIM_COUNT = 10_000

export type Operator = (typeof OPERATORS)[keyof typeof OPERATORS]
export type TextObjScope = (typeof TEXT_OBJ_SCOPES)[keyof typeof TEXT_OBJ_SCOPES]
export type FindType = (typeof FIND_KEYS)[number]
type IndentDirection = '>' | '<'

const ownKeyOf =
  <Table extends object>(table: Table) =>
  (key: string): key is keyof Table & string =>
    Object.hasOwn(table, key)

export const isOperatorKey = ownKeyOf(OPERATORS)
export const isTextObjScopeKey = ownKeyOf(TEXT_OBJ_SCOPES)

type Counted<Type extends string, Fields = unknown> = { type: Type; count: number } & Fields
type Pending<Type extends string, Fields = unknown> = Counted<Type, { operator: Operator } & Fields>

export type CommandState = Unbuilt

type Replayed<Type extends string, Fields = unknown> = Counted<Type, { op: Operator } & Fields>

export type RecordedChange = Unbuilt

export type PersistentState = Unbuilt

const emptyRegisterState = (): PersistentState => ({ lastChange: null, lastFind: null, register: '', registerIsLinewise: false })

let sessionRegisters: PersistentState | undefined

export function getSessionVimPersistentState(): PersistentState {
  return (sessionRegisters ??= emptyRegisterState())
}

export function _resetSessionVimPersistentStateForTesting(): void {
  sessionRegisters = undefined
}

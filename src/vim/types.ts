
export type Operator = 'delete' | 'change' | 'yank'
export type FindType = 'f' | 'F' | 't' | 'T'
export type TextObjScope = 'inner' | 'around'

export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; count: number }
  | { type: 'operator'; operator: Operator; count: number }
  | { type: 'operatorCount'; operator: Operator; count: number; motionCount: number }
  | { type: 'operatorFind'; operator: Operator; count: number; findType: FindType }
  | { type: 'operatorTextObj'; operator: Operator; count: number; scope: TextObjScope }
  | { type: 'find'; findType: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; operator: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; direction: '>' | '<'; count: number }

export type RecordedChange =
  | { type: 'insert'; text: string }
  | { type: 'operator'; op: Operator; motion: string; count: number }
  | { type: 'operatorTextObj'; op: Operator; objType: string; scope: TextObjScope; count: number }
  | { type: 'operatorFind'; op: Operator; find: FindType; char: string; count: number }
  | { type: 'replace'; char: string; count: number }
  | { type: 'x'; count: number }
  | { type: 'toggleCase'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
  | { type: 'openLine'; direction: 'above' | 'below' }
  | { type: 'join'; count: number }

export type PersistentState = {
  lastChange: RecordedChange | null
  lastFind: { type: FindType; char: string } | null
  register: string
  registerIsLinewise: boolean
}

export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; commandState: CommandState }


export const OPERATORS = {
  d: 'delete',
  c: 'change',
  y: 'yank',
} as const

export const SIMPLE_MOTIONS = [
  'h', 'l', 'j', 'k', 'w', 'b', 'e', 'W', 'B', 'E', '0', '^', '$',
] as const

export const FIND_KEYS = ['f', 'F', 't', 'T'] as const

export const TEXT_OBJ_SCOPES = {
  i: 'inner',
  a: 'around',
} as const

export const TEXT_OBJ_TYPES = [
  'w', 'W', '"', "'", '`', '(', ')', 'b', '[', ']', '{', '}', 'B', '<', '>',
] as const

export const MAX_VIM_COUNT = 10_000

export function isOperatorKey(key: string): key is keyof typeof OPERATORS {
  return Object.prototype.hasOwnProperty.call(OPERATORS, key)
}

export function isTextObjScopeKey(key: string): key is keyof typeof TEXT_OBJ_SCOPES {
  return Object.prototype.hasOwnProperty.call(TEXT_OBJ_SCOPES, key)
}

export function createInitialVimState(): VimState {
  return { mode: 'INSERT', insertedText: '' }
}

let sessionPersistentState: PersistentState | null = null

export function getSessionVimPersistentState(): PersistentState {
  if (sessionPersistentState === null) sessionPersistentState = createInitialPersistentState()
  return sessionPersistentState
}

export function _resetSessionVimPersistentStateForTesting(): void {
  sessionPersistentState = null
}

export function createInitialPersistentState(): PersistentState {
  return {
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  }
}

// ============================================================================
//  The vim state vocabulary: modes, the NORMAL-mode command-parser states,
//  persistent cross-command state, the dot-repeat record union, and the key
//  groups (vim's own vocabulary — contract data). Every command state names
//  exactly the input it is waiting for; handling must be exhaustive.
// ============================================================================

export type Operator = 'delete' | 'change' | 'yank'
export type FindType = 'f' | 'F' | 't' | 'T'
export type TextObjScope = 'inner' | 'around'

/** The NORMAL-mode command-parser states. A `count` of 0 means "no count
 *  typed" (G distinguishes bare from counted). */
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

/** The dot-repeat vocabulary: everything `.` can replay. */
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

/** State that survives across commands. */
export type PersistentState = {
  lastChange: RecordedChange | null
  lastFind: { type: FindType; char: string } | null
  register: string
  registerIsLinewise: boolean
}

/** The editor mode: INSERT tracks the text typed so far (for dot-repeat);
 *  NORMAL holds the command-parser state. */
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; commandState: CommandState }

// ── key groups (contract data — vim's own vocabulary) ───────────────────────

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

/**
 * THE session's vim persistent state — the yank register, the last find,
 * the last change for dot-repeat. Process-scoped on purpose (sweep
 * #2, packet 25): the composer's vim hook unmounts whenever a dialog hides
 * the prompt (a permission card, a picker), and a per-mount ref emptied the
 * register every time; the register is global in vim itself, so one owner
 * per process is the honest shape (law 6).
 */
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

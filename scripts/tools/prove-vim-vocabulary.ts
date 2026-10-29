#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

const vim = await import('../../src/vim/types.ts')
const { transition } = await import('../../src/vim/transitions.ts')

console.log("vim's key tables, entry for entry")
check('OPERATORS d/c/y', j(vim.OPERATORS) === j({ d: 'delete', c: 'change', y: 'yank' }), j(vim.OPERATORS))
check('TEXT_OBJ_SCOPES i/a', j(vim.TEXT_OBJ_SCOPES) === j({ i: 'inner', a: 'around' }), j(vim.TEXT_OBJ_SCOPES))
check('FIND_KEYS f F t T', j(vim.FIND_KEYS) === j(['f', 'F', 't', 'T']), j(vim.FIND_KEYS))
check('SIMPLE_MOTIONS h l j k w b e W B E 0 ^ $', j(vim.SIMPLE_MOTIONS) === j(['h', 'l', 'j', 'k', 'w', 'b', 'e', 'W', 'B', 'E', '0', '^', '$']), j(vim.SIMPLE_MOTIONS))
check('TEXT_OBJ_TYPES w W " \' ` ( ) b [ ] { } B < >', j(vim.TEXT_OBJ_TYPES) === j(['w', 'W', '"', "'", '`', '(', ')', 'b', '[', ']', '{', '}', 'B', '<', '>']), j(vim.TEXT_OBJ_TYPES))
check('MAX_VIM_COUNT is ten thousand', vim.MAX_VIM_COUNT === 10_000)

console.log('the key guards answer own keys only')
check('isOperatorKey: d c y yes; x, toString, constructor no', vim.isOperatorKey('d') && vim.isOperatorKey('c') && vim.isOperatorKey('y') && !vim.isOperatorKey('x') && !vim.isOperatorKey('toString') && !vim.isOperatorKey('constructor'))
check('isTextObjScopeKey: i a yes; w, hasOwnProperty no', vim.isTextObjScopeKey('i') && vim.isTextObjScopeKey('a') && !vim.isTextObjScopeKey('w') && !vim.isTextObjScopeKey('hasOwnProperty'))

console.log('the session registers: one record per process, reset for tests')
{
  vim._resetSessionVimPersistentStateForTesting()
  const first = vim.getSessionVimPersistentState()
  check('a fresh record is empty', j(first) === j({ lastChange: null, lastFind: null, register: '', registerIsLinewise: false }), j(first))
  first.register = 'yanked'
  check('the next read is the same object', vim.getSessionVimPersistentState() === first && vim.getSessionVimPersistentState().register === 'yanked')
  vim._resetSessionVimPersistentStateForTesting()
  const second = vim.getSessionVimPersistentState()
  check('a reset makes a fresh empty record', second !== first && second.register === '')
}

console.log('the parser states through the NORMAL-mode transition')
{
  const noop = () => undefined
  const ctx = {
    cursor: {} as never,
    text: 'abc def',
    setText: noop,
    setOffset: noop,
    enterInsert: noop,
    getRegister: () => '',
    setRegister: noop,
    getLastFind: () => null,
    setLastFind: noop,
    recordChange: noop,
  } as never
  const idle = { type: 'idle' } as const
  const counted = transition(idle, '3', ctx).next
  check("a digit from idle is the count state", j(counted) === j({ type: 'count', count: 3 }), j(counted))
  const pending = transition(idle, 'd', ctx).next
  check("an operator key from idle is the operator state with count 0", j(pending) === j({ type: 'operator', operator: 'delete', count: 0 }), j(pending))
  const scoped = transition(pending!, 'i', ctx).next
  check("a scope key after an operator is the operatorTextObj state (a bare operator counts as one)", j(scoped) === j({ type: 'operatorTextObj', operator: 'delete', count: 1, scope: 'inner' }), j(scoped))
  const finding = transition(pending!, 'f', ctx).next
  check("a find key after an operator is the operatorFind state (a bare operator counts as one)", j(finding) === j({ type: 'operatorFind', operator: 'delete', count: 1, findType: 'f' }), j(finding))
  const g = transition(idle, 'g', ctx).next
  check("g from idle is the g state", j(g) === j({ type: 'g', count: 0 }), j(g))
  const replace = transition(idle, 'r', ctx).next
  check("r from idle is the replace state", j(replace) === j({ type: 'replace', count: 0 }), j(replace))
  const indent = transition(idle, '>', ctx).next
  check("> from idle is the indent state", j(indent) === j({ type: 'indent', direction: '>', count: 0 }), j(indent))
}

console.log(failures === 0 ? '\nprove-vim-vocabulary: ALL PASS' : `\nprove-vim-vocabulary: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

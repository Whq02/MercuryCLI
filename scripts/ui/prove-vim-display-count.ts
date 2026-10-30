import assert from 'node:assert/strict'
import { Cursor } from '../../src/utils/Cursor.ts'
import { transition } from '../../src/vim/transitions.ts'
import type { OperatorContext } from '../../src/vim/operators.ts'
import type { CommandState } from '../../src/vim/types.ts'

function run(text: string, offset: number, keys: string, columns = 80) {
  const state = { text, offset, register: 'kept', changes: 0, insert: false }
  const ctx: OperatorContext = {
    get cursor() { return Cursor.fromText(state.text, columns, state.offset) },
    get text() { return state.text }, setText: v => { state.text = v }, setOffset: v => { state.offset = v },
    enterInsert: v => { state.insert = true; state.offset = v },
    getRegister: () => state.register, setRegister: v => { state.register = v },
    getLastFind: () => null, setLastFind() {}, recordChange: () => { state.changes++ },
  }
  let parser: CommandState = { type: 'idle' }
  for (const key of keys) {
    const result = transition(parser, key, ctx)
    result.execute?.()
    parser = result.next ?? { type: 'idle' }
  }
  return state
}
for (const op of ['d', 'c', 'y']) {
  for (const [text, offset, keys, columns] of [
    ['one\ntwo', 0, '9gj', 80], ['one\ntwo\nthree', 0, '9gj', 80],
    ['one\ntwo', 4, '9gk', 80], ['abcdefghi', 0, '9gj', 3],
  ] as const) {
    const state = run(text, offset, op + keys, columns)
    assert.equal(state.text, text, op + keys)
    assert.equal(state.register, 'kept', 'failed motion does not overwrite register')
    assert.equal(state.changes, 0, 'failed motion is not repeated by dot')
    assert.equal(state.insert, false, 'failed change does not enter insert')
  }
}
assert.equal(run('one\ntwo', 0, 'd1gj').text, 'two')
assert.equal(run('one\ntwo\nthree', 0, 'd2gj').text, 'three')
assert.equal(run('one\ntwo', 0, 'd9j').text, '')
assert.equal(run('one\ntwo', 0, '9gj').offset, 4)
console.log('PASS tui-05 display-line operators require the full count; plain motions and logical-line clamps are unchanged')

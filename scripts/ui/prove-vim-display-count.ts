import assert from 'node:assert/strict'
import { Cursor } from '../../src/screen/composer/vim/textCursor.ts'
import { transition } from '../../src/screen/composer/vim/transitions.ts'
import type { OperatorContext } from '../../src/screen/composer/vim/operators.ts'
import type { CommandState } from '../../src/screen/composer/vim/vimState.ts'

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
    assert.equal(state.text, text, op + keys + ' changed the text; change the gj and gk guard in src/screen/composer/vim/operators.ts so an operator on a display-line motion that cannot move the full count does nothing')
    assert.equal(state.register, 'kept', 'failed motion does not overwrite register; change the gj and gk guard in src/screen/composer/vim/operators.ts so it returns before the register is set')
    assert.equal(state.changes, 0, 'failed motion is not repeated by dot; change the gj and gk guard in src/screen/composer/vim/operators.ts so it returns before recordChange runs')
    assert.equal(state.insert, false, 'failed change does not enter insert; change the gj and gk guard in src/screen/composer/vim/operators.ts so c returns before enterInsert runs')
  }
}
assert.equal(run('one\ntwo', 0, 'd1gj').text, 'two', 'd1gj must delete one display line; check the gj motion in src/screen/composer/vim/motions.ts and the count check in src/screen/composer/vim/operators.ts')
assert.equal(run('one\ntwo\nthree', 0, 'd2gj').text, 'three', 'd2gj must delete two display lines; check the gj motion in src/screen/composer/vim/motions.ts and the count check in src/screen/composer/vim/operators.ts')
assert.equal(run('one\ntwo', 0, 'd9j').text, '', 'd9j on logical lines must clamp to the last line and delete all; do not apply the display-line count guard in src/screen/composer/vim/operators.ts to j')
assert.equal(run('one\ntwo', 0, '9gj').offset, 4, 'a plain 9gj must clamp to the last display line; check the gj motion in src/screen/composer/vim/motions.ts and the plain-motion path in src/screen/composer/vim/transitions.ts')
console.log('PASS tui-05 display-line operators require the full count; plain motions and logical-line clamps are unchanged')

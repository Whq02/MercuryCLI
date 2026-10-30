import assert from 'node:assert/strict'
import { Cursor } from '../../src/utils/Cursor.ts'
import { executeIndent, executeToggleCase, executeX, type OperatorContext } from '../../src/vim/operators.ts'

function context(text: string, offset: number) {
  const state = { text, offset }
  const ctx: OperatorContext = {
    get cursor() { return Cursor.fromText(state.text, 80, state.offset) },
    get text() { return state.text },
    setText: v => { state.text = v }, setOffset: v => { state.offset = v }, enterInsert() {},
    getRegister: () => '', setRegister() {}, getLastFind: () => null, setLastFind() {}, recordChange() {},
  }
  return { state, ctx }
}
const row = process.argv[2]
if (row !== 'tui-03') {
  for (const [text, offset, dir, expected, cursor] of [
    ['  ', 0, '>', '    ', 3], ['a\n  \nb', 2, '>', 'a\n    \nb', 5],
    ['', 0, '>', '  ', 1], ['  ', 0, '<', '', 0],
    ['\t', 0, '>', '  \t', 2], ['word', 0, '>', '  word', 2],
  ] as const) {
    const { ctx, state } = context(text, offset)
    executeIndent(dir, 1, ctx)
    assert.deepEqual(state, { text: expected, offset: cursor }, `indent ${JSON.stringify(text)}`)
    if (expected) {
      executeX(1, ctx)
      assert.notEqual(state.text, expected, 'x after indent acts on a character')
    }
  }
}
if (row !== 'tui-04') {
  for (const [text, offset, count, expected, cursor] of [
    ['abc', 2, 1, 'abC', 2], ['abc', 0, 3, 'ABC', 2],
    ['abc\ndef', 2, 9, 'abC\ndef', 2], ['ab', 0, 1, 'Ab', 1],
    ['aß', 1, 1, 'aSS', 2], ['a😀', 1, 1, 'a😀', 1],
    ['', 0, 1, '', 0], ['\nabc', 0, 1, '\nabc', 0],
  ] as const) {
    const { ctx, state } = context(text, offset)
    executeToggleCase(count, ctx)
    assert.deepEqual(state, { text: expected, offset: cursor }, `toggle ${JSON.stringify(text)}`)
  }
}
console.log(`PASS ${row ?? 'tui-03 tui-04'} normal-mode case and indent cursors stay on the current line`)

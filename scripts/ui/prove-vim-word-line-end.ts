import assert from 'node:assert/strict'
import { Cursor } from '../../src/screen/composer/vim/textCursor.ts'
import { executeOperatorMotion, type OperatorContext } from '../../src/screen/composer/vim/operators.ts'

for (const motion of ['w', 'W']) {
  for (const op of ['delete', 'yank'] as const) {
    for (const [text, offset, count, end] of [
      ['foo bar\nbaz', 4, 1, 7],
      ['foo bar\n  baz', 4, 1, 7],
      ['foo bar  \nbaz', 4, 1, 9],
      ['foo bar\nbaz', 0, 2, 7],
      ['foo bar\nbaz qux', 4, 2, 12],
      ['foo bar', 4, 1, 7],
      ['foo bar baz', 4, 1, 8],
      ['foo\n\nbar', 0, 1, 3],
    ] as const) {
      let value: string = text
      let register = ''
      const ctx: OperatorContext = {
        cursor: Cursor.fromText(text, 80, offset), text,
        setText: v => { value = v }, setOffset() {}, enterInsert() {},
        getRegister: () => register, setRegister: v => { register = v },
        getLastFind: () => null, setLastFind() {}, recordChange() {},
      }
      executeOperatorMotion(op, motion, count, ctx)
      assert.equal(register, text.slice(offset, end), `${op}${count}${motion} register in ${JSON.stringify(text)}; the w and W operator range must stop at the end of the final word without taking its line break, so fix executeOperatorMotion in src/screen/composer/vim/operators.ts`)
      assert.equal(value, op === 'delete' ? text.slice(0, offset) + text.slice(end) : text, `${op}${count}${motion} text in ${JSON.stringify(text)} at offset ${offset}; delete must remove exactly the range [offset, ${end}) and yank must leave the text unchanged, so fix executeOperatorMotion in src/screen/composer/vim/operators.ts`)
    }
  }
}
console.log('PASS tui-01 word operators preserve the final word line break, including counts and indentation')

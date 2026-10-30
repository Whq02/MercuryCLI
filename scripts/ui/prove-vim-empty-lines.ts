import assert from 'node:assert/strict'
import { Cursor } from '../../src/utils/Cursor.ts'
import { resolveMotion } from '../../src/vim/motions.ts'

for (const motion of ['w', 'W']) {
  for (const [text, offset, count, expected] of [
    ['foo\n\nbar', 0, 1, 4], ['foo\n\nbar', 4, 1, 5],
    ['foo\n\nbar', 0, 2, 5], ['foo\n\n\nbar', 0, 2, 5],
    ['foo\n\n\nbar', 0, 3, 6], ['\nbar', 0, 1, 1],
    ['foo\n  \nbar', 0, 1, 7], ['foo\nbar', 0, 1, 4],
  ] as const) {
    assert.equal(resolveMotion(motion, Cursor.fromText(text, 80, offset), count).offset, expected, `${motion} ${JSON.stringify(text)} @${offset} x${count}`)
  }
}
for (const motion of ['b', 'B']) {
  for (const [text, offset, count, expected] of [
    ['foo\n\nbar', 5, 1, 4], ['foo\n\nbar', 4, 1, 0],
    ['foo\n\nbar', 5, 2, 0], ['foo\n\n\nbar', 6, 2, 4],
    ['\nbar', 1, 1, 0], ['foo\n  \nbar', 7, 1, 0],
  ] as const) {
    assert.equal(resolveMotion(motion, Cursor.fromText(text, 80, offset), count).offset, expected, `${motion} ${JSON.stringify(text)} @${offset} x${count}`)
  }
}
console.log('PASS tui-02 word motions count empty lines as words without treating spaces-only lines as empty')

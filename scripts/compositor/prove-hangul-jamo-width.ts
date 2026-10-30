import assert from 'node:assert/strict'
import { stringWidth, __correctedWidthForTest } from '../../src/ink/stringWidth.ts'
import { truncateToWidth, wrapText } from '../../src/utils/truncate.ts'
import { composeScene, makeContext, screenLines } from '../ink-runtime/frameHarness.ts'

const syllable = '\u1112\u1161\u11ab'
const text = '한글한글'.normalize('NFD')
function frame(value: string): string[] {
  return screenLines(composeScene({ name: 'jamo', cols: 24, rows: 6, root: {
    kind: 'box', style: { flexDirection: 'column' }, children: [
      { kind: 'box', style: { width: 12, borderStyle: 'single' }, children: [{ kind: 'text', text: value + 'AB' }] },
    ],
  } }, makeContext()).screen).map(line => line.normalize('NFC'))
}
console.log(frame(text).join('\n'))
assert.equal(stringWidth(syllable), 2, 'U+1112 U+1161 U+11AB occupies two cells')
assert.equal(__correctedWidthForTest(syllable), 2, 'the JS fallback agrees with the native-route correction')
assert.equal(stringWidth(`\x1b[31m${syllable}\x1b[0m`), 2)
assert.equal(stringWidth(text), 8)
assert.equal(truncateToWidth(text, 8), text)
assert.equal(truncateToWidth(text, 6).normalize('NFC'), '한글…')
assert.equal(wrapText(text + 'AB', 10, 'wrap').normalize('NFC'), text.normalize('NFC') + 'AB')
assert.deepEqual(frame(text), frame(text.normalize('NFC')), 'decomposed and composed frames use identical cells')
console.log('PASS tui-13 conjoining Hangul jamo widths, truncation, wrapping and composed cells agree')

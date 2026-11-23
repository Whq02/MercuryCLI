import assert from 'node:assert/strict'
import { stringWidth, __correctedWidthForTest } from '../../src/screen/renderer/stringWidth.ts'
import { truncateToWidth, wrapText } from '../../src/platform/text/truncate.ts'
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
assert.equal(stringWidth(`\x1b[31m${syllable}\x1b[0m`), 2, 'a jamo syllable inside an ANSI colour run must still measure two cells; check the escape stripping and the jamo width in stringWidth() in src/screen/renderer/stringWidth.ts')
assert.equal(stringWidth(text), 8, 'four decomposed Hangul syllables must measure eight cells; check the conjoining jamo handling in stringWidth() in src/screen/renderer/stringWidth.ts')
assert.equal(truncateToWidth(text, 8), text, 'text that exactly fits eight cells must come back untouched; check truncateToWidth() in src/platform/text/truncate.ts')
assert.equal(truncateToWidth(text, 6).normalize('NFC'), '한글…', 'truncating four syllables to six cells must keep two syllables and an ellipsis; check truncateToWidth() in src/platform/text/truncate.ts')
assert.equal(wrapText(text + 'AB', 10, 'wrap').normalize('NFC'), text.normalize('NFC') + 'AB', 'ten cells of decomposed Hangul plus AB must not wrap early; check the width measure used by src/screen/renderer/wrap-text.ts')
assert.deepEqual(frame(text), frame(text.normalize('NFC')), 'decomposed and composed frames use identical cells')
console.log('PASS tui-13 conjoining Hangul jamo widths, truncation, wrapping and composed cells agree')

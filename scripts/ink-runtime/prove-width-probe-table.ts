import assert from 'node:assert/strict'
import { measuredWidthAgreement, widthMayDisagree } from '../../src/ink/width-probe-table.js'
import { stringWidth } from '../../src/ink/stringWidth.js'

function original(cluster: string): boolean {
  const point = cluster.codePointAt(0)
  return point !== undefined && (
    (point >= 0x1fa70 && point <= 0x1faff) ||
    (point >= 0x1fb00 && point <= 0x1fbff) ||
    (cluster.length >= 2 && cluster.includes('\ufe0f'))
  )
}

const samples = {
  vs16: '\u26a0\ufe0f',
  skin: '\u{1f44d}\u{1f3fd}',
  zwj: '\u{1f9d1}\u200d\u{1f4bb}',
  flag: '\u{1f1ec}\u{1f1e7}',
  combining: 'e\u0301',
  zeroWidth: '\u200b',
  sextant: '\u{1fb00}',
  ambiguous: '\u00b7',
}
let checks = 0
for (const [kind, text] of Object.entries(samples)) {
  const width = stringWidth(text)
  assert.equal(measuredWidthAgreement(text), undefined)
  assert.equal(measuredWidthAgreement(text, {}), undefined)
  assert.equal(widthMayDisagree(text), original(text))
  assert.equal(widthMayDisagree(text, {}), original(text))
  assert.equal(measuredWidthAgreement(text, { [kind]: width }), true, kind)
  assert.equal(widthMayDisagree(text, { [kind]: width }), false, kind)
  assert.equal(measuredWidthAgreement(text, { [kind]: width + 1 }), false, kind)
  assert.equal(widthMayDisagree(text, { [kind]: width + 1 }), true, kind)
  for (const invalid of [-1, 1.5, Infinity, NaN]) {
    assert.equal(measuredWidthAgreement(text, { [kind]: invalid }), undefined)
    assert.equal(widthMayDisagree(text, { [kind]: invalid }), original(text))
  }
  checks += 16
}
for (let point = 0; point <= 0x10ffff; point++) {
  if (point >= 0xd800 && point <= 0xdfff) continue
  const text = String.fromCodePoint(point)
  assert.equal(widthMayDisagree(text), original(text), `U+${point.toString(16)}`)
  checks++
}
const agreement = Object.fromEntries(Object.entries(samples).map(([kind, text]) => [kind, stringWidth(text)]))
for (const text of ['A', '\u2500', '\u2580', '\u2584', '\u{1fabc}', '1\ufe0f\u20e3', '1\ufe0f', '\u{1fbff}', '\u{1f9d1}\u{1f3fd}\u200d\u{1f4bb}', '\u2764\ufe0f\u200d\u{1f525}']) {
  assert.equal(measuredWidthAgreement(text, agreement), undefined, text)
  assert.equal(widthMayDisagree(text, agreement), original(text), text)
  checks += 2
}
assert.equal(measuredWidthAgreement(samples.skin, { vs16: 2 }), undefined)
assert.equal(measuredWidthAgreement(samples.zwj, { skin: 2 }), undefined)
assert.equal(measuredWidthAgreement(samples.flag, { zwj: 2 }), undefined)
checks += 3
console.log(`width probe table: PASS (${checks} checks; unmeasured fallback exact, each measured class bounded)`)

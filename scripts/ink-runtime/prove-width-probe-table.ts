import assert from 'node:assert/strict'
import { measuredWidthAgreement, widthMayDisagree } from '../../src/screen/renderer/width-probe-table.js'
import { stringWidth } from '../../src/screen/renderer/stringWidth.js'

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
  assert.equal(measuredWidthAgreement(text), undefined, `${kind}: with no measurements measuredWidthAgreement must return undefined; fix src/screen/renderer/width-probe-table.ts`)
  assert.equal(measuredWidthAgreement(text, {}), undefined, `${kind}: with an empty measurement table measuredWidthAgreement must return undefined; fix src/screen/renderer/width-probe-table.ts`)
  assert.equal(widthMayDisagree(text), original(text), `${kind}: with no measurements widthMayDisagree must keep the original rule (U+1FA70-1FAFF, U+1FB00-1FBFF, or a cluster with VS16); fix widthMayDisagree in src/screen/renderer/width-probe-table.ts`)
  assert.equal(widthMayDisagree(text, {}), original(text), `${kind}: with an empty measurement table widthMayDisagree must keep the original rule; fix widthMayDisagree in src/screen/renderer/width-probe-table.ts`)
  assert.equal(measuredWidthAgreement(text, { [kind]: width }), true, `${kind}: a measured width equal to stringWidth must agree; fix measuredWidthAgreement in src/screen/renderer/width-probe-table.ts`)
  assert.equal(widthMayDisagree(text, { [kind]: width }), false, `${kind}: a measured width equal to stringWidth must clear the doubt; fix widthMayDisagree in src/screen/renderer/width-probe-table.ts`)
  assert.equal(measuredWidthAgreement(text, { [kind]: width + 1 }), false, `${kind}: a measured width off by one must disagree; fix measuredWidthAgreement in src/screen/renderer/width-probe-table.ts`)
  assert.equal(widthMayDisagree(text, { [kind]: width + 1 }), true, `${kind}: a measured width off by one must keep the doubt; fix widthMayDisagree in src/screen/renderer/width-probe-table.ts`)
  for (const invalid of [-1, 1.5, Infinity, NaN]) {
    assert.equal(measuredWidthAgreement(text, { [kind]: invalid }), undefined, `${kind}: an invalid measured width ${String(invalid)} must be ignored; fix measuredWidthAgreement in src/screen/renderer/width-probe-table.ts`)
    assert.equal(widthMayDisagree(text, { [kind]: invalid }), original(text), `${kind}: an invalid measured width ${String(invalid)} must fall back to the original rule; fix widthMayDisagree in src/screen/renderer/width-probe-table.ts`)
  }
  checks += 16
}
for (let point = 0; point <= 0x10ffff; point++) {
  if (point >= 0xd800 && point <= 0xdfff) continue
  const text = String.fromCodePoint(point)
  assert.equal(widthMayDisagree(text), original(text), `U+${point.toString(16)}: widthMayDisagree without measurements must match the original rule; fix widthMayDisagree in src/screen/renderer/width-probe-table.ts`)
  checks++
}
const agreement = Object.fromEntries(Object.entries(samples).map(([kind, text]) => [kind, stringWidth(text)]))
for (const text of ['A', '\u2500', '\u2580', '\u2584', '\u{1fabc}', '1\ufe0f\u20e3', '1\ufe0f', '\u{1fbff}', '\u{1f9d1}\u{1f3fd}\u200d\u{1f4bb}', '\u2764\ufe0f\u200d\u{1f525}']) {
  assert.equal(measuredWidthAgreement(text, agreement), undefined, `${text}: a cluster outside the measured classes must stay unmeasured; fix measuredWidthAgreement in src/screen/renderer/width-probe-table.ts`)
  assert.equal(widthMayDisagree(text, agreement), original(text), `${text}: a cluster outside the measured classes must keep the original rule; fix widthMayDisagree in src/screen/renderer/width-probe-table.ts`)
  checks += 2
}
assert.equal(measuredWidthAgreement(samples.skin, { vs16: 2 }), undefined, 'a skin-tone cluster must not borrow the vs16 measurement; fix the class lookup in measuredWidthAgreement (src/screen/renderer/width-probe-table.ts)')
assert.equal(measuredWidthAgreement(samples.zwj, { skin: 2 }), undefined, 'a zwj cluster must not borrow the skin measurement; fix the class lookup in measuredWidthAgreement (src/screen/renderer/width-probe-table.ts)')
assert.equal(measuredWidthAgreement(samples.flag, { zwj: 2 }), undefined, 'a flag cluster must not borrow the zwj measurement; fix the class lookup in measuredWidthAgreement (src/screen/renderer/width-probe-table.ts)')
checks += 3
console.log(`width probe table: PASS (${checks} checks; unmeasured fallback exact, each measured class bounded)`)

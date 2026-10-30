import assert from 'node:assert/strict'
import { INITIAL_STATE, parseMultipleKeypresses } from '../../src/ink/input/input-decoder.ts'

for (const payload of ['first line\nsecond\tcol2\tcol3\nthird', 'first\r\n\tsecond\r\nthird', '\tfirst\nsecond\t']) {
  const [atoms] = parseMultipleKeypresses({ ...INITIAL_STATE }, payload)
  assert.equal(atoms.length, 1, JSON.stringify(atoms))
  assert.equal(atoms[0]?.kind, 'key')
  assert.equal(atoms[0]?.sequence, payload.replaceAll('\r\n', '\n'))
  assert.ok(atoms[0]?.kind === 'key' && !atoms[0].isPasted)
}
for (const payload of ['\t', 'ab\tcd']) {
  const [atoms] = parseMultipleKeypresses({ ...INITIAL_STATE }, payload)
  assert.ok(atoms.some(a => a.kind === 'key' && a.name === 'tab' && !a.isPasted), 'typed Tab remains a key')
}
const [mixed] = parseMultipleKeypresses({ ...INITIAL_STATE }, 'a\nb\tc\x03')
assert.ok(mixed.some(a => a.kind === 'key' && a.ctrl && a.name === 'c'), 'Ctrl+C remains a key')
assert.ok(mixed.some(a => a.kind === 'key' && !a.isPasted && a.sequence === 'a\nb\tc'))
console.log('PASS tui-11 multiline text bursts preserve tabs while typed Tab and Ctrl+C remain controls')

import assert from 'node:assert/strict'
import { decode, expectText } from './input-resync-world.ts'

for (const [name, button] of [['press', ' '], ['release', '#'], ['motion', 'C'], ['wheel', '`']] as const) {
  const body = `[M${button})4`
  expectText(`${name}: X10 body after a flushed Escape never types`, ['\x1b', null, body, 'ok'], 'ok')
  const orphan = decode([body])
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0]?.kind, 'key')
  assert.deepEqual(orphan, decode(['\x1b' + body]))
  console.log(`PASS ${name}: recovered report retains the complete report's key semantics`)
}
expectText('non-report typed bracket remains text', ['[menu'], '[menu')
expectText('report-shaped bracketed paste stays literal', ['\x1b[200~[M )4\x1b[201~'], '[M )4')
for (const [tail, typed] of [['12;3', ''], ['<12', ''], ['1;2M', ''], [';;', ''], ['M', ''], ['12;3;4;5', '12;3;4;5'], [';;;', ';;;'], ['mX', 'mX'], ['<<', '<<'], ['ok', 'ok']] as const) {
  assert.equal(decode(['[<0;1;1M' + tail])[0]?.kind, 'mouse')
  expectText(`SGR orphan then ${JSON.stringify(tail)}`, ['[<0;1;1M' + tail], typed)
}
console.log('X10 ORPHAN RESYNC HOLDS')

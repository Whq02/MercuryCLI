import assert from 'node:assert/strict'
import { decode, expectText } from './input-resync-world.ts'

for (const [name, button] of [['press', ' '], ['release', '#'], ['motion', 'C'], ['wheel', '`']] as const) {
  const body = `[M${button})4`
  expectText(`${name}: X10 body after a flushed Escape never types`, ['\x1b', null, body, 'ok'], 'ok')
  const orphan = decode([body])
  assert.equal(orphan.length, 1, `${name}: an X10 body without its Escape must decode to exactly one atom; fix the orphan X10 recovery in parseMultipleKeypresses (src/screen/renderer/input/input-decoder.ts)`)
  assert.equal(orphan[0]?.kind, 'key', `${name}: the recovered X10 report must be a key atom; fix the orphan X10 recovery in parseMultipleKeypresses (src/screen/renderer/input/input-decoder.ts)`)
  assert.deepEqual(orphan, decode(['\x1b' + body]), `${name}: the recovered report must equal the atom of the same report sent with its Escape; fix parseMultipleKeypresses (src/screen/renderer/input/input-decoder.ts)`)
  console.log(`PASS ${name}: recovered report retains the complete report's key semantics`)
}
expectText('non-report typed bracket remains text', ['[menu'], '[menu')
expectText('report-shaped bracketed paste stays literal', ['\x1b[200~[M )4\x1b[201~'], '[M )4')
for (const [tail, typed] of [['12;3', ''], ['<12', ''], ['1;2M', ''], [';;', ''], ['M', ''], ['12;3;4;5', '12;3;4;5'], [';;;', ';;;'], ['mX', 'mX'], ['<<', '<<'], ['ok', 'ok']] as const) {
  assert.equal(decode(['[<0;1;1M' + tail])[0]?.kind, 'mouse', `an SGR report without its Escape and followed by ${JSON.stringify(tail)} must still decode first as a mouse atom; fix the orphan SGR recovery in parseMultipleKeypresses (src/screen/renderer/input/input-decoder.ts)`)
  expectText(`SGR orphan then ${JSON.stringify(tail)}`, ['[<0;1;1M' + tail], typed)
}
expectText('a bare SGR triple inside typed text is dropped, the text around it types', ['abc 12;3;4M def'], 'abc  def')
expectText('a bare SGR triple whose digits start mid-run is dropped whole', ['12345;3;4Mx'], 'x')
console.log('X10 ORPHAN RESYNC HOLDS')

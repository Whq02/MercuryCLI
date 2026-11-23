import assert from 'node:assert/strict'
import { decode, expectText } from './input-resync-world.ts'

for (const [name, tail] of [['ctrl-left', '1;5D'], ['focus-in', 'I'], ['focus-out', 'O'], ['up', 'A']] as const) {
  expectText(`${name}: bare CSI head at flush consumes its complete tail`, ['\x1b[', null, tail, 'ok'], 'ok')
  expectText(`${name}: tail survives further read and flush boundaries`, ['\x1b[', null, ...[...tail].flatMap(ch => [ch, null]), 'ok'], 'ok')
}
for (const control of ['\x03', '\r', '\x7f', '\x1b[A']) {
  assert.deepEqual(decode(['\x1b[', null, control]), decode([control]), `a bare CSI head followed by control ${JSON.stringify(control)} must resync and decode the control as if typed alone; fix the CSI head flush and resync path in parseMultipleKeypresses in src/screen/renderer/input/input-decoder.ts`)
  console.log(`PASS control ${JSON.stringify(control)} leaves resync without being swallowed`)
}
expectText('ordinary typed bracket text is unchanged', ['[1;5Dok'], '[1;5Dok')
const pasted = decode(['\x1b[200~', '\x1b[1;5D', '\x1b[201~'])
assert.equal(pasted.length, 1, `a bracketed paste holding a CSI sequence must decode to one paste atom, got ${pasted.length}; fix the paste handling in parseMultipleKeypresses in src/screen/renderer/input/input-decoder.ts`)
assert.equal(pasted[0]?.kind === 'key' && pasted[0].isPasted, true, 'the paste atom must be a key with isPasted set; fix the paste handling in parseMultipleKeypresses in src/screen/renderer/input/input-decoder.ts')
assert.equal(pasted[0]?.sequence, '\x1b[1;5D', 'the paste atom must keep the pasted CSI text literally in its sequence; fix the paste handling in parseMultipleKeypresses in src/screen/renderer/input/input-decoder.ts')
console.log('PASS bracketed paste retains the sequence as one literal paste atom')
console.log('CSI HEAD RESYNC HOLDS')

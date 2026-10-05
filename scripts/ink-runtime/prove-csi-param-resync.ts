import assert from 'node:assert/strict'
import { decode, expectText } from './input-resync-world.ts'

for (const [head, tail] of [['\x1b[1;', '5D'], ['\x1b[1;5', 'D'], ['\x1b[114;1:', '2u'], ['\x1b[27;5;', '97~']] as const) {
  expectText(`${JSON.stringify(head)}: dropped parameters own the final`, [head, null, tail + 'ok'], 'ok')
  expectText(`${JSON.stringify(head)}: repeated flushes retain the debt`, [head, null, null, ...[...tail].flatMap(ch => [ch, null]), 'ok'], 'ok')
}
for (const control of ['\x03', '\r', '\x7f', '\x1b[D']) {
  assert.deepEqual(decode(['\x1b[1;', null, control]), decode([control]))
  console.log(`PASS control ${JSON.stringify(control)} is not a parameter tail`)
}
console.log('CSI PARAMETER RESYNC HOLDS')

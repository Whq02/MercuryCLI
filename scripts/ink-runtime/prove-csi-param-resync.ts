import assert from 'node:assert/strict'
import { InputEvent } from '../../src/screen/renderer/events/input-event.ts'
import { decode, expectText } from './input-resync-world.ts'

const typedBy = (bytes: string): string =>
  decode([bytes, null]).flatMap(atom => atom.kind === 'key' ? [new InputEvent(atom).input] : []).join('')

for (const [head, tail] of [['\x1b[1;', '5D'], ['\x1b[1;5', 'D'], ['\x1b[114;1:', '2u'], ['\x1b[27;5;', '97~']] as const) {
  const whole = typedBy(head + tail)
  expectText(`${JSON.stringify(head)}: the held parameters complete into their key and the typing after it lands`, [head, null, tail + 'ok'], whole + 'ok')
  expectText(`${JSON.stringify(head)}: repeated flushes keep the hold until the tail completes it`, [head, null, null, ...[...tail].flatMap(ch => [ch, null]), 'ok'], whole + 'ok')
  assert.deepEqual(decode([head, null, tail]), decode([head + tail]), `${JSON.stringify(head)}: a flush between the parameters and the tail must decode to the same atoms as the whole sequence; fix the held-parameter state in parseMultipleKeypresses (src/screen/renderer/input/input-decoder.ts)`)
  console.log(`PASS ${JSON.stringify(head)}: the key split at the flush is the same key as the whole`)
}
for (const control of ['\x03', '\r', '\x7f', '\x1b[D']) {
  assert.deepEqual(decode(['\x1b[1;', null, control]), decode([control]), `control ${JSON.stringify(control)} after a held CSI parameter prefix must decode as it does alone; fix how parseMultipleKeypresses (src/screen/renderer/input/input-decoder.ts) releases a held prefix on a control byte`)
  console.log(`PASS control ${JSON.stringify(control)} is not a parameter tail`)
}
console.log('CSI PARAMETER HOLD HOLDS')

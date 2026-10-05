import assert from 'node:assert/strict'
import { decode, expectText } from './input-resync-world.ts'

for (const [head, tail] of [['\x1b[M', 'C)4'], ['\x1b[MC', ')4'], ['\x1b[MC)', '4'], ['\x1b[', 'MC)4']] as const) {
  expectText(`${JSON.stringify(head)}: dropped X10 head owns exactly its payload`, [head, null, tail + 'ok'], 'ok')
  expectText(`${JSON.stringify(head)}: payload debt crosses further flushes`, [head, null, ...[...tail].flatMap(ch => [ch, null]), 'ok'], 'ok')
  for (const control of ['\x03', '\r', '\x7f', '\x1b[A']) {
    assert.deepEqual(decode([head, null, control]), decode([control]))
  }
}
expectText('the three lost payload characters are the complete debt', ['\x1b[M', null, 'abcde'], 'de')
expectText('the final payload character is the complete debt', ['\x1b[MC)', null, 'de'], 'e')
console.log('X10 TAIL RESYNC HOLDS')

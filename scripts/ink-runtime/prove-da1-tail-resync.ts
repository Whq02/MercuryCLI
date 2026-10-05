import assert from 'node:assert/strict'
import { decode, expectText } from './input-resync-world.ts'

const head = '\x1b[?1;'
expectText('DA1 after two flushes never types its reply tail', [head, null, null, '2cok'], 'ok')
expectText('DA1 after two flushes consumes a fragmented final', [head, null, null, '2', null, 'c', 'ok'], 'ok')
assert.deepEqual(decode([head, null, '2c']), decode(['\x1b[?1;2c']))
console.log('PASS first reply hold still returns an intact response')
for (const control of ['\x03', '\r', '\x7f', '\x1b[A']) {
  assert.deepEqual(decode([head, null, null, control]), decode([control]))
  console.log(`PASS control ${JSON.stringify(control)} leaves the dropped response`)
}
console.log('DA1 TAIL RESYNC HOLDS')

import assert from 'node:assert/strict'
import { greet } from './src/b.ts'
import { firstCells } from './src/c.ts'

assert.equal(greet('alpha, beta'), 'hello: alpha|beta')
assert.equal(firstCells(Array.from({ length: 12 }, (_, i) => String(i)).join(',')).length, 10)
assert.deepEqual(firstCells('one,two'), ['one', 'two'])
console.log('fixture tests pass')

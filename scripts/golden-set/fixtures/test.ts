import assert from 'node:assert/strict'
import { LIMIT, parseRow } from './src/a.ts'
import { greet } from './src/b.ts'
import { firstCells } from './src/c.ts'

assert.equal(LIMIT, 10)
assert.deepEqual(parseRow('alpha, beta'), ['alpha', 'beta'])
assert.equal(greet('alpha,beta'), 'hello: alpha|beta')
assert.deepEqual(firstCells('one,two'), ['one', 'two'])
console.log('fixture tests pass')

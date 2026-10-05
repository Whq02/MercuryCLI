import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, '../..')
const { applySnipRemovals } = await import(pathToFileURL(resolve(root, 'src/utils/sessionStorage/chain.ts')).href)
const rows = new Map([
  ['a', { type: 'user', uuid: 'a', parentUuid: 'b', message: { role: 'user', content: 'removed' } }],
  ['b', { type: 'user', uuid: 'b', parentUuid: 'a', message: { role: 'user', content: 'removed' } }],
  ['c', { type: 'user', uuid: 'c', parentUuid: 'a', message: { role: 'user', content: 'retained' } }],
  ['cut', { type: 'system', uuid: 'cut', parentUuid: 'c', subtype: 'microcompact_boundary', snipMetadata: { removedUuids: ['a', 'b'] } }],
])
const get = Map.prototype.get
let reads = 0
Map.prototype.get = function (key) {
  if (++reads > 128) throw new Error('FAIL snip parent resolution repeats a removed cycle without making progress')
  return get.call(this, key)
}
try {
  applySnipRemovals(rows)
} finally {
  Map.prototype.get = get
}
assert.equal(rows.has('a'), false)
assert.equal(rows.has('b'), false)
assert.equal(rows.get('c')?.parentUuid, null)
assert.equal(rows.get('cut')?.parentUuid, 'c')
console.log('PASS snip parent cycles terminate and retain the surviving conversation')

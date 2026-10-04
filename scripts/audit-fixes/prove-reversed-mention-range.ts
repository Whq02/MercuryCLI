import assert from 'node:assert/strict'
import { parseAtMentionedFileLines } from '../../src/utils/attachments/mentions.js'

for (const [mention, start, end] of [['file.ts#L20-3', 20, 20], ['file.ts#L3-20', 3, 20], ['file.ts#L5', 5, 5]] as const) {
  const parsed = parseAtMentionedFileLines(mention)
  assert.equal(parsed.filename, 'file.ts')
  assert.equal(parsed.lineStart, start)
  assert.equal(parsed.lineEnd, end)
  assert(parsed.lineEnd! - parsed.lineStart! + 1 >= 1)
}
console.log('PASS reversed mention ranges clamp to one line while forward and single ranges stay intact')

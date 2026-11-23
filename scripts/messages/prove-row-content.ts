import { strict as assert } from 'node:assert'
import { contentItemsOf, storedBlocksOf } from '../../src/engine/rows/content.ts'
import { DIALECT_CONVERSATION, IMAGE_BLOCK, SIGNED_THINKING, TOOL_RESULT_A, TOOL_USE_A } from './dialectFixture.ts'

const blocks = [
  { type: 'text', text: 'fixture text', phase: 'commentary', citations: [] },
  SIGNED_THINKING,
  { type: 'redacted_thinking', data: 'fixture-private-data' },
  TOOL_USE_A,
  TOOL_RESULT_A,
  IMAGE_BLOCK,
  { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'fixture document' } },
  { type: 'fixture-extension', payload: { typed: true } },
] as never[]
const items = contentItemsOf(blocks)
assert.deepEqual(items.map(item => item.type), ['text', 'reasoning', 'reasoning', 'tool_call', 'tool_result', 'media', 'media', 'opaque'], 'contentItemsOf in src/engine/rows/content.ts must map each stored block to its item type in order')
assert.equal(storedBlocksOf(blocks), blocks, 'storedBlocksOf in src/engine/rows/content.ts must return an array of blocks by reference')
assert.deepEqual(items.map(item => item.value), blocks, 'contentItemsOf in src/engine/rows/content.ts must keep each original block as the item value')
assert.equal(items.every((item, index) => item.value === blocks[index]), true, 'contentItemsOf in src/engine/rows/content.ts must keep object identity: item.value is the same block, not a copy')
assert.equal(items[1]?.type === 'reasoning' && items[1].signature, SIGNED_THINKING.signature, 'contentItemsOf in src/engine/rows/content.ts must carry the thinking signature on the reasoning item')
assert.equal(items[3]?.type === 'tool_call' && items[3].input, TOOL_USE_A.input, 'contentItemsOf in src/engine/rows/content.ts must carry the tool_use input on the tool_call item')
assert.equal(items[4]?.type === 'tool_result' && items[4].output, TOOL_RESULT_A.content, 'contentItemsOf in src/engine/rows/content.ts must carry the tool_result content as the output of the tool_result item')
assert.deepEqual(storedBlocksOf('fixture'), [{ type: 'text', text: 'fixture', citations: [] }], 'storedBlocksOf in src/engine/rows/content.ts must wrap a string body as one text block with empty citations')
assert.deepEqual(storedBlocksOf(undefined), [], 'storedBlocksOf in src/engine/rows/content.ts must return an empty list for undefined content')
for (const message of DIALECT_CONVERSATION) {
  if (message.type !== 'assistant' && message.type !== 'user') continue
  const values = storedBlocksOf(message.message.content)
  assert.deepEqual(contentItemsOf(values).map(item => item.value), values, 'contentItemsOf and storedBlocksOf in src/engine/rows/content.ts must round-trip every block of scripts/messages/dialectFixture.ts DIALECT_CONVERSATION')
}
console.log('PASS: the row-content algebra preserves signed reasoning, media, tool input/results, extension fields and object identities')

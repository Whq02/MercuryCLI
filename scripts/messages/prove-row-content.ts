import { strict as assert } from 'node:assert'
import { contentItemsOf, storedBlocksOf } from '../../src/rows/content.ts'
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
assert.deepEqual(items.map(item => item.type), ['text', 'reasoning', 'reasoning', 'tool_call', 'tool_result', 'media', 'media', 'opaque'])
assert.equal(storedBlocksOf(blocks), blocks)
assert.deepEqual(items.map(item => item.value), blocks)
assert.equal(items.every((item, index) => item.value === blocks[index]), true)
assert.equal(items[1]?.type === 'reasoning' && items[1].signature, SIGNED_THINKING.signature)
assert.equal(items[3]?.type === 'tool_call' && items[3].input, TOOL_USE_A.input)
assert.equal(items[4]?.type === 'tool_result' && items[4].output, TOOL_RESULT_A.content)
assert.deepEqual(storedBlocksOf('fixture'), [{ type: 'text', text: 'fixture', citations: [] }])
assert.deepEqual(storedBlocksOf(undefined), [])
for (const message of DIALECT_CONVERSATION) {
  if (message.type !== 'assistant' && message.type !== 'user') continue
  const values = storedBlocksOf(message.message.content)
  assert.deepEqual(contentItemsOf(values).map(item => item.value), values)
}
console.log('PASS: the row-content algebra preserves signed reasoning, media, tool input/results, extension fields and object identities')

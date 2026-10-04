import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { DIALECT_CONVERSATION } from './dialectFixture.ts'

const root = resolve(process.argv[2] ?? new URL('../..', import.meta.url).pathname)
const { mergeAssistantMessages } = await import(`${root}/src/utils/messages/merge.ts`)
const model = DIALECT_CONVERSATION[1] as any
const left = { ...model, message: { ...model.message, content: 'left text' } }
const right = { ...model, message: { ...model.message, content: [{ type: 'text', text: 'right text', citations: [] }] } }
const out = mergeAssistantMessages(left, right)
try {
  assert.deepEqual(out.message.content, [{ type: 'text', text: 'left text', citations: [] }, { type: 'text', text: 'right text', citations: [] }])
  assert.equal(out.uuid, left.uuid)
  assert.equal(out.message.id, left.message.id)
  assert.equal(left.message.content, 'left text')
  console.log('PASS: merging a resumed string-shaped assistant turn keeps whole text blocks, never character strings')
} catch (error) {
  console.log('FAIL: merging a resumed string-shaped assistant turn emits character strings instead of content blocks')
  throw error
}

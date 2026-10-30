import { turn, sse } from './compatBugFixture.ts'
import assert from 'node:assert/strict'
for (const field of ['reasoning_text', 'reasoning_content', 'reasoning']) {
  const result = await turn(() => sse([{ choices: [{ delta: { [field]: 'think' } }] }, { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }]))
  const blocks = result.events.filter(e => e.type === 'assistant').flatMap(e => e.message.content)
  assert.equal(blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join(''), 'think', field)
  assert.equal(blocks.filter(b => b.type === 'text').map(b => b.text).join(''), 'answer')
}
console.log('P07 reasoning_text is decoded as reasoning beside the existing field names')

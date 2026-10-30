import { turn, sse } from './compatBugFixture.ts'
import assert from 'node:assert/strict'
const wire = '<think>plan the answer</think>The answer is 4.'
for (const parts of [[wire], [...wire], ['<thi', 'nk>plan the answer</th', 'ink>The answer is 4.']]) {
  const result = await turn(() => sse([...parts.map(content => ({ choices: [{ delta: { content } }] })), { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }]))
  const blocks = result.events.filter(e => e.type === 'assistant').flatMap(e => e.message.content)
  assert.equal(blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join(''), 'plan the answer')
  assert.equal(blocks.filter(b => b.type === 'text').map(b => b.text).join(''), 'The answer is 4.')
}
for (const text of ['literal <think>markup</think>', '<thi', '```xml\n<think>literal</think>\n```']) {
  const result = await turn(() => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]))
  assert.equal(result.events.filter(e => e.type === 'assistant').flatMap(e => e.message.content).filter(b => b.type === 'text').map(b => b.text).join(''), text)
}
const cut = await turn(() => sse([{ choices: [{ delta: { content: '<think>unfinished thought' }, finish_reason: 'length' }] }]))
assert.equal(cut.events.filter(e => e.type === 'assistant').flatMap(e => e.message.content).filter(b => b.type === 'thinking').map(b => b.thinking).join(''), 'unfinished thought')
console.log('P06 leading think tags split across chunks into reasoning; literal tags and partial content survive')

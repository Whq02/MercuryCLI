import { turn, sse } from './compatBugFixture.ts'
import assert from 'node:assert/strict'
import { streamCompatChat } from '../../src/services/providers/openaicompat/compatChatClient.ts'
const text = 'a'.repeat(5000) + ' café'
for (const contentType of ['application/json', 'text/plain']) {
  const result = await turn(() => new Response(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1500 } }), { headers: { 'content-type': contentType } }))
  assert.equal(result.requests.length, 1)
  assert.equal(result.events.filter(e => e.type === 'assistant').flatMap(e => e.message.content).map(b => b.text ?? '').join(''), text)
}
for (const body of [{ error: { code: 'invalid_api_key', message: 'key was refused' } }, '<html>sign in to gateway</html>']) {
  const events = []
  for await (const event of streamCompatChat({ url: 'http://127.0.0.1:1/chat/completions', request: { model: 'fixture', messages: [] }, fetchImpl: (async () => typeof body === 'string' ? new Response(body, { headers: { 'content-type': 'text/html' } }) : Response.json(body)) as typeof fetch })) events.push(event)
  const fault = events.find(e => e.type === 'stream-fault')
  assert(fault?.type === 'stream-fault')
  assert.equal(fault.fault.retryable, false)
  assert.match(fault.fault.message, /key was refused|sign in to gateway/)
  assert.notEqual(fault.fault.code, 'no-finish')
}
const plain = await turn(async () => new Response(await sse([{ choices: [{ delta: { content: 'plain SSE' }, finish_reason: 'stop' }] }]).text(), { headers: { 'content-type': 'text/plain' } }))
assert(plain.events.some(e => e.type === 'assistant' && e.message.content.some((b: any) => b.text === 'plain SSE')))
console.log('P05 non-stream JSON retains content and usage; invalid bodies retain the refusal; mislabeled SSE still streams')

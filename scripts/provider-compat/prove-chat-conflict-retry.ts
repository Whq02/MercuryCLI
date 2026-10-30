import { turn, answer } from './compatBugFixture.ts'
import assert from 'node:assert/strict'
for (const status of [409, 408, 429]) {
  const result = await turn(attempt => attempt === 1 ? Response.json({ error: { message: 'Try again' } }, { status }) : answer())
  assert.equal(result.requests.length, 2, String(status))
  assert(result.events.some(e => e.type === 'assistant' && !e.isApiErrorMessage))
  assert.deepEqual(result.requests[0], result.requests[1])
}
for (const code of ['rate_limit_exceeded', 'RESOURCE_EXHAUSTED']) {
  const result = await turn(() => Response.json({ error: { code, message: 'Malformed request' } }, { status: 400 }))
  assert.equal(result.requests.length, 1)
}
console.log('P13 conflicts retry unchanged requests; malformed HTTP 400 remains permanent')

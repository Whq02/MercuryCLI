import assert from 'node:assert/strict'
import { imageWindowFixture } from './imageWindowFixture.ts'

const fixture = await imageWindowFixture()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { estimateRequestTokens } = await import('../../src/services/tokenEstimation.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const images = (request: Record<string, any>): string[] => request.messages.flatMap((row: any) => Array.isArray(row.content) ? row.content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url) : [])
const before = JSON.stringify(fixture.messages)
async function drive(messages = fixture.messages) {
  const rows = []
  for await (const row of routedCallModel({ ...fixture.params, messages } as never)) rows.push(row)
  return rows
}
try {
  const small = await drive()
  assert.equal(small.some(row => row.type === 'assistant' && row.isApiErrorMessage), false, 'images degrade before a fit refusal')
  assert.equal(fixture.requests.length, 1)
  const request = fixture.requests[0]!
  const kept = images(request)
  assert.equal(kept.length, 4, 'oldest five images degrade; the latest four fit')
  assert.deepEqual(kept.map(url => url.slice(-1)), ['5', '6', '7', '8'])
  assert.ok(estimateRequestTokens(request, fixture.model) <= fixture.state.window)
  for (let i = 0; i < 9; i++) assert.ok(JSON.stringify(request.messages).includes(`/captures/${i}.png`), 'every artifact path survives')
  assert.equal(JSON.stringify(fixture.messages), before, 'the full transcript is unchanged')
  fixture.state.window = 262144
  await fixture.refresh()
  await drive()
  assert.equal(images(fixture.requests[1]!).length, 9, 'a wide window sends every image')
  fixture.state.window = 1000
  await fixture.refresh()
  const tooMuchText = [...fixture.messages, createUserMessage({ content: 'x'.repeat(20000) })]
  const refused = await drive(tooMuchText)
  assert.equal(fixture.requests.length, 2, 'text alone too large is refused without sending')
  assert.ok(refused.some(row => row.type === 'assistant' && row.isApiErrorMessage))
  assert.equal(JSON.stringify(fixture.messages), before)
  console.log('Small-window order, latest images, all path lines, immutable transcript, wide window and text refusal passed')
} finally {
  await fixture.close()
}

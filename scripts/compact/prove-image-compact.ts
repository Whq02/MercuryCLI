import assert from 'node:assert/strict'
import { imageWindowFixture } from '../provider-compat/imageWindowFixture.ts'

const fixture = await imageWindowFixture()
const { foldConversation, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES } = await import('../../src/engine/compaction/foldConversation.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')
const { estimateRequestTokens } = await import('../../src/models/facts/tokenEstimation.ts')
const before = JSON.stringify(fixture.messages)
const state = { toolPermissionContext: fixture.permission, sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
const context = {
  abortController: new AbortController(),
  getAppState: () => state,
  setAppState: () => {},
  messages: fixture.messages,
  readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
  options: { tools: [], mcpClients: [], engineModel: fixture.model, thinkingConfig: { type: 'disabled' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
}
try {
  fixture.state.window = 20000
  await fixture.refresh()
  const result = await foldConversation(fixture.messages, context as never, { systemPrompt: fixture.params.systemPrompt } as never, true)
  assert.ok(result.summaryMessages.some(row => JSON.stringify(row.message.content).includes('The page has nine screenshot artifacts.')), 'manual compact receives its summary')
  assert.equal(fixture.requests.length, 1, 'one summary request, no failed fold-and-retry')
  const request = fixture.requests[0]!
  const kept = request.messages.flatMap((row: any) => Array.isArray(row.content) ? row.content.filter((part: any) => part.type === 'image_url') : [])
  assert.ok(kept.length > 0 && kept.length < 9, 'the compact request keeps the newest images that fit, not an all-media strip')
  assert.equal(kept.at(-1).image_url.url.slice(-1), '8', 'latest image reaches the summariser')
  for (let i = 0; i < 9; i++) assert.ok(JSON.stringify(request.messages).includes(`/captures/${i}.png`), 'all path lines reach the summariser')
  const compactTokens = estimateRequestTokens(request, fixture.model)
  assert.ok(compactTokens <= fixture.state.window, `compact request tokens=${compactTokens} exceeded window=${fixture.state.window}; check image compaction budget`)
  assert.equal(JSON.stringify(fixture.messages), before, 'source transcript stays intact')
  fixture.state.vision = false
  fixture.state.window = 262144
  await fixture.refresh()
  const textOnly = await foldConversation(fixture.messages, context as never, { systemPrompt: fixture.params.systemPrompt } as never, true)
  assert.ok(textOnly.summaryMessages.length > 0, 'the original text-only shape can compact')
  const textOnlyTokens = estimateRequestTokens(fixture.requests.at(-1), fixture.model)
  assert.ok(textOnlyTokens < 10000, `text-only compact request tokens=${textOnlyTokens}, expected <10000 after image placeholders; check image compaction`)
  await assert.rejects(foldConversation([], context as never, { systemPrompt: fixture.params.systemPrompt } as never, true), { message: ERROR_MESSAGE_NOT_ENOUGH_MESSAGES })
  console.log(`Manual compact succeeded with ${kept.length} newest images on the small window and with placeholders on the text-only window; empty-history words unchanged`)
} finally {
  await fixture.close()
}

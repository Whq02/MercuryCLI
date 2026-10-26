import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountsWorld, fixtureTurn, KEY, MODEL, SUBSCRIPTION } from './anthropicAccountsFixture.ts'
const world = await accountsWorld()
try {
  await world.auth.saveApiKey('fixture-departed-key')
  world.auth.writeAnthropicPreferredSource('api-key')
  assert.equal(world.auth.getAnthropicApiKey(), 'fixture-departed-key')
  const file = join(world.home, '.mercury.json')
  const current = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...current, primaryApiKey: KEY, customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] } }))
  world.config.readGlobalConfigAgain()
  const answer = await fixtureTurn()
  assert.equal(answer.isApiErrorMessage, undefined, 'a warm process must send the newly stored key, not its departed memo')
  assert.equal(world.requests.find(row => row.path === '/v1/messages')?.key, KEY)
  assert.equal(world.auth.isCustomApiKeyApproved(KEY), true)
  assert.ok(answer.message.content.some(block => block.type === 'text' && block.text === 'fixture answered'))
  world.auth.saveOAuthTokensIfNeeded(SUBSCRIPTION)
  world.auth.writeAnthropicPreferredSource(null)
  const { getAnthropicClient } = await import('../../src/services/api/client.ts')
  const candidate = await getAnthropicClient({ apiKey: KEY, maxRetries: 0 })
  assert.equal(candidate.apiKey, KEY)
  assert.equal(candidate.authToken, null, 'an explicit key probe must not authenticate with the stored subscription')
  await candidate.messages.create({ model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'key probe' }] })
  assert.equal(world.requests.at(-1)?.key, KEY)
  assert.equal(world.requests.at(-1)?.bearer, undefined)
  console.log('PASS stored-key replacement reaches a warm routed Haiku turn; explicit key probes never borrow subscription auth')
} finally { await world.close() }

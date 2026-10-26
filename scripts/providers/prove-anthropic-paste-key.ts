import assert from 'node:assert/strict'
import { accountsWorld, KEY } from './anthropicAccountsFixture.ts'
const world = await accountsWorld()
try {
  const { anthropicArmPickRows } = await import('../../src/components/loginFamilyRows.ts')
  assert.ok(anthropicArmPickRows.some(row => String(row.value) === 'key'), 'Anthropic must offer a separate API-key paste row')
  const { storeAnthropicApiKeyLogin } = await import('../../src/services/providers/anthropic/anthropicLogin.ts')
  const bad = await storeAnthropicApiKeyLogin('sk-ant-usr-refused')
  assert.equal(bad.stored, false)
  assert.match(bad.receipt, /invalid x-api-key/)
  assert.equal(world.auth.getApiKeyFromConfigOrMacOSKeychain(), null)
  const good = await storeAnthropicApiKeyLogin(KEY)
  assert.equal(good.stored, true)
  assert.equal(world.auth.getAnthropicApiKey(), KEY)
  process.env.ANTHROPIC_API_KEY = 'fixture-environment'
  world.config.saveGlobalConfig(current => ({ ...current, customApiKeyResponses: { approved: ['fixture-environment'], rejected: [] } }))
  assert.equal(world.auth.getAnthropicApiKeyWithSource().source, 'ANTHROPIC_API_KEY')
  assert.equal(world.auth.getAnthropicApiKey(), 'fixture-environment')
  console.log('PASS Anthropic paste, 401 refusal without storage, accepted key and environment precedence')
} finally { await world.close() }

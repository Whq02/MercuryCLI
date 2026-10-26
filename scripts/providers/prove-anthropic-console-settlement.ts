import assert from 'node:assert/strict'
import { accountsWorld, KEY, WORKSPACE, until } from './anthropicAccountsFixture.ts'
const world = await accountsWorld()
const subscriptionAccount = { accountUuid: 'existing-subscription', emailAddress: 'subscription@example.invalid' }
world.config.saveGlobalConfig(current => ({ ...current, oauthAccount: subscriptionAccount }))
const { OAuthService } = await import('../../src/services/oauth/index.ts')
const { createAnthropicLoginMachine } = await import('../../src/components/mercury-ui/screens/anthropicLoginModel.ts')
const unhandled: unknown[] = []
const rejected = (error: unknown) => { unhandled.push(error) }
process.on('unhandledRejection', rejected)
let recorded = 0
let created = 0
const machine = createAnthropicLoginMachine({ onDone() {} }, () => {}, {
  createService: () => {
    created++
    const service = new OAuthService()
    return {
      startOAuthFlow: (callback, options) => service.startOAuthFlow((url, manualUrl) => {
        callback(url, manualUrl)
        const state = new URL(url).searchParams.get('state')!
        service.handleManualAuthCodeInput({ authorizationCode: 'fixture-code', state })
      }, { ...options, skipBrowserOpen: true }),
      handleManualAuthCodeInput: input => service.handleManualAuthCodeInput(input),
      cleanup: () => service.cleanup(),
    }
  },
  recordSignIn: () => { recorded++ }, settings: () => ({}), log: () => {},
})
try {
  world.mint(200, { raw_key: 'not a key' })
  machine.start(false)
  await until(() => ['success', 'error'].includes(machine.snapshot().flow.name))
  assert.equal(machine.snapshot().flow.name, 'error', 'Console must await the key save before announcing success')
  assert.equal(recorded, 0)
  assert.equal(unhandled.length, 0)
  assert.deepEqual(world.config.getGlobalConfig().oauthAccount, subscriptionAccount, 'Console must not overwrite the subscription identity')
  assert.equal(world.auth.getAnthropicApiKey(), null)
  world.mint(403, { error: { message: 'Your role does not permit API keys' } })
  machine.retry()
  await until(() => created === 2 && machine.snapshot().flow.name === 'error')
  const failure = machine.snapshot().flow
  assert.ok(failure.name === 'error')
  assert.equal(failure.message, 'Your role does not permit API keys')
  assert.ok(failure.retry, 'Console refusal must leave a working retry')
  assert.equal(recorded, 0)
  world.mint(200, {})
  machine.retry()
  await until(() => created === 3 && machine.snapshot().flow.name === 'error')
  assert.equal(recorded, 0)
  world.mint(200, { raw_key: KEY, workspace_id: WORKSPACE })
  machine.retry()
  await until(() => created === 4 && machine.snapshot().flow.name === 'success')
  assert.equal(recorded, 1)
  assert.equal(world.auth.getAnthropicApiKey(), KEY)
  assert.equal(world.auth.getAnthropicApiKeyWorkspaceId(KEY), WORKSPACE)
  assert.ok(world.requests.some(row => row.path === '/v1/oauth/token' && row.body.grant_type === 'authorization_code'))
  assert.equal(world.requests.filter(row => row.path.endsWith('/create_api_key')).length, 4)
  console.log('PASS Console exchange, failed save, provider refusal, keyless mint, retry and landed workspace key')
} finally {
  machine.dispose()
  await world.close()
  process.removeListener('unhandledRejection', rejected)
}

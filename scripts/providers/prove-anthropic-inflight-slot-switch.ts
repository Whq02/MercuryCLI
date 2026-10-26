import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountsWorld, fixtureTurn, KEY, SUBSCRIPTION, until } from './anthropicAccountsFixture.ts'
const world = await accountsWorld()
try {
  assert.equal(world.auth.saveOAuthTokensIfNeeded(SUBSCRIPTION).success, true)
  await world.auth.saveApiKey(KEY)
  world.hold()
  const first = [fixtureTurn('crewmate alpha first', 'alpha'), fixtureTurn('crewmate beta first', 'beta')]
  await Promise.race([until(() => world.held() === 2, 'two pending requests'), Promise.all(first).then(answers => { throw new Error(`crewmates settled before release: ${JSON.stringify(answers.map(answer => answer.message.content))}`) })])
  assert.ok(world.requests.filter(row => row.path === '/v1/messages').every(row => row.bearer === `Bearer ${SUBSCRIPTION.accessToken}`))
  const file = join(world.home, '.mercury.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), anthropicPreferredSource: 'api-key' }))
  await until(() => world.auth.readAnthropicPreferredSource() === 'api-key')
  world.release()
  for (const answer of await Promise.all(first)) assert.equal(answer.isApiErrorMessage, undefined, 'in-flight crewmates finish with their original credential')
  const next = await Promise.all([fixtureTurn('crewmate alpha next', 'alpha'), fixtureTurn('crewmate beta next', 'beta')])
  for (const answer of next) assert.equal(answer.isApiErrorMessage, undefined, 'next crewmate requests must agree on credential and auth headers after an external preference write')
  const newRequests = world.requests.filter(row => row.path === '/v1/messages').slice(2)
  assert.equal(newRequests.length, 2)
  assert.ok(newRequests.every(row => row.key === KEY && row.bearer === undefined && !row.beta.includes('oauth-2025-04-20')))
  const { switchActiveSlot } = await import('../../src/services/providers/slotSwitch.ts')
  assert.equal(switchActiveSlot('anthropic', { to: 'subscription' }).switched, true)
  assert.equal((await fixtureTurn('board switched back')).isApiErrorMessage, undefined)
  let refused = false
  world.onMessage((_body, response) => {
    if (refused) return false
    refused = true
    world.auth.writeAnthropicPreferredSource('api-key')
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'departed credential refused' } }))
    return true
  })
  assert.equal((await fixtureTurn('switch raced a 401')).isApiErrorMessage, undefined, 'a changed credential is resolved before a 401 can end the work')
  assert.ok(refused)
  console.log('PASS two concurrent agent turns finish through external slot switch, next requests and board switch back')
} finally { world.release(); await world.close() }

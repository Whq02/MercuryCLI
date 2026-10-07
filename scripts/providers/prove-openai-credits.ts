#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'openai-credits-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MERCURY_USAGE_SEED']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const owner = await import('../../src/services/providers/providerUsage.ts')
const state = await import('../../src/services/providers/openai/openaiLimitState.ts')
const accounts = await import('../../src/services/providers/openai/openaiAccounts.ts')
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/openai-chatgpt-usage.json'), 'utf8'))
const captured = fixture.body.rate_limit.primary_window
let now = (captured.reset_at - captured.reset_after_seconds) * 1000
const seed = (accountId: string) => writeFileSync(join(home, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { accessToken: 'fixture-access', refreshToken: `fixture-refresh-${accountId}`, idToken: 'fixture-id', accountId, planType: 'pro', accessTokenExpiresAtMs: now + 86_400_000 } }))
let body: unknown = fixture.body
let status = 200
let calls = 0
let hold: Promise<void> | undefined
let release: (() => void) | undefined
let arrived: (() => void) | undefined
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  calls++
  assert.equal(request.method, 'GET')
  assert.equal(new URL(request.url).pathname, '/backend-api/wham/usage')
  assert.equal(request.headers.get('authorization'), 'Bearer fixture-access')
  assert.equal(request.headers.get('chatgpt-account-id'), 'fixture-A')
  arrived?.()
  if (hold) await hold
  return Response.json(body, { status, headers: { 'retry-after': '120' } })
} })
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_OPENAI_CHATGPT_BASE = `${base}/backend-api/codex`
const originalFetch = globalThis.fetch
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  assert.equal(new URL(String(input)).origin, base)
  return originalFetch(input, init)
}) as typeof fetch
const io = { fetchImpl, now: () => now }
const view = () => owner.usageForProvider('openai')
const check = (name: string, test: () => void) => { test(); console.log(`PASS ${name}`) }
try {
  seed('fixture-A')
  state.__resetOpenaiLimitStateForTest()
  check('before the first reply no balance is fabricated', () => assert.equal(view().credits?.reason, 'not stated on this reply yet'))
  await Promise.all([owner.refreshProviderUsage('openai', io), owner.refreshProviderUsage('openai', io)])
  check('one loopback GET follows the product refresh door and auth headers', () => assert.equal(calls, 1))
  check('the live fixture states 62,500, not dollars or estimated plan headroom', () => {
    assert.equal(view().credits?.display, '62,500')
    assert.equal(view().credits?.compact, '62.5k')
    assert.equal(view().credits?.observedAtMs, now)
    assert.equal(view().credits?.source, 'endpoint')
    assert.equal(view().windows[0]?.usedPct, 99)
    assert.equal(view().windows[0]?.source, 'endpoint')
    assert.equal(view().credits?.freshForMs, view().windows[0]?.freshForMs)
  })
  await owner.refreshProviderUsage('openai', io)
  check('showing a fresh meter again spends no request', () => assert.equal(calls, 1))
  const { deriveFamilySlotGroups } = await import('../../src/services/providers/accountSlots.ts')
  process.env.OPENAI_API_KEY = 'fixture-api-key'
  accounts.writePreferredOpenaiSource('api-key')
  const subscriptionSlot = deriveFamilySlotGroups().flatMap(group => group.slots).find(slot => slot.id === 'openai:subscription')
  check('the account row keeps its own credits while a key is active', () => {
    assert.equal(subscriptionSlot?.active, false)
    assert.equal(subscriptionSlot?.credits?.display, '62,500')
    assert.equal(view().credits?.state, 'unreported')
  })
  accounts.writePreferredOpenaiSource('chatgpt-subscription')
  delete process.env.OPENAI_API_KEY
  const stamped = view().credits?.observedAtMs
  now += 180_000
  status = 429
  await owner.refreshProviderUsage('openai', io)
  await owner.refreshProviderUsage('openai', io)
  check('one refusal keeps the last balance and a reader wait, without retry', () => {
    assert.equal(calls, 2)
    assert.equal(view().credits?.observedAtMs, stamped)
    assert.equal(view().readerWait, true)
    assert.match(view().readerNote ?? '', /HTTP 429/)
    assert.match(owner.usageCreditsLine(view().credits, now) ?? '', /stale/)
  })
  status = 200
  now += 180_000
  body = { rate_limit: null }
  await owner.refreshProviderUsage('openai', io)
  check('an absent field never restamps or zeroes the last balance', () => assert.equal(view().credits?.observedAtMs, stamped))
  for (const [credits, stateName, words] of [
    [{ has_credits: true, unlimited: true, balance: null }, 'reported', 'unlimited'],
    [{ has_credits: false, unlimited: false, balance: '0' }, 'reported', '0'],
    [{ has_credits: false, unlimited: false, balance: null }, 'unreported', 'no credits on this plan'],
    [{ has_credits: true, unlimited: false, balance: null }, 'unreported', 'balance not stated on this reply'],
    [{ has_credits: true, unlimited: false, balance: '1234.500' }, 'reported', '1,234.500'],
  ] as const) {
    now++
    body = { credits }
    await owner.refreshProviderUsage('openai', { ...io, force: true })
    check(`the provider's ${words} arm stays explicit`, () => {
      assert.equal(view().credits?.state, stateName)
      assert.equal(view().credits?.display ?? view().credits?.reason, words)
    })
  }
  const held = state.openaiObservedUsage().credits
  now++
  state.recordOpenaiRateHeaders(new Headers({ 'x-codex-credits-has-credits': 'oops', 'x-codex-credits-unlimited': 'false', 'x-codex-credits-balance': '999' }), () => now)
  check('malformed credit flags do not invent a new observation', () => assert.deepEqual(state.openaiObservedUsage().credits, held))
  now++
  state.recordOpenaiRateHeaders(new Headers({ 'x-codex-credits-has-credits': '1', 'x-codex-credits-unlimited': '0', 'x-codex-credits-balance': '62500' }), () => now)
  check('Codex credit headers feed the same balance owner', () => {
    assert.equal(view().credits?.display, '62,500')
    assert.equal(view().credits?.source, 'headers')
  })
  state.forgetOpenaiLimitSource('api-key')
  check('forgetting a key does not erase the subscription balance', () => assert.equal(view().credits?.display, '62,500'))
  seed('fixture-B')
  check('an external credential switch cannot repaint the departed balance', () => assert.equal(view().credits?.state, 'unreported'))
  seed('fixture-A')
  view()
  hold = new Promise(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { arrived = resolve })
  body = fixture.body
  const pending = owner.refreshProviderUsage('openai', { ...io, force: true })
  await entered
  accounts.disconnectOpenaiSubscription()
  release!()
  await pending
  check('a late response after sign-out cannot resurrect its credits', () => {
    assert.equal(view().credits, undefined)
    assert.equal(state.openaiObservedUsage().credits, undefined)
  })
  const before = calls
  await owner.refreshProviderUsage('openai', { ...io, force: true })
  check('signed out means no usage request', () => assert.equal(calls, before))
  process.env.OPENAI_API_KEY = 'fixture-api-key'
  await owner.refreshProviderUsage('openai', { ...io, force: true })
  check('a key never borrows the subscription endpoint or balance', () => {
    assert.equal(calls, before)
    assert.equal(view().credits?.state, 'unreported')
    assert.equal(view().sourceKind, 'api-key')
  })
  console.log('OPENAI CREDITS: ALL PASS')
} finally {
  release?.()
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}

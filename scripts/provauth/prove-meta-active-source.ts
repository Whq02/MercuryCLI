#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { rmSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_META_API_BASE = 'http://127.0.0.1:1/v1'
for (const k of ['MODEL_API_KEY', 'META_API_KEY']) delete process.env[k]

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const accounts = await import('../../src/services/providers/meta/metaAccounts.ts')
const login = await import('../../src/services/providers/meta/metaLogin.ts')
const secrets = await import('../../src/services/providers/providerSecrets.ts')

const keyFetch = (): typeof fetch =>
  (async () =>
    Response.json(
      { data: [{ id: 'muse-spark-1.3', created: 3, owned_by: 'meta' }] },
      { status: 200 },
    )) as unknown as typeof fetch

const museFetch = (serial: number): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/oidc/device/authorization/')) {
      return Response.json({
        device_code: `dev-${serial}`,
        user_code: `CODE-${serial}`,
        verification_uri: 'https://auth.meta.com/device',
        interval: 1,
        expires_in: 300,
      })
    }
    if (url.endsWith('/oidc/device/token/')) {
      return Response.json({ access_token: `META-AT-${serial}` })
    }
    if (url.endsWith('/muse-code/key')) {
      return Response.json({
        api_key: `LLM|10000${serial}|minted-key-fixture-${serial}`,
        user_email: `user${serial}@example.com`,
        user_id: `uid-${serial}`,
        is_subs_active: true,
        subs_tier_id: 'pro',
        subs_tier_name: 'Muse Code Pro',
        subs_usage: {
          window: { used_percent: 15, resets_at: '2026-10-14T10:00:00Z', window_duration_mins: 300 },
          weekly: { used_percent: 30, resets_at: '2026-10-20T00:00:00Z', window_duration_mins: 10080 },
        },
      })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch

try {
  console.log('── one store at a time: the only source is the active one ──')
  accounts.disconnectMetaMuseCode()
  secrets.writeStoredMetaApiKey(null)
  const keyOnly = await login.storeMetaApiKeyLogin('LLM|111111|key-only-fixture-000001', { fetchImpl: keyFetch() })
  check(
    'a pasted key alone is the active source and its receipt says what requests ride',
    keyOnly.ok &&
      accounts.resolveMetaAccount()?.kind === 'api-key' &&
      keyOnly.receipt.includes('the active source') &&
      keyOnly.receipt.includes('api.meta.ai/v1'),
    keyOnly.receipt,
  )
  check(
    'the key receipt names no second source when none is stored',
    !keyOnly.receipt.includes('Muse Code sign-in stays stored'),
    keyOnly.receipt,
  )
  secrets.writeStoredMetaApiKey(null)
  accounts.writePreferredMetaSource(null)
  const museOnly = await login.runMetaDeviceLogin({
    io: { fetchImpl: museFetch(1), now: () => 1_760_000_000_000 },
    sleep: async () => {},
  })
  check(
    'a Muse Code sign-in alone is the active source and its receipt says so',
    museOnly.ok &&
      accounts.resolveMetaAccount()?.kind === 'muse-code' &&
      museOnly.receipt.includes('the active source') &&
      !museOnly.receipt.includes('An API key is also stored'),
    museOnly.receipt,
  )

  console.log('── both stored: the latest sign-in action is the active source ──')
  const keyAfterGrant = await login.storeMetaApiKeyLogin('LLM|222222|key-after-grant-fixture-0002', { fetchImpl: keyFetch() })
  check(
    'a key pasted while a Muse Code grant stands becomes the active source',
    accounts.resolveMetaAccount()?.kind === 'api-key' && accounts.readPreferredMetaSource() === 'api-key',
    `active=${accounts.resolveMetaAccount()?.kind} preferred=${accounts.readPreferredMetaSource()}`,
  )
  check(
    'its receipt names the key as the active source and the stored Muse Code sign-in with its row',
    keyAfterGrant.receipt.includes('the active source') &&
      keyAfterGrant.receipt.includes('api.meta.ai/v1') &&
      keyAfterGrant.receipt.includes('Muse Code sign-in stays stored') &&
      keyAfterGrant.receipt.includes('/logins'),
    keyAfterGrant.receipt,
  )
  check(
    'the resolved API key for the active source is the pasted key, not the minted key',
    accounts.resolveMetaApiKey()?.key === 'LLM|222222|key-after-grant-fixture-0002' &&
      accounts.resolveMetaApiKey()?.source === 'stored',
  )
  const grantAfterKey = await login.runMetaDeviceLogin({
    io: { fetchImpl: museFetch(2), now: () => 1_760_000_060_000 },
    sleep: async () => {},
  })
  check(
    'a Muse Code sign-in completed while a key is stored becomes the active source',
    accounts.resolveMetaAccount()?.kind === 'muse-code' && accounts.readPreferredMetaSource() === 'muse-code',
  )
  check(
    'its receipt names the Muse Code sign-in as the active source and the stored key with its row',
    grantAfterKey.receipt.includes('the active source') &&
      grantAfterKey.receipt.includes('An API key is also stored') &&
      grantAfterKey.receipt.includes('/logins'),
    grantAfterKey.receipt,
  )
  check(
    'the resolved API key for the active source is the minted key, not the pasted key',
    accounts.resolveMetaApiKey()?.key === 'LLM|100002|minted-key-fixture-2' &&
      accounts.resolveMetaApiKey()?.source === 'muse-code',
  )

  console.log('── a stored source is made active from its row, nothing re-entered ──')
  const toKey = login.activateMetaSource('api-key')
  check(
    '↵ on the key row makes the key active and says what rides',
    toKey.ok &&
      accounts.resolveMetaAccount()?.kind === 'api-key' &&
      toKey.receipt.includes('the API key is now the active source') &&
      toKey.receipt.includes('pay-as-you-go') &&
      toKey.receipt.includes('Muse Code sign-in stays stored'),
    toKey.receipt,
  )
  check(
    'the key value stored before is the one that rides (nothing re-entered)',
    accounts.resolveMetaApiKey()?.key === 'LLM|222222|key-after-grant-fixture-0002',
  )
  const toGrant = login.activateMetaSource('muse-code')
  check(
    '↵ on the Sign in with Meta row makes the grant active again, the key kept',
    toGrant.ok &&
      accounts.resolveMetaAccount()?.kind === 'muse-code' &&
      toGrant.receipt.includes('the Muse Code sign-in is now the active source') &&
      toGrant.receipt.includes('An API key is also stored') &&
      secrets.readStoredMetaApiKey() === 'LLM|222222|key-after-grant-fixture-0002',
    toGrant.receipt,
  )
  check(
    'the grant stored before is the one that rides (no new sign-in)',
    accounts.readMetaMuseCodeGrant()?.accessToken === 'META-AT-2' &&
      accounts.resolveMetaApiKey()?.key === 'LLM|100002|minted-key-fixture-2',
  )

  console.log('── the rows say which source rides and offer the switch ──')
  const now = 1_760_000_240_000
  const bothGrantActive = login.metaConnectRows(
    {
      keySource: 'stored',
      museCodeConnected: true,
      museCodeTier: 'Muse Code Pro',
      museCodeReadAtMs: now - 180_000,
      active: 'muse-code',
    },
    now,
  )
  check(
    'with the grant active the key row says it is stored and not active, ↵ making it active',
    bothGrantActive[0]?.label === 'Sign in with Meta — connected (Muse Code Pro, read 3m ago) · ↵ signs in again' &&
      bothGrantActive[1]?.label === 'API key — stored, not active · ↵ makes it active',
    JSON.stringify(bothGrantActive),
  )
  const bothKeyActive = login.metaConnectRows(
    {
      keySource: 'stored',
      museCodeConnected: true,
      museCodeTier: 'Muse Code Pro',
      museCodeReadAtMs: now - 180_000,
      active: 'api-key',
    },
    now,
  )
  check(
    'with the key active the Meta row says it is connected and not active, ↵ making it active',
    bothKeyActive[0]?.label === 'Sign in with Meta — connected (Muse Code Pro, read 3m ago), not active · ↵ makes it active' &&
      bothKeyActive[1]?.label === 'API key — connected (stored locally) · ↵ pastes a replacement',
    JSON.stringify(bothKeyActive),
  )
  const envKeyInactive = login.metaConnectRows(
    {
      keySource: 'env',
      keyEnvName: 'MODEL_API_KEY',
      museCodeConnected: true,
      museCodeTier: 'Muse Code Pro',
      active: 'muse-code',
    },
    now,
  )
  check(
    'an environment key that is not active names its variable and offers the switch',
    envKeyInactive[1]?.label === 'API key — MODEL_API_KEY in the environment, not active · ↵ makes it active',
    envKeyInactive[1]?.label,
  )
  check(
    'the row action: a stored, inactive source activates; an active or absent one enters its road',
    login.metaConnectRowAction({ keySource: 'stored', museCodeConnected: true, active: 'muse-code' }, 'key') === 'activate' &&
      login.metaConnectRowAction({ keySource: 'stored', museCodeConnected: true, active: 'api-key' }, 'device') === 'activate' &&
      login.metaConnectRowAction({ keySource: 'stored', museCodeConnected: false, active: 'api-key' }, 'key') === 'enter' &&
      login.metaConnectRowAction({ keySource: 'stored', museCodeConnected: true, active: 'muse-code' }, 'device') === 'enter' &&
      login.metaConnectRowAction({ museCodeConnected: false }, 'device') === 'enter',
  )
  const live = login.liveMetaConnectFacts()
  check(
    'the live facts carry the active source',
    live.active === 'muse-code' && live.keySource === 'stored' && live.museCodeConnected,
    JSON.stringify(live),
  )
  const singleKey = login.metaConnectRows({ keySource: 'stored', museCodeConnected: false, active: 'api-key' }, now)
  check(
    'with one source stored the first row offers Sign in with Meta and the key row offers replacement',
    singleKey[0]?.label === login.META_MUSE_CODE_ROW &&
      singleKey[1]?.label === 'API key — connected (stored locally) · ↵ pastes a replacement',
    JSON.stringify(singleKey),
  )
  check(
    'the stored-sources note names the active source and the other row',
    login.metaStoredSourcesNote({ keySource: 'stored', museCodeConnected: true, active: 'muse-code' }) ===
      'Active source: the Muse Code sign-in · an API key is also stored — ↵ on its /logins meta row makes it active' &&
      login.metaStoredSourcesNote({ keySource: 'env', keyEnvName: 'META_API_KEY', museCodeConnected: true, active: 'api-key' }) ===
        'Active source: the API key (META_API_KEY) · the Muse Code sign-in is also stored — ↵ on its /logins meta row makes it active' &&
      login.metaStoredSourcesNote({ keySource: 'stored', museCodeConnected: false, active: 'api-key' }) === undefined,
  )

  console.log('── the disconnects keep the rule honest ──')
  accounts.disconnectMetaMuseCode()
  check(
    'removing the active grant leaves the stored key active',
    accounts.resolveMetaAccount()?.kind === 'api-key' && accounts.readPreferredMetaSource() === undefined,
  )
  secrets.writeStoredMetaApiKey(null)
  check('with nothing stored no source is active', accounts.resolveMetaAccount() === undefined)

  console.log(`\n${passes} passed, ${failures} failed`)
} finally {
  rmSync(proofHome, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)

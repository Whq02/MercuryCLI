import assert from 'node:assert/strict'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const hf = await hfEndpointsFixture()
let refreshes = 0
const oauth = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  assert.equal(new URL(req.url).pathname, '/oauth/token')
  const form = new URLSearchParams(await req.text())
  assert.equal(form.get('grant_type'), 'refresh_token')
  refreshes++
  return Response.json({ access_token: form.get('refresh_token')?.startsWith('fixture-scope-') ? form.get('refresh_token') + '-fresh' : hf.key, refresh_token: form.get('refresh_token'), expires_in: 7200 })
} })
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'http://127.0.0.1:' + oauth.port
process.env.MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID = 'fixture-client'
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.origin); throw new Error('Only loopback fixtures are allowed') }
  return nativeFetch(input, init)
}, nativeFetch)
try {
  const { writeHuggingfaceTokens, huggingfaceStoredTokens, refreshHuggingfaceTokens } = await import('../../src/services/providers/huggingface/huggingfaceAccounts.ts')
  const { vendorClient } = await import('../../src/services/host/vendors/client.ts')
  const { writeStoredHuggingfaceApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  writeHuggingfaceTokens({ accessToken: 'fixture-expired', refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() - 1 })
  assert.deepEqual(await vendorClient('huggingface', { apiBaseUrl: hf.baseUrl }).pods(), [])
  assert.equal(refreshes, 1)
  assert.ok(hf.requests.filter(row => row.path === '/api/whoami-v2').every(row => row.authorized))
  console.log('PASS expired OAuth refreshes before whoami')
  writeHuggingfaceTokens({ accessToken: 'fixture-rejected-oauth', refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 7200_000 })
  const before = hf.requests.filter(row => row.path === '/api/whoami-v2').length
  assert.deepEqual(await vendorClient('huggingface', { apiBaseUrl: hf.baseUrl }).pods(), [])
  assert.equal(refreshes, 2)
  assert.equal(hf.requests.filter(row => row.path === '/api/whoami-v2').length - before, 2)
  console.log('PASS Hub 401 refreshes once and retries once')
  writeHuggingfaceTokens(null)
  writeStoredHuggingfaceApiKey('fixture-rejected-paste')
  for (let index = 0; index < 3; index++) await assert.rejects(vendorClient('huggingface', { apiBaseUrl: hf.baseUrl }).pods(), error => (error as { state?: string }).state === 'sign-in-required' && String(error).includes('sign in again with /logins huggingface'))
  assert.equal(refreshes, 2)
  assert.equal(hf.requests.filter(row => row.path === '/api/whoami-v2' && !row.authorized).length, 2)
  writeStoredHuggingfaceApiKey(hf.key)
  assert.deepEqual(await vendorClient('huggingface', { apiBaseUrl: hf.baseUrl }).pods(), [])
  console.log('PASS rejected paste parks without a loop; replacing it recovers')
  const { setAuthScope, clearAuthScope, getAuthScope, getAuthConfigHomeDir, withAuthScope } = await import('../../src/utils/envUtils.ts')
  const jobHome = join(f.home, 'job-account')
  setAuthScope(jobHome)
  writeHuggingfaceTokens({ accessToken: 'fixture-job-expired', refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() - 1 })
  clearAuthScope()
  const job = { id: 'fixture-job', vendor: 'huggingface' as const, huggingfaceCredential: { source: 'stored' as const, home: jobHome } }
  assert.deepEqual(await vendorClient(job, { apiBaseUrl: hf.baseUrl }).pods(), [])
  assert.equal(refreshes, 3)
  assert.equal(getAuthConfigHomeDir(), f.home)
  assert.equal(escaped.length, 0)
  console.log('PASS stored job refresh uses its captured auth home without changing the caller')
  setAuthScope(f.home)
  await Promise.all(['a', 'b'].map(name => withAuthScope(join(f.home, name), async () => {
    assert.equal(getAuthScope(), f.home)
    writeHuggingfaceTokens({ accessToken: 'fixture-stale-' + name, refreshToken: 'fixture-scope-' + name, accessTokenExpiresAtMs: Date.now() - 1 })
    const first = refreshHuggingfaceTokens()
    assert.equal(first, refreshHuggingfaceTokens())
    const result = await first
    assert.equal(getAuthConfigHomeDir(), join(f.home, name))
    assert.equal(result?.accessToken, 'fixture-scope-' + name + '-fresh')
    assert.equal(huggingfaceStoredTokens()?.accessToken, result?.accessToken)
  })))
  assert.equal(refreshes, 5)
  assert.equal(getAuthConfigHomeDir(), f.home)
  clearAuthScope()
  console.log('PASS two homes refresh independently across await; one home shares one promise')
} finally { globalThis.fetch = nativeFetch; oauth.stop(true); await hf.close(); f.close() }

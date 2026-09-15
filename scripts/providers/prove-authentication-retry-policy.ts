import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import axios from 'axios'

let refreshes = 0
axios.defaults.adapter = async () => { refreshes++; throw new Error('unexpected refresh in fixture') }

const src = resolve(process.env.PROVE_SRC ?? join(import.meta.dir, '../../src'))
const home = mkdtempSync(join(process.env.PROVE_SCRATCH ?? tmpdir(), 'authentication-policy-'))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERCURY_') || key.startsWith('ANTHROPIC_')) delete process.env[key]
}
delete process.env.CI
delete process.env.NODE_ENV
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs, saveGlobalConfig } = await import(join(src, 'utils/config/globalConfig.ts'))
enableConfigs()
saveGlobalConfig((config: Record<string, unknown>) => ({ ...config, oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'fixture@example.invalid', organizationUuid: 'fixture-organization' } }))
const auth = await import(join(src, 'utils/auth.ts'))
const { APIError } = await import('@anthropic-ai/sdk')
const { getAssistantMessageFromError } = await import(join(src, 'services/api/errors.ts'))
const { isRetryableError, withRetry, CannotRetryError } = await import(join(src, 'services/api/withRetry.ts'))
let failures = 0
let checks = 0
const check = (name: string, ok: boolean) => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`) }
const refusal = (status: number, message = 'credential rejected', headers: Record<string, string> = {}) => new APIError(status, { error: { message } }, message, new Headers(headers))
const seed = (accessToken: string) => {
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null } }))
  auth.clearOAuthTokenCache()
}
seed('fixture-stale')
for (const [status, text] of [[401, 'credential rejected'], [403, 'OAuth token has been revoked']] as const) {
  for (const headers of [{}, { 'x-should-retry': 'true' }, { 'retry-after': '3600' }]) {
    const error = refusal(status, text, headers)
    const row = getAssistantMessageFromError(error, 'claude-opus-5')
    check(`${status} ${JSON.stringify(headers)} never enters backoff`, !isRetryableError(error))
    check(`${status} ${JSON.stringify(headers)} is a blocker, never a delayed wake`, row.error === 'authentication_failed' && row.providerWaitEndsAtMs === undefined)
  }
}
check('a bare permission refusal is not an authentication retry', !isRetryableError(refusal(403, 'permission denied')))
check('transient server errors keep their retry policy', isRetryableError(refusal(503, 'temporarily unavailable')))
check('rate limits keep their retry policy', isRetryableError(refusal(429, 'rate limit')))
const window = getAssistantMessageFromError(refusal(503, 'temporarily unavailable', { 'retry-after': '3600' }), 'claude-opus-5')
check('non-authentication waits keep their wake timestamp', typeof window.providerWaitEndsAtMs === 'number')
const keyLimit = getAssistantMessageFromError(refusal(403, 'Key limit exceeded', { 'retry-after': '3600' }), 'openrouter/fixture-model')
check('a key quota wall keeps its wait and never borrows another account', typeof keyLimit.providerWaitEndsAtMs === 'number' && !JSON.stringify(keyLimit).includes('fixture@example.invalid'))
for (const error of [refusal(401), refusal(403, 'OAuth token has been revoked')]) {
  const gateway = getAssistantMessageFromError(error, 'fixture-gateway-model')
  check(`the gateway ${error.status} names the active account consistently`, JSON.stringify(gateway).includes('fixture@example.invalid'))
}

let requests = 0
let clients = 0
const bearers: string[] = []
const sent = withRetry(async () => { clients++; return { authToken: auth.getClaudeAIOAuthTokens()?.accessToken } as never }, async (client: { authToken: string }) => {
  requests++
  bearers.push(client.authToken)
  if (requests === 1) { seed('fixture-fresh'); throw refusal(401, 'credential rejected', { 'retry-after': '0.001' }) }
  return 'accepted'
}, { model: 'claude-opus-5', thinkingConfig: { type: 'disabled' } })
let notices = 0
let result
for (;;) { const item = await sent.next(); if (item.done) { result = item.value; break } notices++ }
check('a concurrent refresh is compared with the bearer actually sent', result === 'accepted' && clients === 2 && requests === 2 && bearers.join(',') === 'fixture-stale,fixture-fresh')
check('a concurrent refresh retries immediately without another refresh or wait notice', notices === 0 && refreshes === 0)

requests = 0
clients = 0
const noRetry = withRetry(async () => { clients++; return { authToken: null } as never }, async () => { requests++; throw refusal(401) }, { maxRetries: 0, model: 'claude-opus-5', thinkingConfig: { type: 'disabled' } })
let terminal: unknown
try { await noRetry.next() } catch (error) { terminal = error }
check('an explicit zero retry budget remains zero', clients === 1 && requests === 1 && terminal instanceof CannotRetryError)
console.log(`prove-authentication-retry-policy: ${checks} checks, ${failures} failed; source ${src}; home ${home}`)
process.exit(failures ? 1 : 0)

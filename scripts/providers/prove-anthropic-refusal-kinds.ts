#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'refusal-kinds-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MOCK_LIMITS = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const refusal = await import('../../src/services/providers/anthropicRefusal.ts')
const limits = await import('../../src/services/claudeAiLimits.ts')
const mock = await import('../../src/services/mockRateLimits.ts')
const usability = await import('../../src/services/providers/providerUsability.ts')
const wall = await import('../../src/services/providers/credentialWall.ts')
const auth = await import('../../src/utils/auth.ts')
const { APIError } = await import('@anthropic-ai/sdk')
const { getAssistantMessageFromError } = await import('../../src/services/api/errors.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(true)
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads

const classify = refusal.classifyAnthropicRefusal
const REVOKED_401 = '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked"}}'
const SIGN_IN_LINE = wall.credentialWallLine('anthropic', 'sign-in')
const OWNER_A = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000aa'
const ACCOUNT_A = 'ana@example.com'

const mk = (status: number, type: string, message: string, headers?: Headers): InstanceType<typeof APIError> =>
  new APIError(status, { type: 'error', error: { type, message } }, undefined, headers as never)
const textOf = (m: { message: { content: unknown } }): string => {
  const content = m.message.content as Array<{ type?: string; text?: string }>
  return content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
}
const mockHeaders = (): Headers => {
  const h = new Headers()
  for (const [k, v] of Object.entries(mock.getMockHeaders() ?? {})) if (v !== undefined) h.set(k, v)
  return h
}

const credsPath = join(HOME, '.credentials.json')
const seed = (oauth: Record<string, unknown> | null): void => {
  auth.__resetKnownDeadRefreshTokensForTest()
  auth.clearOAuthTokenCache()
  writeFileSync(credsPath, JSON.stringify(oauth === null ? {} : { claudeAiOauth: oauth }))
  auth.clearOAuthTokenCache()
}
const DEAD_SIGN_IN = { accessToken: 'at-dead', refreshToken: '', expiresAt: Date.now() - 60_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null }

const reads = (over: Partial<Reads> = {}): Reads => ({
  anthropicApiKey: () => null,
  anthropicSubscriber: () => true,
  anthropicBearerToken: () => false,
  ...usability.anthropicLimitReads(),
  gptSeat: () => ({ state: 'ready' }),
  zaiKeyPresent: () => false,
  moonshotAccount: () => undefined,
  deepseekKeyPresent: () => false,
  compatConfigured: () => false,
  huggingfaceAccount: () => undefined,
  localServerPresent: () => false,
  openrouterKeyPresent: () => false,
  geminiAccount: () => undefined,
  ...over,
})
const blockerOver = (over: Partial<Reads> = {}): string | null =>
  usability.delegationDispatchBlocker('anthropic', usability.resolveProviderUsability(reads(over)))

section('§1 one classification, three answers')
{
  check('a 401 whose wire says the token is revoked is an expired sign-in', classify({ status: 401, wireText: REVOKED_401 }) === 'sign-in')
  check('a 403 with the older revoked spelling is an expired sign-in', classify({ status: 403, wireText: 'OAuth token has been revoked' }) === 'sign-in')
  check('a 401 on a sign-in the estate has observed dead is an expired sign-in', classify({ status: 401, wireText: 'OAuth token expired', signInExpired: true }) === 'sign-in')
  check('an invalid_grant (the refresh road) is an expired sign-in, whatever its status', classify({ status: 400, oauthErrorType: 'invalid_grant' }) === 'sign-in' && classify({ status: 401, wireText: '{"error":"invalid_grant"}' }) === 'sign-in')
  check('a 429 with the window headers is the used-up window', classify({ status: 429, wireText: 'Rate limit exceeded' }) === 'window')
  check('a 429 without them is the window too (the latch has always read every 429 so)', classify({ status: 429 }) === 'window')
  check("a bare 401 with nothing observed is something else (the notice keeps the wire's own words)", classify({ status: 401, wireText: 'OAuth token expired' }) === 'other')
  check('a 500 is something else', classify({ status: 500, wireText: 'server error' }) === 'other')
  check('a 401 is never the window, whatever it carries', classify({ status: 401, wireText: 'Rate limit exceeded', signInExpired: true }) !== 'window')
  check('no status, no words: something else', classify({}) === 'other')
  const facts = refusal.anthropicRefusalFactsOf(mk(401, 'authentication_error', 'OAuth access token has been revoked'), true)
  check('the facts of an error carry its status, its words and the observed sign-in', facts.status === 401 && facts.wireText === REVOKED_401 && facts.signInExpired === true, JSON.stringify(facts))
  check("the facts of the refresh road's error carry its grant word", refusal.anthropicRefusalFactsOf({ status: 400, oauthErrorType: 'invalid_grant', message: 'refresh failed' }).oauthErrorType === 'invalid_grant')
}

section('§2 the words: each answer speaks its own line and remedy')
{
  const signIn = refusal.anthropicSignInWords()
  check("the sign-in answer speaks the estate's one sign-in line", signIn === SIGN_IN_LINE, signIn)
  check('…whose remedy is to sign in again through /logins', signIn.includes('/logins anthropic') && signIn.includes('sign-in expired'))
  check('…and never the window words', !signIn.includes('usage window'))
  check('the headless sign-in spelling names the flag', refusal.anthropicSignInWords({ nonInteractive: true }).includes('--model'))
  const window = refusal.anthropicWindowWords({ account: ACCOUNT_A, observedAtMs: Date.now(), resetsAtMs: Date.now() + 3_600_000 })
  check('the window answer names the account, the moment and the reset', window.includes(`usage window is reached for ${ACCOUNT_A}`) && / seen at \d\d:\d\d/.test(window) && /resets at /.test(window), window)
  check('…and never the sign-in words', !window.includes('sign-in'))
}

section('§3 the latch: a 401 and an invalid_grant never set it; a 429 with the window headers does')
{
  limits.resetLimitsForCredentialSwitch()
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  mock.setMockRateLimitScenario('normal')
  limits.extractQuotaStatusFromError(mk(401, 'authentication_error', 'OAuth token expired'))
  const after401 = limits.anthropicLimitVerdict()
  check('a 401 leaves the window unobserved', limits.claudeWindowObserved() === false && after401.status === 'allowed' && after401.observedAtMs === undefined, JSON.stringify(after401))
  check('…and nothing refuses', blockerOver() === null, String(blockerOver()))
  limits.extractQuotaStatusFromError(mk(401, 'authentication_error', 'OAuth access token has been revoked'))
  check('a revoked-token 401 leaves it unobserved too', limits.claudeWindowObserved() === false)
  limits.extractQuotaStatusFromError({ status: 400, oauthErrorType: 'invalid_grant', message: 'refresh failed: invalid_grant' })
  check('an invalid_grant leaves it unobserved', limits.claudeWindowObserved() === false && blockerOver() === null)
  mock.setMockRateLimitScenario('weekly-limit-reached')
  limits.extractQuotaStatusFromError(mk(429, 'rate_limit_error', 'Rate limit exceeded', new Headers()))
  const after429 = limits.anthropicLimitVerdict()
  check('a 429 with the window headers sets the latch, with its reset', after429.status === 'rejected' && typeof after429.resetsAtMs === 'number', JSON.stringify(after429))
  const words = blockerOver()
  check("…and the refusal is the window's: account, moment, reset — never the sign-in line", words !== null && words.includes(`usage window is reached for ${ACCOUNT_A}`) && /resets at /.test(words) && !words.includes('sign-in'), String(words))
}

section('§4 the delegation refusal: an observed-expired sign-in is refused as a sign-in, never as a window')
{
  limits.resetLimitsForCredentialSwitch()
  const expiredMap = usability.resolveProviderUsability(reads({ anthropicSignInExpired: () => true }))
  const refused = usability.delegationDispatchBlocker('anthropic', expiredMap)
  check('the dispatch is refused', refused !== null)
  check('…with the sign-in line and its remedy', refused !== null && refused.includes(SIGN_IN_LINE) && refused.includes('/logins anthropic'), String(refused))
  check('…and never the window words', refused !== null && !refused.includes('usage window'))
  check("the lane keeps its shape (usable, no blocker row); the refusal is the dispatch gate's own", expiredMap.anthropic.usable === true && expiredMap.anthropic.blockers.length === 0 && expiredMap.anthropic.signInExpired === true, JSON.stringify(expiredMap.anthropic))
  console.log(`      refusal: ${refused}`)
  mock.setMockRateLimitScenario('weekly-limit-reached')
  limits.extractQuotaStatusFromHeaders(new Headers())
  const both = blockerOver({ anthropicSignInExpired: () => true })
  check('with a reached window AND an expired sign-in standing, the refusal names the sign-in', both !== null && both.includes('sign-in expired') && !both.includes('usage window'), String(both))
  const windowOnly = blockerOver({ anthropicSignInExpired: () => false })
  check('with the sign-in alive the same window refuses as a window', windowOnly !== null && windowOnly.includes('usage window is reached') && !windowOnly.includes('sign-in'), String(windowOnly))
  limits.resetLimitsForCredentialSwitch()
  check('nothing standing, nothing refused', blockerOver({ anthropicSignInExpired: () => false }) === null)
  const alone = blockerOver({ anthropicSignInExpired: () => true, gptSeat: () => ({ state: 'disabled', reason: 'no OpenAI account', why: 'no-account' }) })
  check('with no other lane the tail says to sign in again, not to wait for a window', alone !== null && alone.includes('sign in again') && !alone.includes('wait for the window'), String(alone))
  check('an unrecognised sign-in read (older fixtures) refuses nothing', blockerOver() === null)
}

section("§5 the live road: the dispatch gate reads the estate's observed sign-in")
{
  seed(DEAD_SIGN_IN)
  check('the estate observes the sign-in dead', auth.isAnthropicOAuthSignInExpired() === true)
  check('the wall owner derives the sign-in wall', wall.observedCredentialWall('anthropic') === 'sign-in')
  const standing = refusal.standingAnthropicRefusal()
  check('the standing refusal is the sign-in, with its line', standing?.kind === 'sign-in' && standing.words === SIGN_IN_LINE, JSON.stringify(standing))
  let live: string | null = null
  let threw = ''
  try {
    live = usability.delegationDispatchBlocker('anthropic')
  } catch (e) {
    threw = String(e)
  }
  check('the live dispatch gate refuses with the sign-in line', threw === '' && live !== null && live.includes(SIGN_IN_LINE), threw || String(live))
  seed({ ...DEAD_SIGN_IN, refreshToken: 'rt-alive' })
  check('a refreshable sign-in is no refusal (the recovery lap owns it)', wall.observedCredentialWall('anthropic') === undefined && refusal.standingAnthropicRefusal() === null)
  seed(null)
  check('no sign-in at all is no refusal here', refusal.standingAnthropicRefusal() === null)
}

section("§6 the chat's notice: a 401 on a dead sign-in speaks the sign-in line; a spent window speaks the window; neither borrows the other's words")
{
  limits.resetLimitsForCredentialSwitch()
  const expired401 = mk(401, 'authentication_error', 'OAuth token expired')
  seed(DEAD_SIGN_IN)
  const deadRow = getAssistantMessageFromError(expired401, 'claude-opus-5')
  const deadText = textOf(deadRow as never)
  check('the observed-dead 401 paints the sign-in line', deadText.includes(SIGN_IN_LINE), deadText)
  check('…never the window words', !/usage window|limit is reached|resets/.test(deadText), deadText)
  check('…typed authentication_failed', (deadRow as { error?: string }).error === 'authentication_failed')
  seed(null)
  const plain = textOf(getAssistantMessageFromError(expired401, 'claude-opus-5') as never)
  check("a bare 401 keeps the generic notice with the wire's own words (no false sign-in expired, no window)", !plain.includes('sign-in expired') && !plain.includes('usage window') && plain.includes('/logins') && plain.includes('OAuth token expired'), plain)
  mock.setMockRateLimitScenario('weekly-limit-reached')
  const spentRow = getAssistantMessageFromError(mk(429, 'rate_limit_error', 'Rate limit exceeded', mockHeaders()), 'claude-opus-5')
  const spentText = textOf(spentRow as never)
  check('the spent window paints the window notice with its reset', /limit is reached/.test(spentText) && /resets/.test(spentText), spentText)
  check('…never the sign-in words', !spentText.includes('sign-in'), spentText)
  check('…typed rate_limit', (spentRow as { error?: string }).error === 'rate_limit')
  check('the spent window never set the sign-in wall', wall.observedCredentialWall('anthropic') === undefined)
}

section('§7 the roads read the one classification')
{
  const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const limitsSrc = src('src/services/claudeAiLimits.ts')
  check("the latch's error road gates on the classification, not on a status of its own", limitsSrc.includes("classifyAnthropicRefusal(anthropicRefusalFactsOf(error)) !== 'window'") && !limitsSrc.includes('if (status !== 429) return'))
  const errorsSrc = src('src/services/api/errors.ts')
  check("the notice's window arm reads the classification", errorsSrc.includes("classifyAnthropicRefusal({ status, wireText: message }) === 'window'"))
  check("the notice's sign-in arm reads it with the estate's observed fact", errorsSrc.includes("signInExpired: isAnthropicOAuthSignInExpired() }) === 'sign-in'"))
  const usabilitySrc = src('src/services/providers/providerUsability.ts')
  check('the dispatch gate reads the observed sign-in through the wall owner', usabilitySrc.includes("observedCredentialWall('anthropic') === 'sign-in'") && usabilitySrc.includes('anthropicSignInWords('))
  const doctorSrc = src('src/utils/healthReport.ts')
  check("the doctor's auth row speaks the sign-in answer's line", doctorSrc.includes('anthropicSignInWords()'))
  check("the doctor's usage row carries the standing window verdict", doctorSrc.includes('standingAnthropicRefusal()'))
}

limits.__setAnthropicOwnerResolverForTest(null)
limits.resetLimitsForCredentialSwitch()
mock.setMockRateLimitScenario('clear')
delete process.env.MERCURY_MOCK_LIMITS

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'verdict-owner-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MOCK_LIMITS = '1'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
const verdictOwnerFixHint =
  'fix in src/models/roads/anthropic/anthropicLimits.ts (anthropicLimitVerdict, anthropicWindowObserved, resetLimitsForCredentialSwitch, extractQuotaStatusFromError) for the verdict and its account stamp, or in src/models/roads/providerUsability.ts (resolveProviderUsability, delegationDispatchBlocker) for the lane and refusal text'
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} | ` : ''}${verdictOwnerFixHint}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const limits = await import('../../src/models/roads/anthropic/anthropicLimits.ts')
const mock = await import('../../src/models/roads/anthropic/mockRateLimits.ts')
const usability = await import('../../src/models/roads/providerUsability.ts')
type Reads = import('../../src/models/roads/providerUsability.ts').ProviderUsabilityReads

const OWNER_A = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000aa'
const OWNER_B = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000bb'
const ACCOUNT_A = 'ana@example.com'
const ACCOUNT_B = 'bea@example.com'

const reads = (): Reads => ({
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
})
const blocker = (): string | null => usability.delegationDispatchBlocker('anthropic', usability.resolveProviderUsability(reads()))
const lane = () => usability.resolveProviderUsability(reads()).anthropic
const observeRejected = (): void => {
  mock.setMockRateLimitScenario('weekly-limit-reached')
  limits.extractQuotaStatusFromHeaders(new Headers())
}

section('§1 a rejected verdict observed under account A refuses delegated work, naming the account and the moment')
{
  limits.resetLimitsForCredentialSwitch()
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  observeRejected()
  const verdict = limits.anthropicLimitVerdict()
  check('the wire verdict reads rejected under the account that observed it', verdict.status === 'rejected', JSON.stringify(verdict))
  check('the verdict carries the moment it was observed', typeof verdict.observedAtMs === 'number' && Date.now() - (verdict.observedAtMs ?? 0) < 60_000, JSON.stringify(verdict))
  check('the verdict names the account that observed it', verdict.account === ACCOUNT_A, JSON.stringify(verdict))
  check('the window counts as observed', limits.anthropicWindowObserved() === true)
  const capped = lane()
  check('the lane reads rejected without capping delegation', capped.limit === 'rejected' && capped.delegationCapped === false && capped.usable, JSON.stringify(capped))
  const refusal = lane().limitBlocker ?? null
  check('the reading remains while dispatch proceeds', blocker() === null && refusal !== null && refusal.includes('usage window is reached'), String(refusal))
  check('the refusal names the account the verdict belongs to', refusal !== null && refusal.includes(ACCOUNT_A), String(refusal))
  check('the refusal names when the window was observed', refusal !== null && /seen at \d\d:\d\d/.test(refusal), String(refusal))
  check('the refusal names the reset it knows', refusal !== null && /resets at (?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?\d\d:\d\d/.test(refusal), String(refusal))
  console.log(`      refusal: ${refusal}`)
}

section('§2 the active wallet entry is B: the verdict reads unknown and nothing refuses')
{
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_B, () => ACCOUNT_B)
  const verdict = limits.anthropicLimitVerdict()
  check("a departed account's verdict reads unknown", verdict.status === 'unknown', JSON.stringify(verdict))
  check('…with no moment and no account riding it', verdict.observedAtMs === undefined && verdict.account === undefined, JSON.stringify(verdict))
  check('the window no longer counts as observed', limits.anthropicWindowObserved() === false)
  check('the latched record itself is kept, never destroyed', limits.currentLimits.status === 'rejected')
  const open = lane()
  check('the lane reads unknown, usable, delegation not capped', open.limit === 'unknown' && open.delegationCapped === false && open.usable && open.blockers.length === 0, JSON.stringify(open))
  check('no refusal rides a verdict from a departed account', blocker() === null, String(blocker()))
}

section('§3 the observing account returns: the same verdict still refuses')
{
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  const refusal = lane().limitBlocker ?? null
  check('the same verdict under the same account refuses again', refusal !== null && refusal.includes('usage window is reached') && refusal.includes(ACCOUNT_A), String(refusal))
  check('the window counts as observed again', limits.anthropicWindowObserved() === true)
}

section('§4 a headerless plan-window 429 stamps the observing account too')
{
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario('normal')
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  limits.extractQuotaStatusFromError({ status: 429, message: 'usage_limit_reached' })
  const verdict = limits.anthropicLimitVerdict()
  check('the 429 reads rejected with its moment and account', verdict.status === 'rejected' && typeof verdict.observedAtMs === 'number' && verdict.account === ACCOUNT_A, JSON.stringify(verdict))
  check('a delegated dispatch proceeds under A despite its note', blocker() === null && lane().limit === 'rejected')
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_B, () => ACCOUNT_B)
  check('…and reads unknown under B', limits.anthropicLimitVerdict().status === 'unknown' && blocker() === null)
}

section('§5 the credential-switch reset clears the verdict and its stamp; the next observation stamps the new account')
{
  limits.resetLimitsForCredentialSwitch()
  const cleared = limits.anthropicLimitVerdict()
  check('after the reset the verdict is the settled default with no observation', cleared.status === 'allowed' && cleared.observedAtMs === undefined && cleared.account === undefined, JSON.stringify(cleared))
  check('nothing is observed', limits.anthropicWindowObserved() === false)
  check('no refusal under either account', blocker() === null)
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_B, () => ACCOUNT_B)
  observeRejected()
  const fresh = limits.anthropicLimitVerdict()
  check("the new account's own observation stamps the new account", fresh.status === 'rejected' && fresh.account === ACCOUNT_B, JSON.stringify(fresh))
  const refusal = lane().limitBlocker ?? null
  check('…and its refusal names the new account', refusal !== null && refusal.includes(ACCOUNT_B) && !refusal.includes(ACCOUNT_A), String(refusal))
}


limits.__setAnthropicOwnerResolverForTest(null)
limits.resetLimitsForCredentialSwitch()
mock.setMockRateLimitScenario('clear')
delete process.env.MERCURY_MOCK_LIMITS

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

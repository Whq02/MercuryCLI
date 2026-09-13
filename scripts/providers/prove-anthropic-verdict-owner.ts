#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'verdict-owner-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MOCK_LIMITS = '1'
delete process.env.MERCURY_HOME

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
const limits = await import('../../src/services/claudeAiLimits.ts')
const mock = await import('../../src/services/mockRateLimits.ts')
const usability = await import('../../src/services/providers/providerUsability.ts')
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads

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
  check('the window counts as observed', limits.claudeWindowObserved() === true)
  const capped = lane()
  check('the lane reads rejected and caps delegation', capped.limit === 'rejected' && capped.delegationCapped === true && !capped.usable, JSON.stringify(capped))
  const refusal = blocker()
  check('a delegated dispatch is refused', refusal !== null && refusal.includes('usage window is reached'), String(refusal))
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
  check('the window no longer counts as observed', limits.claudeWindowObserved() === false)
  check('the latched record itself is kept, never destroyed', limits.currentLimits.status === 'rejected')
  const open = lane()
  check('the lane reads unknown, usable, delegation not capped', open.limit === 'unknown' && open.delegationCapped === false && open.usable && open.blockers.length === 0, JSON.stringify(open))
  check('no refusal rides a verdict from a departed account', blocker() === null, String(blocker()))
}

section('§3 the observing account returns: the same verdict still refuses')
{
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  const refusal = blocker()
  check('the same verdict under the same account refuses again', refusal !== null && refusal.includes('usage window is reached') && refusal.includes(ACCOUNT_A), String(refusal))
  check('the window counts as observed again', limits.claudeWindowObserved() === true)
}

section('§4 a headerless 429 stamps the observing account too')
{
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario('normal')
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  limits.extractQuotaStatusFromError({ status: 429 })
  const verdict = limits.anthropicLimitVerdict()
  check('the 429 reads rejected with its moment and account', verdict.status === 'rejected' && typeof verdict.observedAtMs === 'number' && verdict.account === ACCOUNT_A, JSON.stringify(verdict))
  check('a delegated dispatch is refused under A', blocker() !== null)
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_B, () => ACCOUNT_B)
  check('…and reads unknown under B', limits.anthropicLimitVerdict().status === 'unknown' && blocker() === null)
}

section('§5 the credential-switch reset clears the verdict and its stamp; the next observation stamps the new account')
{
  limits.resetLimitsForCredentialSwitch()
  const cleared = limits.anthropicLimitVerdict()
  check('after the reset the verdict is the settled default with no observation', cleared.status === 'allowed' && cleared.observedAtMs === undefined && cleared.account === undefined, JSON.stringify(cleared))
  check('nothing is observed', limits.claudeWindowObserved() === false)
  check('no refusal under either account', blocker() === null)
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_B, () => ACCOUNT_B)
  observeRejected()
  const fresh = limits.anthropicLimitVerdict()
  check("the new account's own observation stamps the new account", fresh.status === 'rejected' && fresh.account === ACCOUNT_B, JSON.stringify(fresh))
  const refusal = blocker()
  check('…and its refusal names the new account', refusal !== null && refusal.includes(ACCOUNT_B) && !refusal.includes(ACCOUNT_A), String(refusal))
}

section('§6 the road: the sign-in reaches the runners, and the live reads ride the guarded verdict')
{
  const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const print = src('src/cli/print.ts')
  const runnerCase = print.indexOf("case 'credential_change'")
  const runnerArm = runnerCase === -1 ? '' : print.slice(runnerCase, runnerCase + 900)
  check("the runner's control loop takes a credential_change request", runnerCase !== -1)
  check('…and resets the limit verdict and drops its credential memos there', runnerArm.includes('resetLimitsForCredentialSwitch()') && runnerArm.includes('dropCredentialMemos()'))
  const types = src('src/entrypoints/sdk/controlTypes.ts')
  check('the control wire declares the credential_change request', types.includes("subtype: 'credential_change'"))
  const seat = src('src/daemon/sessionSeat.ts')
  check('the daemon relays a credential change to every long-lived runner it hosts', seat.includes('export function relayCredentialChange') && seat.includes("subtype: 'credential_change'") && seat.includes("kind !== 'long-lived'"))
  const main = src('src/daemon/main.ts')
  check("the daemon relays on the client's refreshed sign-in view (the poke every sign-in and sign-out raises)", main.includes('relayCredentialChange(') && main.includes('refresh === true'))
  const usabilitySrc = src('src/services/providers/providerUsability.ts')
  check('the live usability reads take the guarded verdict, never the raw latch', usabilitySrc.includes('anthropicLimitVerdict(clock())') && !usabilitySrc.includes('currentLimits.status'))
  const limitsSrc = src('src/services/claudeAiLimits.ts')
  check('both wire paths stamp the verdict owner', (limitsSrc.match(/stampVerdictOwner\(\)/g) ?? []).length >= 2)
  check('the reset roads clear the stamp', (limitsSrc.match(/verdictOwner = null/g) ?? []).length >= 2)
}

limits.__setAnthropicOwnerResolverForTest(null)
limits.resetLimitsForCredentialSwitch()
mock.setMockRateLimitScenario('clear')
delete process.env.MERCURY_MOCK_LIMITS

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

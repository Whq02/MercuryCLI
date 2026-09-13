#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'verdict-lifetime-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MOCK_LIMITS = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
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
const failover = await import('../../src/services/capFailover.ts')
const { formatClock } = await import('../../src/utils/cockpit/quota.ts')
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads

const OWNER_A = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000aa'
const ACCOUNT_A = 'ana@example.com'
const SEED_SPAN_MS = 2_820_000
const CLOCK_WORDS = /(?:resets at|refused until) (?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?\d\d:\d\d/

const reads = (clock?: () => number): Reads => ({
  anthropicApiKey: () => null,
  anthropicSubscriber: () => true,
  anthropicBearerToken: () => false,
  ...(usability.anthropicLimitReads as (clock?: () => number) => Pick<Reads, 'anthropicLimitStatus' | 'anthropicLimitObservation'>)(clock),
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
const lane = (clock?: () => number) => usability.resolveProviderUsability(reads(clock)).anthropic
const blocker = (clock?: () => number): string | null =>
  usability.delegationDispatchBlocker('anthropic', usability.resolveProviderUsability(reads(clock)))
const ingest = (): void => limits.extractQuotaStatusFromHeaders(new Headers())
const verdictAt = (nowMs: number) => (limits.anthropicLimitVerdict as (nowMs?: number) => ReturnType<typeof limits.anthropicLimitVerdict>)(nowMs)

section('§1 a rejected verdict whose stated reset has passed reads unknown, and nothing refuses')
{
  limits.resetLimitsForCredentialSwitch()
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  mock.setMockRateLimitScenario('weekly-limit-reached')
  mock.setMockHeader('reset', '-1')
  ingest()
  check('the record itself latched rejected', limits.currentLimits.status === 'rejected')
  check('…with a stated reset in the past', typeof limits.currentLimits.resetsAt === 'number' && limits.currentLimits.resetsAt * 1000 < Date.now(), String(limits.currentLimits.resetsAt))
  const verdict = limits.anthropicLimitVerdict()
  check('the verdict reads unknown once the reset it names has passed', verdict.status === 'unknown', JSON.stringify(verdict))
  check('…carrying no account, moment or reset', verdict.observedAtMs === undefined && verdict.account === undefined && (verdict as { resetsAtMs?: number }).resetsAtMs === undefined, JSON.stringify(verdict))
  const open = lane()
  check('the lane reads unknown, usable, delegation not capped', open.limit === 'unknown' && open.delegationCapped === false && open.usable && open.blockers.length === 0, JSON.stringify(open))
  check('a delegated dispatch is not refused', blocker() === null, String(blocker()))
  check('the record is kept, never destroyed', limits.currentLimits.status === 'rejected')
  check('the meters keep their own rule: the window still counts as observed', limits.claudeWindowObserved() === true)
  const home = failover.observedFamilyWindow('anthropic')
  check("the cap-return law still reads the passed reset as allowed (basis 'stated-reset-elapsed')", home.state === 'allowed' && home.basis === 'stated-reset-elapsed', JSON.stringify(home))
}

section('§2 a stated reset ahead still refuses, and the refusal names the clock it knows')
{
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario('weekly-limit-reached')
  ingest()
  const resetsAtMs = (limits.currentLimits.resetsAt ?? 0) * 1000
  const verdict = limits.anthropicLimitVerdict() as ReturnType<typeof limits.anthropicLimitVerdict> & { resetsAtMs?: number; lapsesAtMs?: number }
  check('the verdict reads rejected with the stated reset ahead', verdict.status === 'rejected' && resetsAtMs > Date.now() && verdict.resetsAtMs === resetsAtMs, JSON.stringify(verdict))
  check('the verdict lapses at that reset', verdict.lapsesAtMs === resetsAtMs, JSON.stringify(verdict))
  check('the verdict still names the account and the moment', verdict.account === ACCOUNT_A && typeof verdict.observedAtMs === 'number')
  const refusal = blocker()
  check('a delegated dispatch is refused for the account that observed the window', refusal !== null && refusal.includes(`usage window is reached for ${ACCOUNT_A}`), String(refusal))
  check('the refusal names the reset it knows', refusal !== null && CLOCK_WORDS.test(refusal), String(refusal))
  check('the reset named is the stated one', refusal !== null && refusal.includes(`resets at ${formatClock(resetsAtMs)}`), String(refusal))
  check('…and no longer points at /usage for it', refusal !== null && !refusal.includes('resets per /usage'), String(refusal))
  console.log(`      refusal: ${refusal}`)
  check('one tick before the reset the verdict still reads rejected', verdictAt(resetsAtMs - 1).status === 'rejected')
  check('at the reset the verdict reads unknown', verdictAt(resetsAtMs).status === 'unknown', JSON.stringify(verdictAt(resetsAtMs)))
  const after = (): number => resetsAtMs + 1
  check('the lane read through a clock past the reset refuses nothing', blocker(after) === null && lane(after).limit === 'unknown' && lane(after).delegationCapped === false, String(blocker(after)))
  check('the lane read through a clock before it still refuses', blocker(() => resetsAtMs - 1) !== null)
}

section('§3 a successful response clears a standing rejected at once')
{
  check('a rejected verdict stands going in', limits.anthropicLimitVerdict().status === 'rejected')
  mock.setMockRateLimitScenario('normal')
  ingest()
  const verdict = limits.anthropicLimitVerdict()
  check('the next reply that says allowed clears the verdict', verdict.status === 'allowed' && limits.currentLimits.status === 'allowed', JSON.stringify(verdict))
  check('no refusal stands', blocker() === null, String(blocker()))
}

section('§4 a headerless 429 names no reset: the verdict lives the seed span, and the refusal says so')
{
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario('normal')
  limits.extractQuotaStatusFromError({ status: 429 })
  const verdict = limits.anthropicLimitVerdict() as ReturnType<typeof limits.anthropicLimitVerdict> & { resetsAtMs?: number; lapsesAtMs?: number }
  check('rejected, observed, no stated reset', verdict.status === 'rejected' && typeof verdict.observedAtMs === 'number' && verdict.resetsAtMs === undefined, JSON.stringify(verdict))
  check('the verdict lapses one seed span after the observation', verdict.lapsesAtMs === (verdict.observedAtMs ?? 0) + SEED_SPAN_MS, JSON.stringify(verdict))
  const refusal = blocker()
  check('the refusal says no reset time was given and names when the refusal ends', refusal !== null && refusal.includes('no reset time was given') && CLOCK_WORDS.test(refusal), String(refusal))
  console.log(`      refusal: ${refusal}`)
  const lapse = verdict.lapsesAtMs ?? 0
  check('past the seed span the verdict reads unknown and nothing refuses', verdictAt(lapse).status === 'unknown' && blocker(() => lapse) === null, String(blocker(() => lapse)))
  check('inside it the refusal stands', verdictAt(lapse - 1).status === 'rejected' && blocker(() => lapse - 1) !== null)
}

section('§5 a departed account still reads unknown ahead of any lifetime')
{
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario('weekly-limit-reached')
  ingest()
  check('rejected under A', limits.anthropicLimitVerdict().status === 'rejected')
  limits.__setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000bb', () => 'bea@example.com')
  check("B reads A's verdict as unknown", limits.anthropicLimitVerdict().status === 'unknown' && blocker() === null)
  limits.__setAnthropicOwnerResolverForTest(() => OWNER_A, () => ACCOUNT_A)
  check('A returns and the same verdict refuses again', blocker() !== null)
}

section('§6 the roads: the verdict owns its lifetime; the meters and the cap return keep theirs')
{
  const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const limitsSrc = src('src/services/claudeAiLimits.ts')
  check('the verdict takes the clock it is read at', /export function anthropicLimitVerdict\(nowMs: number = Date\.now\(\)\)/.test(limitsSrc))
  check('…and lapses at the stated reset or the seed span', limitsSrc.includes('SEED_DEFAULT_TTL_SECONDS * 1000') && limitsSrc.includes('lapsesAtMs'))
  check("claudeWindowObserved keeps the meters' rule (no lifetime of its own)", limitsSrc.includes('return windowObserved && verdictOwnerStands()'))
  const usabilitySrc = src('src/services/providers/providerUsability.ts')
  check('the live reads take the clock through to the verdict', usabilitySrc.includes('anthropicLimitVerdict(clock())'))
  check('the Anthropic blocker speaks the window words from the refusal owner', usabilitySrc.includes('anthropicWindowWords('))
  check('no Anthropic refusal points at /usage for its reset', !usabilitySrc.includes("'the Anthropic usage window is reached — resets per /usage'"))
}

limits.__setAnthropicOwnerResolverForTest(null)
limits.resetLimitsForCredentialSwitch()
mock.setMockRateLimitScenario('clear')
delete process.env.MERCURY_MOCK_LIMITS

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

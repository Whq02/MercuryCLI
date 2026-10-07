#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'extra-usage-open-home-'))
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
const limits = await import('../../src/services/anthropicLimits.ts')
const mock = await import('../../src/services/mockRateLimits.ts')
const usability = await import('../../src/services/providers/providerUsability.ts')
const refusal = await import('../../src/services/providers/anthropicRefusal.ts')
const messages = await import('../../src/services/rateLimitMessages.ts')
const warning = await import('../../src/services/providers/limitWarning.ts')
const failover = await import('../../src/services/capFailover.ts')
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads
type Limits = import('../../src/services/anthropicLimits.ts').AnthropicLimits

const OWNER = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000ee'
const ACCOUNT = 'eve@example.com'
const MODEL = 'claude-opus-5-5'

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
const lane = () => usability.resolveProviderUsability(reads()).anthropic
const blocker = (): string | null => usability.delegationDispatchBlocker('anthropic', usability.resolveProviderUsability(reads()))
const closed =(record: Limits): boolean | undefined =>
  typeof (limits as { anthropicWindowClosed?: unknown }).anthropicWindowClosed === 'function'
    ? (limits as unknown as { anthropicWindowClosed: (l: Limits) => boolean }).anthropicWindowClosed(record)
    : undefined
const laneStatus = (record: Limits): string | undefined =>
  typeof (limits as { laneQuotaStatus?: unknown }).laneQuotaStatus === 'function'
    ? (limits as unknown as { laneQuotaStatus: (l: Limits) => string }).laneQuotaStatus(record)
    : undefined

console.log('============================================================')
console.log(' extra usage keeps the Anthropic lane open: a rejected pool the overage carries walls nothing')
console.log('============================================================')

section('§1 the wire says rejected AND overage allowed (the account runs on usage credits)')
{
  limits.resetLimitsForCredentialSwitch()
  limits.__setAnthropicOwnerResolverForTest(() => OWNER, () => ACCOUNT)
  mock.setMockRateLimitScenario('overage-active')
  limits.extractQuotaStatusFromHeaders(new Headers())
  const record = limits.currentLimits
  check("the record keeps the wire's words: status rejected, extra usage in use", record.status === 'rejected' && record.isUsingOverage === true, JSON.stringify(record))
  check('the window is NOT closed (anthropicWindowClosed reads false)', closed(record) === false, String(closed(record)))
  check("the lane-level status reads 'allowed' (laneQuotaStatus)", laneStatus(record) === 'allowed', String(laneStatus(record)))
  const verdict = limits.anthropicLimitVerdict()
  check("the verdict reads 'allowed' with the moment and the account kept", verdict.status === 'allowed' && typeof verdict.observedAtMs === 'number' && verdict.account === ACCOUNT, JSON.stringify(verdict))
  const resolved = lane()
  check('the lane resolves usable, its limit axis allowed, delegation NOT capped', resolved.usable === true && resolved.limit === 'allowed' && resolved.delegationCapped === false && resolved.blockers.length === 0, JSON.stringify(resolved))
  check('the dispatch gate lets a Claude agent launch (no refusal line)', blocker() === null, String(blocker()))
  check('no standing refusal stands for the lane', refusal.standingAnthropicRefusal() === null, JSON.stringify(refusal.standingAnthropicRefusal()))
  const fact = limits.anthropicWindowFact()
  check("the relayed fact keeps status rejected and says the traffic rides extra usage (onExtraUsage: true)", fact !== undefined && fact.status === 'rejected' && (fact as { onExtraUsage?: boolean }).onExtraUsage === true, JSON.stringify(fact))
  check('the schedule/hop hold reads no closed window from that fact', limits.anthropicWindowClosedUntil(fact, Date.now()) === undefined, String(limits.anthropicWindowClosedUntil(fact, Date.now())))
  const family = failover.observedFamilyWindow('anthropic', undefined, { model: MODEL })
  check("the cap-failover family window does not read 'rejected' (no cross-family offer card)", family.state !== 'rejected', JSON.stringify(family))
  check('no error line is minted for the state (extra usage is not a wall)', messages.getRateLimitErrorMessage(record, MODEL) === null, String(messages.getRateLimitErrorMessage(record, MODEL)))
  check('no usage-limit warning line nags while extra usage carries the traffic', warning.providerLimitWarning({ model: MODEL, reads: { anthropicLimits: () => record } }) === null, JSON.stringify(warning.providerLimitWarning({ model: MODEL, reads: { anthropicLimits: () => record } })))
}

section('§2 the screen side adopts the relayed fact and reads the same open window')
{
  const fact = limits.anthropicWindowFact()!
  limits.resetLimitsForCredentialSwitch()
  const adopted = limits.adoptAnthropicWindowFact({ ...fact, observedAtMs: fact.observedAtMs + 1 })
  const record = limits.currentLimits
  check('the fact is adopted', adopted === true)
  check('the adopted record carries extra usage (isUsingOverage true, overage allowed), status rejected as the wire said', record.status === 'rejected' && record.isUsingOverage === true && record.overageStatus === 'allowed', JSON.stringify(record))
  check('the adopted record is not a closed window', closed(record) === false, String(closed(record)))
  check("the composer's slot-offer wall reads through anthropicWindowClosed (source)", readFileSync(join(ROOT, 'src/components/PromptInput/useComposerModelDoors.tsx'), 'utf8').includes('anthropicWindowClosed(limits)'))
  check("the slot-switch seat view's wall reads through anthropicWindowClosed (source)", readFileSync(join(ROOT, 'src/services/providers/slotSwitch.ts'), 'utf8').includes('anthropicWindowClosed(currentLimits)'))
  check("the cap-failover family read takes the lane-level status (source)", readFileSync(join(ROOT, 'src/services/capFailover.ts'), 'utf8').includes('laneQuotaStatus(current)'))
}

section('§3 a rejected status with NO overage keeps every tooth (the real wall)')
{
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario('weekly-limit-reached')
  limits.extractQuotaStatusFromHeaders(new Headers())
  const record = limits.currentLimits
  check('the record reads rejected, no extra usage', record.status === 'rejected' && record.isUsingOverage === false, JSON.stringify(record))
  check('the window IS closed', closed(record) === true && laneStatus(record) === 'rejected')
  check("the verdict reads 'rejected'", limits.anthropicLimitVerdict().status === 'rejected')
  const resolved = lane()
  check('the lane stays usable with the reading and no delegation cap', resolved.usable === true && resolved.delegationCapped === false && resolved.limit === 'rejected', JSON.stringify(resolved))
  const line = blocker()
  check('the dispatch reaches the provider despite the window reading', line === null, String(line))
  const fact = limits.anthropicWindowFact()
  check('the relayed fact carries no extra-usage flag', fact !== undefined && (fact as { onExtraUsage?: boolean }).onExtraUsage === undefined, JSON.stringify(fact))
  check('the hold reads the closed window until its reset', fact !== undefined && limits.anthropicWindowClosedUntil(fact, Date.now()) === fact.resetsAtMs, JSON.stringify(fact))
  mock.setMockRateLimitScenario('clear')
}

console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAIL`} · ${checks - failures}/${checks} PASS`)
process.exit(failures === 0 ? 0 : 1)

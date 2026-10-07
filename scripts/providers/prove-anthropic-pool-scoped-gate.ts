#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pool-scoped-gate-home-'))
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
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads

const OWNER = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000cc'
const ACCOUNT = 'cal@example.com'
const FABLE = 'claude-fable-5-1'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5'
const HAIKU = 'claude-haiku-4-5-20251001'

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
const map = () => usability.resolveProviderUsability(reads())
const gate = (model?: string): string | null => usability.delegationDispatchBlocker('anthropic', map(), model)
const observe = (scenario: 'opus-limit' | 'sonnet-limit' | 'weekly-limit-reached' | 'session-limit-reached'): void => {
  limits.resetLimitsForCredentialSwitch()
  mock.setMockRateLimitScenario(scenario)
  limits.extractQuotaStatusFromHeaders(new Headers())
}

console.log('============================================================')
console.log(' a weekly pool binds only the family it meters: the dispatch gate reads the pool the wire named against the agent model')
console.log('============================================================')

limits.__setAnthropicOwnerResolverForTest(() => OWNER, () => ACCOUNT)

section('§1 the Opus weekly pool is reached (rejected, no extra usage)')
{
  observe('opus-limit')
  const verdict = limits.anthropicLimitVerdict()
  check("the verdict reads rejected and names the pool the wire gave (seven_day_opus)", verdict.status === 'rejected' && verdict.claim === 'seven_day_opus', JSON.stringify(verdict))
  const lane = map().anthropic
  check('the lane carries the pool without capping delegation', lane.delegationCapped === false && lane.limitClaim === 'seven_day_opus', JSON.stringify(lane))
  check('an Opus agent reaches the provider despite its noted window', gate(OPUS) === null, String(gate(OPUS)))
  check('a Fable agent launches — the Opus week never caps a Fable turn', gate(FABLE) === null, String(gate(FABLE)))
  check('a Sonnet agent launches', gate(SONNET) === null, String(gate(SONNET)))
  check('a model outside every pooled family (a Haiku id) launches', gate(HAIKU) === null, String(gate(HAIKU)))
  check('a dispatch without a model is not refused by a note', gate() === null, String(gate()))
}

section('§2 the Sonnet weekly pool is reached')
{
  observe('sonnet-limit')
  check('the verdict names seven_day_sonnet', limits.anthropicLimitVerdict().claim === 'seven_day_sonnet', JSON.stringify(limits.anthropicLimitVerdict()))
  check('a Sonnet agent reaches the provider', gate(SONNET) === null, String(gate(SONNET)))
  check('an Opus agent launches', gate(OPUS) === null, String(gate(OPUS)))
  check('a Fable agent launches', gate(FABLE) === null, String(gate(FABLE)))
}

section('§3 a shared window (the week, the five hours) binds every Claude model')
{
  observe('weekly-limit-reached')
  check('the verdict names the shared week (seven_day)', limits.anthropicLimitVerdict().claim === 'seven_day', JSON.stringify(limits.anthropicLimitVerdict()))
  check('every model reaches the provider despite the shared week', [OPUS, FABLE, SONNET, HAIKU].every(m => gate(m) === null), [OPUS, FABLE, SONNET, HAIKU].map(m => String(gate(m))).join(' | '))
  observe('session-limit-reached')
  check('the verdict names the five-hour window', limits.anthropicLimitVerdict().claim === 'five_hour', JSON.stringify(limits.anthropicLimitVerdict()))
  check('every Claude agent reaches the provider despite the five-hour window', [OPUS, FABLE, SONNET, HAIKU].every(m => gate(m) === null))
  check('the window words remain a reading rather than a refusal', map().anthropic.limitBlocker?.startsWith('the Anthropic usage window is reached for cal@example.com') === true && gate(OPUS) === null)
}

section('§4 the pool law without a wire claim, and the launch door')
{
  limits.resetLimitsForCredentialSwitch()
  check('a rejected observation with no claim binds every model (windowClaimBindsModel)', limits.windowClaimBindsModel(undefined, OPUS) === true && limits.windowClaimBindsModel('seven_day_fable', OPUS) === false && limits.windowClaimBindsModel('seven_day_fable', FABLE) === true && limits.windowClaimBindsModel('seven_day_fable', undefined) === true)
  const src = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('the agent launch hands the resolved agent model to the gate (source)', src.includes('delegationDispatchBlocker(agentRouteVerdict.route, undefined, resolvedAgentModel)'))
  mock.setMockRateLimitScenario('clear')
}

console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAIL`} · ${checks - failures}/${checks} PASS`)
process.exit(failures === 0 ? 0 : 1)

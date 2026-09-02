#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const {
  recordOpenaiUsageLimit,
  openaiLimitWindow,
  __resetOpenaiLimitStateForTest,
} = await import('../../src/services/providers/openai/openaiLimitState.ts')
const { resolveProviderUsability } = await import(
  '../../src/services/providers/providerUsability.ts'
)
type Reads = import('../../src/services/providers/providerUsability.ts').ProviderUsabilityReads

const NOW = 1_900_000_000_000
const clock = (at: number) => () => at

section('§A the record is per-source — no bleed, own resets')
{
  __resetOpenaiLimitStateForTest()
  check('nothing observed ⇒ both pools clear', openaiLimitWindow('chatgpt-subscription', clock(NOW)).state === 'clear' && openaiLimitWindow('api-key', clock(NOW)).state === 'clear')
  recordOpenaiUsageLimit(NOW + 3_600_000, 'chatgpt-subscription', clock(NOW))
  const sub = openaiLimitWindow('chatgpt-subscription', clock(NOW))
  check('a subscription wall records against the subscription pool', sub.state === 'limited' && sub.state === 'limited' && sub.resetsAtMs === NOW + 3_600_000)
  check('…and the key slot stays CLEAR (its own billing, its own headroom)', openaiLimitWindow('api-key', clock(NOW)).state === 'clear')
  recordOpenaiUsageLimit(NOW + 60_000, 'api-key', clock(NOW))
  check('a key wall records against the key pool', openaiLimitWindow('api-key', clock(NOW)).state === 'limited')
  check('the key wall expires on ITS reset while the subscription wall stands', openaiLimitWindow('api-key', clock(NOW + 120_000)).state === 'clear' && openaiLimitWindow('chatgpt-subscription', clock(NOW + 120_000)).state === 'limited')
  check('the subscription wall expires on its own reset', openaiLimitWindow('chatgpt-subscription', clock(NOW + 3_700_000)).state === 'clear')
  recordOpenaiUsageLimit(undefined, 'chatgpt-subscription', clock(NOW))
  check('a reset-less 429 publishes no window (do-not-fake)', openaiLimitWindow('chatgpt-subscription', clock(NOW + 3_700_000)).state === 'clear')
}

section('§B the family verdict follows the ACTIVE source')
{
  const base: Reads = {
    anthropicApiKey: () => null,
    anthropicSubscriber: () => false,
    anthropicBearerToken: () => false,
    anthropicLimitStatus: () => 'allowed',
    gptSeat: () => ({ state: 'ready' }),
    zaiKeyPresent: () => false,
    moonshotAccount: () => undefined,
    deepseekKeyPresent: () => false,
    compatConfigured: () => false,
    huggingfaceAccount: () => undefined,
    localServerPresent: () => false,
    openrouterKeyPresent: () => false,
    geminiAccount: () => undefined,
  }
  __resetOpenaiLimitStateForTest()
  recordOpenaiUsageLimit(NOW + 3_600_000, 'chatgpt-subscription', clock(NOW))
  const activeKey = resolveProviderUsability({
    ...base,
    openaiLimitWindow: () => openaiLimitWindow('api-key', clock(NOW)),
  })
  check('subscription walled + ACTIVE=api-key ⇒ the lane stays USABLE', activeKey.openai.usable === true && activeKey.openai.limit !== 'rejected', JSON.stringify(activeKey.openai.blockers))
  const activeSub = resolveProviderUsability({
    ...base,
    openaiLimitWindow: () => openaiLimitWindow('chatgpt-subscription', clock(NOW)),
  })
  check('subscription walled + ACTIVE=subscription ⇒ the lane is walled (kept behavior)', activeSub.openai.usable === false && activeSub.openai.limit === 'rejected')
}

section('§C structural — the live default resolves the active source; the writer names its source')
{
  const usability = readFileSync(join(ROOT, 'src/services/providers/providerUsability.ts'), 'utf8')
  check('the live openaiLimitWindow read resolves the ACTIVE account first', usability.includes('resolveOpenaiAccount') && usability.includes('openaiLimitWindow(active.kind)'))
  const call = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('the usage-limit writer records under the source that answered (auth.account.kind)', call.includes('recordOpenaiUsageLimit(outcome.fault.resetsAtMs, auth.account.kind)'))
  const usage = readFileSync(join(ROOT, 'src/services/providers/providerUsage.ts'), 'utf8')
  check('the subscription usage view reads the subscription pool', usage.includes("openaiLimitWindow('chatgpt-subscription')"))
  check("the per-provider limits view reads the ACTIVE entry's pool", usage.includes("activeEntry?.kind === 'api-key' ? 'api-key' : 'chatgpt-subscription'"))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('OPENAI WALL SLOT TRUTH: ALL GREEN')
else console.log(`❌ ${failures} WALL-SLOT LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

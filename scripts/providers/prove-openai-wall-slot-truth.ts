#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const wallSlotFixHint =
  'fix in src/models/roads/openai/openaiLimitState.ts (recordOpenaiUsageLimit, openaiLimitWindow: one record per source) or in src/models/roads/providerUsability.ts (resolveProviderUsability: the openai lane must follow the active source)'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} | ` : ''}${wallSlotFixHint}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const {
  recordOpenaiUsageLimit,
  openaiLimitWindow,
  __resetOpenaiLimitStateForTest,
} = await import('../../src/models/roads/openai/openaiLimitState.ts')
const { resolveProviderUsability } = await import(
  '../../src/models/roads/providerUsability.ts'
)
type Reads = import('../../src/models/roads/providerUsability.ts').ProviderUsabilityReads

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
  check('the active subscription keeps its reading without locking the lane', activeSub.openai.usable === true && activeSub.openai.limit === 'rejected' && activeSub.openai.limitBlocker?.includes('usage window is reached') === true && activeSub.openai.blockers.length === 0)
}


console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('OPENAI WALL SLOT TRUTH: ALL GREEN')
else console.log(`❌ ${failures} WALL-SLOT LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

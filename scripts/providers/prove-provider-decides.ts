import type { ProviderUsabilityReads } from '../../src/services/providers/providerUsability.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { resolveProviderUsability, delegationDispatchBlocker } = await import('../../src/services/providers/providerUsability.js')
const { recordOpenaiUsageLimit, openaiLimitWindow } = await import('../../src/services/providers/openai/openaiLimitState.js')
const { recordOpenrouterRateHeaders, openrouterLimitWindow } = await import('../../src/services/providers/openrouter/openrouterUsageState.js')
const { recordGeminiUsageLimit, geminiLimitWindow } = await import('../../src/services/providers/gemini/geminiUsageState.js')
const { recordHuggingfaceRateHeaders, huggingfaceLimitWindow } = await import('../../src/services/providers/huggingface/huggingfaceUsageState.js')
let failures = 0
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const now = Date.now()
const reset = now + 6 * 24 * 60 * 60 * 1000
recordOpenaiUsageLimit(reset, 'chatgpt-subscription')
recordOpenrouterRateHeaders(new Headers({ 'x-ratelimit-reset': String(reset) }))
recordGeminiUsageLimit(reset)
recordHuggingfaceRateHeaders(new Headers({ 'x-ratelimit-reset': String(reset) }), 429)
const reads: ProviderUsabilityReads = {
  anthropicApiKey: () => null,
  anthropicSubscriber: () => true,
  anthropicLimitStatus: () => 'rejected',
  anthropicLimitObservation: () => ({ account: 'fixture', observedAtMs: now, resetsAtMs: reset }),
  gptSeat: () => ({ state: 'ready' }),
  zaiKeyPresent: () => false,
  openrouterKeyPresent: () => true,
  geminiAccount: () => ({ kind: 'api-key' }),
  huggingfaceAccount: () => ({ kind: 'api-key' }),
  openaiLimitWindow: () => openaiLimitWindow('chatgpt-subscription'),
  openrouterLimitWindow,
  geminiLimitWindow,
  huggingfaceLimitWindow,
}
const map = resolveProviderUsability(reads)
for (const family of ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface'] as const) {
  check(`${family}: a six-day note never refuses dispatch`, delegationDispatchBlocker(family, map) === null)
  check(`${family}: credentialed lane stays usable with its reading`, map[family].usable && map[family].limit === 'rejected' && Boolean(map[family].limitBlocker) && map[family].blockers.length === 0)
}
check('Anthropic: a window never caps delegation', map.anthropic.delegationCapped === false)
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} provider decides (${failures} failures)`)
process.exitCode = failures ? 1 : 0

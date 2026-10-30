import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const caps = await import('../../src/utils/model/capabilities.ts')
const model = await import('../../src/utils/model/model.ts')
const cost = await import('../../src/utils/modelCost.ts')
const { configureEffortParams } = await import('../../src/services/providers/anthropic/requestParams.ts')
for (const [dotted, dashed] of [['claude-opus-4.8', 'claude-opus-4-8'], ['claude-sonnet-4.6', 'claude-sonnet-4-6'], ['claude-haiku-4.5', 'claude-haiku-4-5']]) {
  for (const suffix of ['', '[1m]', '-20260101']) for (const upper of [false, true]) {
    const a = (upper ? dotted.toUpperCase() : dotted) + suffix
    const b = (upper ? dashed.toUpperCase() : dashed) + suffix
    assert.equal(model.getCanonicalName(a), model.getCanonicalName(b), a)
    assert.equal(caps.getContextWindowForModel(a), caps.getContextWindowForModel(b), a)
    assert.deepEqual(caps.getModelMaxOutputTokens(a), caps.getModelMaxOutputTokens(b), a)
    assert.deepEqual(caps.effortVocabularyFor(a), caps.effortVocabularyFor(b), a)
    assert.equal(caps.modelSupportsAdaptiveThinking(a), caps.modelSupportsAdaptiveThinking(b), a)
    assert.equal(caps.modelSupportsTemperature(a), caps.modelSupportsTemperature(b), a)
    assert.deepEqual(cost.resolveModelPricing(a), cost.resolveModelPricing(b), a)
    const dottedEffort = {}, dashedEffort = {}
    configureEffortParams('max', dottedEffort, {}, a)
    configureEffortParams('max', dashedEffort, {}, b)
    assert.deepEqual(dottedEffort, dashedEffort, a)
    assert.equal(model.normalizeModelStringForAPI(a), a.replace('[1m]', ''))
  }
}
assert.equal(model.getCanonicalName('openrouter/anthropic/claude-opus-4.8'), 'openrouter/anthropic/claude-opus-4.8')
console.log('P01 dotted gateway IDs retain their wire spelling and read the existing generation facts')

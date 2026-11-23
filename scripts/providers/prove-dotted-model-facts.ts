import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.2' }
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const caps = await import('../../src/models/facts/capabilities.ts')
const model = await import('../../src/models/catalogue/engineModel.ts')
const cost = await import('../../src/models/usage/modelCost.ts')
const { configureEffortParams } = await import('../../src/models/roads/anthropic/requestParams.ts')
for (const [dotted, dashed] of [['claude-opus-4.8', 'claude-opus-4-8'], ['claude-sonnet-4.6', 'claude-sonnet-4-6'], ['claude-haiku-4.5', 'claude-haiku-4-5']]) {
  for (const suffix of ['', '[1m]', '-20260101']) for (const upper of [false, true]) {
    const a = (upper ? dotted.toUpperCase() : dotted) + suffix
    const b = (upper ? dashed.toUpperCase() : dashed) + suffix
    assert.equal(model.getCanonicalName(a), model.getCanonicalName(b), a + ' | the dotted and dashed spellings must give one canonical name; fix getCanonicalName in src/models/facts/modelNames.ts')
    assert.equal(caps.getContextWindowForModel(a), caps.getContextWindowForModel(b), a + ' | the dotted and dashed spellings must give one context window; fix getContextWindowForModel in src/models/facts/capabilities.ts')
    assert.deepEqual(caps.getModelMaxOutputTokens(a), caps.getModelMaxOutputTokens(b), a + ' | the dotted and dashed spellings must give the same output limits; fix getModelMaxOutputTokens in src/models/facts/capabilities.ts')
    assert.deepEqual(caps.effortVocabularyFor(a), caps.effortVocabularyFor(b), a + ' | the dotted and dashed spellings must give the same effort vocabulary; fix effortVocabularyFor in src/models/facts/capabilities.ts')
    assert.equal(caps.modelSupportsAdaptiveThinking(a), caps.modelSupportsAdaptiveThinking(b), a + ' | the dotted and dashed spellings must agree on adaptive thinking; fix modelSupportsAdaptiveThinking in src/models/facts/capabilities.ts')
    assert.equal(caps.modelSupportsTemperature(a), caps.modelSupportsTemperature(b), a + ' | the dotted and dashed spellings must agree on temperature support; fix modelSupportsTemperature in src/models/facts/capabilities.ts')
    assert.deepEqual(cost.resolveModelPricing(a), cost.resolveModelPricing(b), a + ' | the dotted and dashed spellings must resolve the same pricing; fix resolveModelPricing in src/models/usage/modelCost.ts')
    const dottedEffort = {}, dashedEffort = {}
    configureEffortParams('max', dottedEffort, {}, a)
    configureEffortParams('max', dashedEffort, {}, b)
    assert.deepEqual(dottedEffort, dashedEffort, a + ' | the dotted and dashed spellings must configure the same effort params; fix configureEffortParams in src/models/roads/anthropic/requestParams.ts')
    assert.equal(model.normalizeModelStringForAPI(a), a.replace('[1m]', ''), a + ' | the API string must keep the dotted spelling and drop only the [1m] suffix; fix normalizeModelStringForAPI in src/models/facts/modelNames.ts')
  }
}
assert.equal(model.getCanonicalName('openrouter/anthropic/claude-opus-4.8'), 'openrouter/anthropic/claude-opus-4.8', 'a gateway id must keep its dotted wire spelling; fix getCanonicalName in src/models/facts/modelNames.ts')
console.log('P01 dotted gateway IDs retain their wire spelling and read the existing generation facts')

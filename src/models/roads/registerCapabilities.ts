import {
  isProviderCapabilitiesRegistered,
  registerProviderCapabilities,
  type OperatorModelFacts,
  type ProviderCapabilities,
  type ProviderLocalEffortView,
  type ProviderLocalWindowView,
} from '../facts/capabilityRegistry.js'

function createDefaultProviderCapabilities(): ProviderCapabilities {
  return {
    isCarrierShapedId(model: string): boolean {
      const { isCarrierShapedId } = require('./idSpaces.js') as typeof import('./idSpaces.js')
      return isCarrierShapedId(model)
    },
    declaredRouteOf(model: string) {
      const { declaredRouteOf } = require('./routeLaw.js') as typeof import('./routeLaw.js')
      return declaredRouteOf(model)
    },
    classifyModelRoute(model: string) {
      const { classifyModelRoute } = require('./routeLaw.js') as typeof import('./routeLaw.js')
      return classifyModelRoute(model)
    },
    qualifiedWireId(model: string): string {
      const { qualifiedWireId } = require('./routeLaw.js') as typeof import('./routeLaw.js')
      return qualifiedWireId(model)
    },
    isMeliousModelId(model: string): boolean {
      const { isMeliousModelId } = require('./melious/meliousCatalogue.js') as typeof import('./melious/meliousCatalogue.js')
      return isMeliousModelId(model)
    },
    isOrcarouterModelId(model: string): boolean {
      const { isOrcarouterModelId } = require('./orcarouter/orcarouterCatalogue.js') as typeof import('./orcarouter/orcarouterCatalogue.js')
      return isOrcarouterModelId(model)
    },
    liveGptEffortCatalogue(canonicalId: string) {
      const { liveGptEffortCatalogue } = require('./openai/openaiCatalogue.js') as typeof import('./openai/openaiCatalogue.js')
      return liveGptEffortCatalogue(canonicalId)
    },
    liveGptDefaultEffort(canonicalId: string) {
      const { liveGptDefaultEffort } = require('./openai/openaiCatalogue.js') as typeof import('./openai/openaiCatalogue.js')
      return liveGptDefaultEffort(canonicalId)
    },
    liveGptContextWindow(model: string) {
      const { liveGptContextWindow } = require('./openai/openaiCatalogue.js') as typeof import('./openai/openaiCatalogue.js')
      return liveGptContextWindow(model)
    },
    liveGptContextCeiling(model: string) {
      const { liveGptContextCeiling } = require('./openai/openaiCatalogue.js') as typeof import('./openai/openaiCatalogue.js')
      return liveGptContextCeiling(model)
    },
    liveGptInputModalities(normalizedId: string) {
      const { liveGptInputModalities } = require('./openai/openaiCatalogue.js') as typeof import('./openai/openaiCatalogue.js')
      return liveGptInputModalities(normalizedId)
    },
    xaiModelFacts(model: string) {
      const { xaiModelFacts } = require('./xai/xaiCatalogue.js') as typeof import('./xai/xaiCatalogue.js')
      return xaiModelFacts(model)
    },
    xaiLiveContextWindow(normalizedId: string) {
      const { getCachedXaiCatalogue } = require('./xai/xaiCatalogue.js') as typeof import('./xai/xaiCatalogue.js')
      return getCachedXaiCatalogue()?.models.find(row => row.id.toLowerCase() === normalizedId)?.contextWindow
    },
    mistralModelFacts(model: string) {
      const { mistralModelFacts } = require('./mistral/mistralCatalogue.js') as typeof import('./mistral/mistralCatalogue.js')
      return mistralModelFacts(model)
    },
    cohereModelFacts(model: string) {
      const { cohereModelFacts } = require('./cohere/cohereCatalogue.js') as typeof import('./cohere/cohereCatalogue.js')
      return cohereModelFacts(model)
    },
    qwenModelFacts(model: string) {
      const { qwenModelFacts } = require('./qwen/qwenCatalogue.js') as typeof import('./qwen/qwenCatalogue.js')
      return qwenModelFacts(model)
    },
    deepseekLiveContextWindow(normalizedId: string) {
      const { deepseekLiveModel } = require('./deepseek/deepseekCatalogue.js') as typeof import('./deepseek/deepseekCatalogue.js')
      return deepseekLiveModel(normalizedId)?.contextWindow
    },
    deepseekModelFacts(normalizedId: string) {
      const { deepseekModelFacts } = require('./deepseek/deepseekCatalogue.js') as typeof import('./deepseek/deepseekCatalogue.js')
      return deepseekModelFacts(normalizedId)
    },
    meliousListedModel(model: string) {
      const { meliousListedModel } = require('./melious/meliousCatalogue.js') as typeof import('./melious/meliousCatalogue.js')
      return meliousListedModel(model)
    },
    orcarouterListedModel(model: string) {
      const { orcarouterListedModel } = require('./orcarouter/orcarouterCatalogue.js') as typeof import('./orcarouter/orcarouterCatalogue.js')
      return orcarouterListedModel(model)
    },
    openrouterInputModalities(model: string) {
      const { openrouterListedModel } = require('./openrouter/openrouterCatalogue.js') as typeof import('./openrouter/openrouterCatalogue.js')
      return openrouterListedModel(model)?.inputModalities
    },
    huggingfaceInputModalities(wireId: string) {
      const { huggingfaceLiveModel } = require('./huggingface/huggingfaceCatalogue.js') as typeof import('./huggingface/huggingfaceCatalogue.js')
      return huggingfaceLiveModel(wireId)?.inputModalities
    },
    nousInputModalities(model: string) {
      const { nousListedModel } = require('./nous/nousCatalogue.js') as typeof import('./nous/nousCatalogue.js')
      return nousListedModel(model)?.inputModalities
    },
    geminiDeclaresImages(model: string) {
      const { geminiListedModel } = require('./gemini/geminiCatalogue.js') as typeof import('./gemini/geminiCatalogue.js')
      return geminiListedModel(model)?.images
    },
    thinkingOffWireEffort(vocabulary: readonly string[]) {
      const { thinkingOffWireEffort } = require('./openaicompat/compatWire.js') as typeof import('./openaicompat/compatWire.js')
      return thinkingOffWireEffort(vocabulary)
    },
    meliousEffortVocabulary(model: string) {
      const { meliousEffortVocabulary } = require('./melious/meliousCatalogue.js') as typeof import('./melious/meliousCatalogue.js')
      return meliousEffortVocabulary(model)
    },
    orcarouterEffortVocabulary(model: string) {
      const { orcarouterEffortVocabulary } = require('./orcarouter/orcarouterCatalogue.js') as typeof import('./orcarouter/orcarouterCatalogue.js')
      return orcarouterEffortVocabulary(model)
    },
    openrouterEffortVocabularyFor(model: string) {
      const { openrouterEffortVocabularyFor } = require('./openrouter/openrouterCatalogue.js') as typeof import('./openrouter/openrouterCatalogue.js')
      return openrouterEffortVocabularyFor(model)
    },
    nousEffortVocabularyFor(model: string) {
      const { nousEffortVocabularyFor } = require('./nous/nousCatalogue.js') as typeof import('./nous/nousCatalogue.js')
      return nousEffortVocabularyFor(model)
    },
    geminiEffortVocabularyFor(model: string) {
      const { geminiEffortVocabularyFor } = require('./gemini/geminiCatalogue.js') as typeof import('./gemini/geminiCatalogue.js')
      return geminiEffortVocabularyFor(model)
    },
    compatEffortFor(model: string) {
      const { compatModelEfforts, compatModelThinkingOffWire } = require('./openaicompat/compatEffort.js') as typeof import('./openaicompat/compatEffort.js')
      return {
        vocabulary: compatModelEfforts(model),
        thinkingOffWire: compatModelThinkingOffWire(model),
      }
    },
    localEffortFor(model: string): ProviderLocalEffortView {
      const { localRecordFor } = require('./local/localCatalogue.js') as typeof import('./local/localCatalogue.js')
      const { localModelAcceptsEffort, localServedEfforts } = require('./local/localCallModel.js') as typeof import('./local/localCallModel.js')
      const { LOCAL_SERVER_STATES_THINKING, TENSORFOLD_DIAL, localThinkingOffWireEffort } =
        require('./openaicompat/compatWire.js') as typeof import('./openaicompat/compatWire.js')
      const record = localRecordFor(model)
      if (record?.server === 'tensorfold') {
        return localModelAcceptsEffort(record)
          ? { kind: 'provider', source: 'local', vocabulary: TENSORFOLD_DIAL, thinkingGated: true, thinkingOffWire: 'none' }
          : { kind: 'none', source: 'local' }
      }
      if (record?.thinking !== undefined) {
        const vocabulary = record.thinking.values.filter((value): value is string => typeof value === 'string')
        return vocabulary.length > 0
          ? {
              kind: 'provider',
              source: 'local',
              vocabulary,
              thinkingGated: false,
              ...(typeof record.thinking.default === 'string' ? { defaultEffort: record.thinking.default } : {}),
            }
          : { kind: 'none', source: 'local' }
      }
      const served = record && localModelAcceptsEffort(record) ? localServedEfforts(record) : undefined
      const vocabulary = served?.vocabulary ?? []
      const thinkingOffWire = record ? localThinkingOffWireEffort(record.server) : undefined
      return record && vocabulary.length > 0
        ? {
            kind: 'provider',
            source: 'local',
            vocabulary,
            thinkingGated: LOCAL_SERVER_STATES_THINKING[record.server],
            ...(thinkingOffWire !== undefined ? { thinkingOffWire } : {}),
            ...(served?.steps !== undefined ? { steps: served.steps } : {}),
          }
        : { kind: 'none', source: 'local' }
    },
    carrierContextWindowFor(route: 'openrouter' | 'nous' | 'gemini', normalizedId: string) {
      if (route === 'openrouter') {
        const { openrouterContextWindowFor } = require('./openrouter/openrouterCatalogue.js') as typeof import('./openrouter/openrouterCatalogue.js')
        return openrouterContextWindowFor(normalizedId)
      }
      if (route === 'nous') {
        const { nousContextWindowFor } = require('./nous/nousCatalogue.js') as typeof import('./nous/nousCatalogue.js')
        return nousContextWindowFor(normalizedId)
      }
      const { geminiContextWindowFor } = require('./gemini/geminiCatalogue.js') as typeof import('./gemini/geminiCatalogue.js')
      return geminiContextWindowFor(normalizedId)
    },
    huggingfaceContextWindowFor(normalizedId: string) {
      const { huggingfaceContextWindowFor } = require('./huggingface/huggingfaceCatalogue.js') as typeof import('./huggingface/huggingfaceCatalogue.js')
      return huggingfaceContextWindowFor(normalizedId)
    },
    localContextWindowFor(normalizedId: string): ProviderLocalWindowView {
      const { localRecordFor, localUnloadedWindowWords } = require('./local/localCatalogue.js') as typeof import('./local/localCatalogue.js')
      const { localPlannedWindow } = require('./local/localWindow.js') as typeof import('./local/localWindow.js')
      const record = localRecordFor(normalizedId)
      const planned = record ? localPlannedWindow(record) : undefined
      if (planned !== undefined) {
        return { kind: 'planned', tokens: planned.tokens, source: planned.source, sourceWords: planned.sourceWords }
      }
      return { kind: 'unloaded', ...(record ? { unloadedWords: localUnloadedWindowWords(record) } : {}) }
    },
    compatContextWindowFor(model: string) {
      const { compatContextWindowFor } = require('./openaicompat/compatCatalogue.js') as typeof import('./openaicompat/compatCatalogue.js')
      return compatContextWindowFor(model)
    },
    togetherContextWindowFor(id: string) {
      const { togetherContextWindowFor } = require('./together/togetherCatalogue.js') as typeof import('./together/togetherCatalogue.js')
      return togetherContextWindowFor(id)
    },
    groqContextWindowFor(id: string) {
      const { groqContextWindowFor } = require('./groq/groqCatalogue.js') as typeof import('./groq/groqCatalogue.js')
      return groqContextWindowFor(id)
    },
    meliousContextWindowFor(id: string) {
      const { meliousContextWindowFor } = require('./melious/meliousCatalogue.js') as typeof import('./melious/meliousCatalogue.js')
      return meliousContextWindowFor(id)
    },
    cerebrasContextWindowFor(id: string) {
      const { cerebrasContextWindowFor } = require('./cerebras/cerebrasCatalogue.js') as typeof import('./cerebras/cerebrasCatalogue.js')
      return cerebrasContextWindowFor(id)
    },
    fireworksContextWindowFor(id: string) {
      const { fireworksContextWindowFor } = require('./fireworks/fireworksCatalogue.js') as typeof import('./fireworks/fireworksCatalogue.js')
      return fireworksContextWindowFor(id)
    },
    groqOutputMaxFor(model: string) {
      const { groqOutputMaxFor } = require('./groq/groqCatalogue.js') as typeof import('./groq/groqCatalogue.js')
      return groqOutputMaxFor(model)
    },
    meliousOutputMaxFor(model: string) {
      const { meliousOutputMaxFor } = require('./melious/meliousCatalogue.js') as typeof import('./melious/meliousCatalogue.js')
      return meliousOutputMaxFor(model)
    },
    cerebrasOutputMaxFor(model: string) {
      const { cerebrasOutputMaxFor } = require('./cerebras/cerebrasCatalogue.js') as typeof import('./cerebras/cerebrasCatalogue.js')
      return cerebrasOutputMaxFor(model)
    },
    fireworksOutputMaxFor(model: string) {
      const { fireworksOutputMaxFor } = require('./fireworks/fireworksCatalogue.js') as typeof import('./fireworks/fireworksCatalogue.js')
      return fireworksOutputMaxFor(model)
    },
    carrierOutputMaxFor(route: 'openrouter' | 'nous' | 'gemini', normalizedId: string) {
      if (route === 'openrouter') {
        const { openrouterMaxCompletionTokensFor } = require('./openrouter/openrouterCatalogue.js') as typeof import('./openrouter/openrouterCatalogue.js')
        return openrouterMaxCompletionTokensFor(normalizedId)
      }
      if (route === 'nous') {
        const { nousMaxCompletionTokensFor } = require('./nous/nousCatalogue.js') as typeof import('./nous/nousCatalogue.js')
        return nousMaxCompletionTokensFor(normalizedId)
      }
      const { geminiOutputTokenLimitFor } = require('./gemini/geminiCatalogue.js') as typeof import('./gemini/geminiCatalogue.js')
      return geminiOutputTokenLimitFor(normalizedId)
    },
    localVisionDeclared(model: string): boolean {
      const { localRecordFor } = require('./local/localCatalogue.js') as typeof import('./local/localCatalogue.js')
      return localRecordFor(model)?.visionDeclared === true
    },
    modelHasRecordedFacts(model: string): boolean {
      const { modelHasRecordedFacts } = require('../catalogue/modelOverrides.js') as typeof import('../catalogue/modelOverrides.js')
      return modelHasRecordedFacts(model)
    },
    operatorModelFacts(model: string, recorded?: OperatorModelFacts) {
      const { operatorModelFacts } = require('../catalogue/modelOverrides.js') as typeof import('../catalogue/modelOverrides.js')
      return operatorModelFacts(model, recorded)
    },
    getEngineModel(): string {
      const { getEngineModel } = require('../catalogue/engineModel.js') as typeof import('../catalogue/engineModel.js')
      return getEngineModel()
    },
  }
}

export function registerDefaultProviderCapabilities(): void {
  if (isProviderCapabilitiesRegistered()) return
  registerProviderCapabilities(createDefaultProviderCapabilities())
}

import type { CallModelRoute } from './providerRoute.js'

type ProviderRouteVerdict =
  | { kind: 'route'; route: CallModelRoute }
  | { kind: 'unrecognised' }
  | { kind: 'absence' }

export type ProviderLocalEffortView =
  | {
      kind: 'provider'
      source: 'local'
      vocabulary: readonly string[]
      defaultEffort?: string
      thinkingGated: boolean
      thinkingOffWire?: string
      steps?: Readonly<Record<string, string>>
    }
  | { kind: 'none'; source: 'local' }

export type ProviderLocalWindowView =
  | { kind: 'planned'; tokens: number; source: string; sourceWords: string }
  | { kind: 'unloaded'; unloadedWords?: string }

export interface ProviderCapabilities {
  isCarrierShapedId(model: string): boolean
  declaredRouteOf(model: string): CallModelRoute | null
  classifyModelRoute(model: string): ProviderRouteVerdict
  qualifiedWireId(model: string): string
  isMeliousModelId(model: string): boolean
  isOrcarouterModelId(model: string): boolean
  liveGptEffortCatalogue(canonicalId: string): {
    vocabulary: readonly string[]
    defaultEffort?: string
    stated: boolean
    wordsFromRow?: true
  } | undefined
  liveGptDefaultEffort(canonicalId: string): string | undefined
  liveGptContextWindow(model: string): number | undefined
  liveGptContextCeiling(model: string): number | undefined
  liveGptInputModalities(normalizedId: string): readonly string[] | undefined
  xaiModelFacts(model: string): {
    temperature?: boolean
    reasoning?: boolean
    efforts?: readonly string[]
    defaultEffort?: string
    contextWindow?: number
    images?: boolean
  } | undefined
  xaiLiveContextWindow(normalizedId: string): number | undefined
  mistralModelFacts(model: string): {
    reasoning?: boolean
    efforts: readonly string[]
    contextWindow?: number
    images?: boolean
  }
  cohereModelFacts(model: string): {
    reasoning?: boolean
    efforts: readonly string[]
    contextWindow?: number
    outputMax?: number
    images?: boolean
  }
  qwenModelFacts(model: string): {
    thinking?: string
    efforts: readonly string[]
    contextWindow?: number
    outputMax?: number
  }
  deepseekLiveContextWindow(normalizedId: string): number | undefined
  deepseekModelFacts(normalizedId: string): { outputMax?: number; images?: boolean } | undefined
  meliousListedModel(model: string): { reasoning?: boolean; reasoningType?: string; images?: boolean } | undefined
  orcarouterListedModel(model: string): {
    contextWindow?: number
    outputMax?: number
    inputModalities?: readonly string[]
  } | undefined
  openrouterInputModalities(model: string): readonly string[] | undefined
  huggingfaceInputModalities(wireId: string): readonly string[] | undefined
  nousInputModalities(model: string): readonly string[] | undefined
  geminiDeclaresImages(model: string): boolean | undefined
  thinkingOffWireEffort(vocabulary: readonly string[]): string | undefined
  meliousEffortVocabulary(model: string): readonly string[]
  orcarouterEffortVocabulary(model: string): readonly string[]
  openrouterEffortVocabularyFor(model: string): readonly string[]
  nousEffortVocabularyFor(model: string): readonly string[]
  geminiEffortVocabularyFor(model: string): readonly string[]
  compatEffortFor(model: string): { vocabulary: readonly string[]; thinkingOffWire?: string }
  localEffortFor(model: string): ProviderLocalEffortView
  carrierContextWindowFor(
    route: 'openrouter' | 'nous' | 'gemini',
    normalizedId: string,
  ): { window: number; source: 'live-current' | 'static-pin' } | undefined
  huggingfaceContextWindowFor(
    normalizedId: string,
  ): { window: number; source: 'live-current' | 'static-pin' } | undefined
  localContextWindowFor(normalizedId: string): ProviderLocalWindowView
  compatContextWindowFor(model: string): number | undefined
  togetherContextWindowFor(id: string): number | undefined
  groqContextWindowFor(id: string): number | undefined
  meliousContextWindowFor(id: string): number | undefined
  cerebrasContextWindowFor(id: string): number | undefined
  fireworksContextWindowFor(id: string): number | undefined
  groqOutputMaxFor(model: string): number | undefined
  meliousOutputMaxFor(model: string): number | undefined
  cerebrasOutputMaxFor(model: string): number | undefined
  fireworksOutputMaxFor(model: string): number | undefined
  carrierOutputMaxFor(route: 'openrouter' | 'nous' | 'gemini', normalizedId: string): number | undefined
  localVisionDeclared(model: string): boolean
  modelHasRecordedFacts(model: string): boolean
  operatorModelFacts(model: string, recorded?: OperatorModelFacts): OperatorModelFacts | undefined
  getEngineModel(): string
}

export interface OperatorModelFacts {
  contextWindow?: number
  maxOutputTokens?: number
  prices?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  efforts?: string[]
  images?: boolean
  reasoning?: boolean
  thinkingBudget?: number
}

let registered: ProviderCapabilities | undefined

export function registerProviderCapabilities(provider: ProviderCapabilities): void {
  registered = provider
}

export function isProviderCapabilitiesRegistered(): boolean {
  return registered !== undefined
}

export function providerCapabilities(): ProviderCapabilities {
  if (registered === undefined) {
    throw new Error('provider capabilities are not registered: call registerBootDoors() at startup')
  }
  return registered
}

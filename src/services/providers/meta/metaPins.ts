export const META_FACTS_SOURCE = 'https://dev.meta.ai/docs/models'
export const META_PRICING_SOURCE = 'https://dev.meta.ai/docs/pricing-rate-limits'
export const META_REASONING_SOURCE = 'https://dev.meta.ai/docs/reasoning'
export const META_OBSERVED_AT = '2026-09-30'
export const META_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export function isMetaModelId(model: string): boolean {
  return /^(?:muse|muse-.*)$/i.test(model.trim())
}

export function isMetaChatModelId(model: string): boolean {
  return /^muse-spark-[a-z0-9][a-z0-9._-]*$/i.test(model.trim())
}

export function isMetaContributorModel(model: string): boolean {
  return /-contributor$/i.test(model.trim())
}

export interface MetaDisplayPin {
  id: string
  displayName: string
  observedAt: string
  contextWindow: number
  outputMax?: number
  costInPerMtok: number
  cachedInPerMtok: number
  costOutPerMtok: number
  tools: boolean
  structuredOutputs: boolean
  images: boolean
  efforts: readonly string[]
}

const facts = {
  observedAt: META_OBSERVED_AT, contextWindow: 1_048_576,
  tools: true, structuredOutputs: true, images: true,
  costInPerMtok: 1.25, cachedInPerMtok: 0.15, costOutPerMtok: 4.25, efforts: META_EFFORTS,
} as const
const contributor = { costInPerMtok: 0.10, cachedInPerMtok: 0.002, costOutPerMtok: 0.20 }

export const META_DISPLAY_PINS: readonly MetaDisplayPin[] = [
  { ...facts, id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3', outputMax: 131_072, efforts: [...META_EFFORTS, 'max'] },
  { ...facts, id: 'muse-spark-1.2', displayName: 'Muse Spark 1.2' },
  { ...facts, id: 'muse-spark-1.1', displayName: 'Muse Spark 1.1' },
  { ...facts, ...contributor, id: 'muse-spark-1.3-contributor', displayName: 'Muse Spark 1.3 Contributor (training permitted)' },
  { ...facts, ...contributor, id: 'muse-spark-1.2-contributor', displayName: 'Muse Spark 1.2 Contributor (training permitted)' },
]

export function metaDisplayPin(id: string): MetaDisplayPin | undefined {
  return META_DISPLAY_PINS.find(pin => pin.id === id.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, ''))
}

export function metaDisplayName(id: string): string {
  return metaDisplayPin(id)?.displayName ?? (isMetaContributorModel(id) ? `${id} (training permitted)` : id)
}

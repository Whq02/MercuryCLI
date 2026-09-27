export interface KvGeometry {
  kvHeads: number
  keyLength: number
  valueLength: number
  attentionLayers: number
  blockCount: number
  interval?: number
}

export const KV_CACHE_BYTES_PER_ELEMENT: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q4_0: 18 / 32,
  q4_1: 20 / 32,
  q5_0: 22 / 32,
  q5_1: 24 / 32,
  iq4_nl: 18 / 32,
}

export const KV_CACHE_DEFAULT_TYPE = 'f16'

const GIB = 1024 ** 3
const GB = 1000 ** 3

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

export function kvGeometryOf(info: Record<string, unknown>): KvGeometry | undefined {
  const arch = typeof info['general.architecture'] === 'string' ? (info['general.architecture'] as string) : undefined
  if (!arch) return undefined
  const blockCount = numberOf(info[`${arch}.block_count`])
  const headCount = numberOf(info[`${arch}.attention.head_count`])
  const embedding = numberOf(info[`${arch}.embedding_length`])
  if (blockCount === undefined) return undefined
  const kvRaw = info[`${arch}.attention.head_count_kv`]
  const interval = numberOf(info[`${arch}.full_attention_interval`])
  let kvHeads: number
  let attentionLayers: number
  if (Array.isArray(kvRaw)) {
    const perLayer = kvRaw.map(v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0))
    kvHeads = perLayer.reduce((sum, v) => sum + v, 0)
    attentionLayers = perLayer.filter(v => v > 0).length
  } else {
    const perLayer = numberOf(kvRaw) ?? headCount
    if (perLayer === undefined) return undefined
    attentionLayers = interval !== undefined && interval > 1 ? Math.floor(blockCount / interval) : blockCount
    kvHeads = perLayer * attentionLayers
  }
  const keyLength = numberOf(info[`${arch}.attention.key_length`]) ?? (headCount && embedding ? embedding / headCount : undefined)
  if (keyLength === undefined) return undefined
  const valueLength = numberOf(info[`${arch}.attention.value_length`]) ?? keyLength
  return { kvHeads, keyLength, valueLength, attentionLayers, blockCount, ...(interval !== undefined ? { interval } : {}) }
}

export function kvBytesPerElement(cacheType: string | undefined): number {
  return KV_CACHE_BYTES_PER_ELEMENT[(cacheType ?? KV_CACHE_DEFAULT_TYPE).toLowerCase()] ?? KV_CACHE_BYTES_PER_ELEMENT[KV_CACHE_DEFAULT_TYPE]!
}

export function kvBytesPerToken(geometry: KvGeometry, cacheType?: string): number {
  return geometry.kvHeads * (geometry.keyLength + geometry.valueLength) * kvBytesPerElement(cacheType)
}

export function kvCacheBytes(geometry: KvGeometry, window: number, slots: number, cacheType?: string): number {
  return Math.round(kvBytesPerToken(geometry, cacheType) * window * Math.max(1, slots))
}

export function loadEstimateBytes(weightsBytes: number, geometry: KvGeometry, window: number, slots: number, cacheType?: string): number {
  return weightsBytes + kvCacheBytes(geometry, window, slots, cacheType)
}

export function gibWords(bytes: number): string {
  const value = bytes / GIB
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} GiB`
}

export function gbWords(bytes: number): string {
  const value = bytes / GB
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} GB`
}

export function tokensWords(tokens: number): string {
  if (tokens % 1024 === 0 && tokens >= 1024) return `${tokens / 1024}k`
  return String(tokens)
}

export interface LoadProjection {
  name: string
  weightsBytes: number
  cacheBytes: number
  totalBytes: number
  window: number
  slots: number
}

export function projectLoad(model: { name: string; weightsBytes: number; geometry: KvGeometry }, window: number, slots: number, cacheType?: string): LoadProjection {
  const cacheBytes = kvCacheBytes(model.geometry, window, slots, cacheType)
  return { name: model.name, weightsBytes: model.weightsBytes, cacheBytes, totalBytes: model.weightsBytes + cacheBytes, window, slots }
}

export function fitWords(totalBytes: number, machineBytes: number): string {
  if (totalBytes <= machineBytes * 0.9) return `fits in ${gibWords(machineBytes)}`
  if (totalBytes <= machineBytes) return `fills ${gibWords(machineBytes)} (nothing left for the system)`
  return `does not fit in ${gibWords(machineBytes)}`
}

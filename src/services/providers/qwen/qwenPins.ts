export const QWEN_OBSERVED_AT = '2026-10-18'
const QWEN_PLAN_MODEL_ID = 'coder-model'
const QWEN_EFFORTS: readonly string[] = ['low', 'medium', 'xhigh']

export type QwenThinkingDial = 'hybrid' | 'none'

interface QwenDisplayPin {
  id: string
  displayName: string
  contextWindow: number
  outputMax: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
  cacheWritePerMtok?: number
  thinking: QwenThinkingDial
  preservesThinking: boolean
  efforts: readonly string[]
  images: boolean
  planOnly?: boolean
}

const flagship = { contextWindow: 1_000_000, outputMax: 131_072, thinking: 'hybrid' as const, preservesThinking: true, efforts: [] as readonly string[], images: true }

export const QWEN_DISPLAY_PINS: readonly QwenDisplayPin[] = [
  { ...flagship, id: 'qwen3.8-max', displayName: 'Qwen3.8 Max', efforts: QWEN_EFFORTS, costInPerMtok: 2, costOutPerMtok: 6, cachedInPerMtok: 0.25, cacheWritePerMtok: 2.5 },
  { ...flagship, id: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus', costInPerMtok: 0.4, costOutPerMtok: 1.6, cachedInPerMtok: 0.08, cacheWritePerMtok: 0.5 },
  { ...flagship, id: 'qwen3.8-flash', displayName: 'Qwen3.8 Flash', efforts: QWEN_EFFORTS, costInPerMtok: 0.15, costOutPerMtok: 0.47, cachedInPerMtok: 0.016, cacheWritePerMtok: 0.2 },
  { ...flagship, id: 'qwen3.8-omni-flash', displayName: 'Qwen3.8 Omni Flash', efforts: QWEN_EFFORTS, costInPerMtok: 0.15, costOutPerMtok: 0.47, cachedInPerMtok: 0.016 },
  { ...flagship, id: 'qwen3.7-flash', displayName: 'Qwen3.7 Flash', costInPerMtok: 0.03, costOutPerMtok: 0.13, cachedInPerMtok: 0.006, cacheWritePerMtok: 0.038 },
  { id: 'qwen3-coder-flash', displayName: 'Qwen3 Coder Flash', contextWindow: 1_000_000, outputMax: 65_536, costInPerMtok: 0.3, costOutPerMtok: 1.5, cachedInPerMtok: 0.06, cacheWritePerMtok: 0.375, thinking: 'none', preservesThinking: false, efforts: [], images: false },
  { id: QWEN_PLAN_MODEL_ID, displayName: 'Qwen Coder (Qwen account plan)', contextWindow: 1_000_000, outputMax: 65_536, thinking: 'none', preservesThinking: false, efforts: [], images: false, planOnly: true },
]

function bareId(id: string): string {
  return id.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, '')
}

export function isQwenModelId(model: string): boolean {
  const id = bareId(model)
  return id === 'qwen' || id === QWEN_PLAN_MODEL_ID || /^(?:qwen|qwq|qvq)(?:[0-9.]|-)/.test(id)
}

export function isQwenTextModelId(model: string): boolean {
  const id = bareId(model)
  if (id === QWEN_PLAN_MODEL_ID) return true
  return /^(?:qwen|qwq|qvq)(?:[0-9.]|-)/.test(id)
    && !/(?:-tts|-asr|embedding|rerank|-image|-video|realtime|livetranslate|-ocr|-audio-|-mt-|wan[0-9])/i.test(id)
}

export function qwenDisplayPin(id: string): QwenDisplayPin | undefined {
  const bare = bareId(id)
  return QWEN_DISPLAY_PINS.find(pin => pin.id === bare)
}

export function qwenDisplayName(id: string): string {
  return qwenDisplayPin(id)?.displayName ?? bareId(id)
}

const HYBRID_THINKING_RE = /^(?:qwen3(?:\.[0-9]+)?-(?:max|plus|flash|omni-flash)|qwen3(?:\.[0-9]+)?-[0-9]+b|qwen-(?:plus|flash))(?:-|$)/
const PRESERVES_THINKING_RE = /^(?:qwen3\.8-(?:max|flash|omni-flash)|qwen3\.7-(?:max|plus|flash)|qwen3\.6-plus)(?:-|$)/
const EFFORT_DIAL_RE = /^qwen3\.8-(?:max|flash|omni-flash|2\.4t-a95b|27b)(?:-|$)/

export function qwenThinkingDial(id: string): QwenThinkingDial {
  const pin = qwenDisplayPin(id)
  if (pin) return pin.thinking
  return HYBRID_THINKING_RE.test(bareId(id)) ? 'hybrid' : 'none'
}

export function qwenPreservesThinking(id: string): boolean {
  const pin = qwenDisplayPin(id)
  if (pin) return pin.preservesThinking
  return PRESERVES_THINKING_RE.test(bareId(id))
}

export function qwenEffortVocabulary(id: string): readonly string[] {
  const pin = qwenDisplayPin(id)
  if (pin) return pin.efforts
  return EFFORT_DIAL_RE.test(bareId(id)) ? QWEN_EFFORTS : []
}

export function qwenWireEffort(effort: string): string | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'xhigh'
    default:
      return undefined
  }
}

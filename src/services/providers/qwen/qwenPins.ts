export const QWEN_OBSERVED_AT = '2026-10-18'
const QWEN_PLAN_MODEL_ID = 'coder-model'
const QWEN_EFFORTS: readonly string[] = ['low', 'medium', 'xhigh']

export type QwenThinkingDial = 'hybrid' | 'none'

interface QwenDisplayPin {
  id: string
  wireId?: string
  displayName: string
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
  cacheWritePerMtok?: number
  thinking: QwenThinkingDial
  preservesThinking: boolean
  efforts: readonly string[]
  images: boolean
  planOnly?: boolean
  codingPlan?: boolean
  codingPlanOnly?: boolean
}

export type QwenPinScope = 'pay-as-you-go' | 'coding-plan' | 'account-plan'

const flagship = { contextWindow: 1_000_000, outputMax: 131_072, thinking: 'hybrid' as const, preservesThinking: true, efforts: [] as readonly string[], images: true }

const QWEN_CODING_PLAN_ROUTER_ID = 'qwen-auto'

export const QWEN_DISPLAY_PINS: readonly QwenDisplayPin[] = [
  { ...flagship, id: 'qwen3.8-max', displayName: 'Qwen3.8 Max', efforts: QWEN_EFFORTS, costInPerMtok: 2, costOutPerMtok: 6, cachedInPerMtok: 0.25, cacheWritePerMtok: 2.5, codingPlan: true },
  { ...flagship, id: 'qwen3.7-max', displayName: 'Qwen3.7 Max', images: false, costInPerMtok: 2.5, costOutPerMtok: 7.5, cachedInPerMtok: 0.25, cacheWritePerMtok: 3.125, codingPlan: true },
  { ...flagship, id: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus', costInPerMtok: 0.4, costOutPerMtok: 1.6, cachedInPerMtok: 0.08, cacheWritePerMtok: 0.5, codingPlan: true },
  { ...flagship, id: 'qwen3.8-flash', displayName: 'Qwen3.8 Flash', efforts: QWEN_EFFORTS, costInPerMtok: 0.15, costOutPerMtok: 0.47, cachedInPerMtok: 0.016, cacheWritePerMtok: 0.2, codingPlan: true },
  { ...flagship, id: 'qwen3.8-omni-flash', displayName: 'Qwen3.8 Omni Flash', efforts: QWEN_EFFORTS, costInPerMtok: 0.15, costOutPerMtok: 0.47, cachedInPerMtok: 0.016 },
  { ...flagship, id: 'qwen3.7-flash', displayName: 'Qwen3.7 Flash', costInPerMtok: 0.03, costOutPerMtok: 0.13, cachedInPerMtok: 0.006, cacheWritePerMtok: 0.038 },
  { ...flagship, id: 'qwen3.6-flash', displayName: 'Qwen3.6 Flash', outputMax: 65_536, preservesThinking: false, costInPerMtok: 0.25, costOutPerMtok: 1.5, cachedInPerMtok: 0.025, cacheWritePerMtok: 0.3125, codingPlan: true },
  { id: 'qwen3-coder-flash', displayName: 'Qwen3 Coder Flash', contextWindow: 1_000_000, outputMax: 65_536, costInPerMtok: 0.3, costOutPerMtok: 1.5, cachedInPerMtok: 0.06, cacheWritePerMtok: 0.375, thinking: 'none', preservesThinking: false, efforts: [], images: false },
  { id: QWEN_CODING_PLAN_ROUTER_ID, wireId: 'auto', displayName: 'Auto (the Coding Plan picks the model)', thinking: 'hybrid', preservesThinking: false, efforts: [], images: false, codingPlan: true, codingPlanOnly: true },
  { id: QWEN_PLAN_MODEL_ID, displayName: 'Qwen Coder (Qwen account plan)', contextWindow: 1_000_000, outputMax: 65_536, thinking: 'none', preservesThinking: false, efforts: [], images: false, planOnly: true },
]

export function qwenPinsFor(scope: QwenPinScope): readonly QwenDisplayPin[] {
  if (scope === 'account-plan') return QWEN_DISPLAY_PINS.filter(pin => pin.planOnly === true)
  if (scope === 'coding-plan') return QWEN_DISPLAY_PINS.filter(pin => pin.codingPlan === true)
  return QWEN_DISPLAY_PINS.filter(pin => pin.planOnly !== true && pin.codingPlanOnly !== true)
}

export function qwenPinWireId(id: string): string {
  const pin = qwenDisplayPin(id)
  return pin?.wireId ?? pin?.id ?? bareId(id)
}

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

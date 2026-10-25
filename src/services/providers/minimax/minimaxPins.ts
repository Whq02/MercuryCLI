export const MINIMAX_OBSERVED_AT = '2026-10-17'
const MINIMAX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type MinimaxThinkingDial = 'tunable' | 'toggle' | 'fixed'

interface MinimaxDisplayPin {
  id: string
  wireId: string
  displayName: string
  observedAt: string
  contextWindow: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
  cacheWritePerMtok?: number
  longContextThreshold?: number
  longContext?: { costInPerMtok: number; costOutPerMtok: number; cachedInPerMtok?: number }
  thinking: MinimaxThinkingDial
  efforts: readonly string[]
  tools: boolean
  images: boolean
  planOnly?: boolean
}

const m3 = { observedAt: MINIMAX_OBSERVED_AT, contextWindow: 1_000_000, outputMax: 524_288, tools: true, images: true } as const
const m2 = { observedAt: MINIMAX_OBSERVED_AT, contextWindow: 204_800, outputMax: 204_800, tools: true, images: false, thinking: 'fixed' as const, efforts: [] as readonly string[] }

export const MINIMAX_DISPLAY_PINS: readonly MinimaxDisplayPin[] = [
  { ...m3, id: 'minimax-m3', wireId: 'MiniMax-M3', displayName: 'MiniMax M3', thinking: 'toggle', efforts: [],
    costInPerMtok: 0.3, costOutPerMtok: 1.2, cachedInPerMtok: 0.06, longContextThreshold: 512_000, longContext: { costInPerMtok: 0.6, costOutPerMtok: 2.4, cachedInPerMtok: 0.12 } },
  { id: 'minimax-m3.1-flash', wireId: 'MiniMax-M3.1-Flash', displayName: 'MiniMax M3.1 Flash', observedAt: '2026-10-25', contextWindow: 1_000_000, tools: true, images: true, thinking: 'tunable', efforts: MINIMAX_EFFORTS },
  { ...m3, id: 'minimax-m3.1-flash-preview', wireId: 'MiniMax-M3.1-Flash-Preview', displayName: 'MiniMax M3.1 Flash (preview, M Plan)', thinking: 'tunable', efforts: MINIMAX_EFFORTS, planOnly: true },
  { ...m2, id: 'minimax-m2.7', wireId: 'MiniMax-M2.7', displayName: 'MiniMax M2.7', costInPerMtok: 0.3, costOutPerMtok: 1.2, cachedInPerMtok: 0.06, cacheWritePerMtok: 0.375 },
  { ...m2, id: 'minimax-m2.7-highspeed', wireId: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed', costInPerMtok: 0.6, costOutPerMtok: 2.4, cachedInPerMtok: 0.06, cacheWritePerMtok: 0.375 },
  { ...m2, id: 'minimax-m2.5', wireId: 'MiniMax-M2.5', displayName: 'MiniMax M2.5', costInPerMtok: 0.3, costOutPerMtok: 1.2, cachedInPerMtok: 0.03, cacheWritePerMtok: 0.375 },
  { ...m2, id: 'minimax-m2.5-highspeed', wireId: 'MiniMax-M2.5-highspeed', displayName: 'MiniMax M2.5 Highspeed', costInPerMtok: 0.6, costOutPerMtok: 2.4, cachedInPerMtok: 0.03, cacheWritePerMtok: 0.375 },
]

function bareId(id: string): string {
  return id.trim().toLowerCase().replace(/\[(?:[0-9]+m|served)\]/gi, '')
}

export function isMinimaxModelId(model: string): boolean {
  const id = bareId(model)
  return id === 'minimax' || id.startsWith('minimax-')
}

export function isMinimaxTextModelId(model: string): boolean {
  return /^minimax-m\d/.test(bareId(model))
}

export function minimaxDisplayPin(id: string): MinimaxDisplayPin | undefined {
  const bare = bareId(id)
  return MINIMAX_DISPLAY_PINS.find(pin => pin.id === bare)
}

export function minimaxDisplayName(id: string): string {
  return minimaxDisplayPin(id)?.displayName ?? id
}

function minimaxAcceptsEffort(model: string, effort: string): boolean {
  return minimaxDisplayPin(model)?.efforts.includes(effort) === true
}

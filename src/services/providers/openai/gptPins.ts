

export const GPT_SERVED_WINDOW_SUFFIX = '[served]'
const TRAILING_SERVED_RE = /\[served\]$/i
const ANY_SERVED_RE = /\[served\]/gi

export function hasGptServedWindowSuffix(id: string): boolean {
  return TRAILING_SERVED_RE.test(id.trim())
}

export function withGptServedWindowSuffix(id: string): string {
  if (TRAILING_SERVED_RE.test(id.trim())) return id
  return `${id}${GPT_SERVED_WINDOW_SUFFIX}`
}

export function stripGptServedWindowSuffix(id: string): string {
  return id.replace(ANY_SERVED_RE, '')
}


export interface GptModelIdentity {
  family: 'gpt'
  major: number
  minor: number
  variant: string
  canonicalId: string
}

export function parseGptModelId(id: string): GptModelIdentity | undefined {
  const trimmed = stripGptServedWindowSuffix(id).trim().toLowerCase()
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-([a-z0-9][a-z0-9-]*))?$/.exec(trimmed)
  if (!match) return undefined
  const major = Number(match[1])
  const minor = match[2] !== undefined ? Number(match[2]) : 0
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined
  return {
    family: 'gpt',
    major,
    minor,
    variant: match[3] ?? '',
    canonicalId: trimmed,
  }
}


export const WIRE_EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
}

export function nearestSupportedWireEffort(
  requested: string,
  supported: readonly string[],
): string | undefined {
  const want = WIRE_EFFORT_RANK[requested]
  if (want === undefined) return undefined
  const ranked = supported
    .filter(level => WIRE_EFFORT_RANK[level] !== undefined)
    .sort((a, b) => WIRE_EFFORT_RANK[a]! - WIRE_EFFORT_RANK[b]!)
  if (ranked.length === 0) return undefined
  let best: string | undefined
  for (const level of ranked) {
    if (WIRE_EFFORT_RANK[level]! <= want) best = level
  }
  return best ?? ranked[0]
}


export interface GptDisplayPin {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
  cacheWritePerMtok?: number
  knowledgeCutoff?: string
  availabilityNote?: string
  longContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number }
}

export function gptPriceTierFor(
  pin: GptDisplayPin,
  promptTokens: number | undefined,
): Pick<GptDisplayPin, 'costInPerMtok' | 'costOutPerMtok' | 'cachedInPerMtok' | 'cacheWritePerMtok'> {
  const base = {
    ...(pin.costInPerMtok !== undefined ? { costInPerMtok: pin.costInPerMtok } : {}),
    ...(pin.costOutPerMtok !== undefined ? { costOutPerMtok: pin.costOutPerMtok } : {}),
    ...(pin.cachedInPerMtok !== undefined ? { cachedInPerMtok: pin.cachedInPerMtok } : {}),
    ...(pin.cacheWritePerMtok !== undefined ? { cacheWritePerMtok: pin.cacheWritePerMtok } : {}),
  }
  const rule = pin.longContext
  if (rule === undefined || promptTokens === undefined || !(promptTokens > rule.aboveInputTokens)) return base
  return {
    ...(base.costInPerMtok !== undefined ? { costInPerMtok: base.costInPerMtok * rule.inputMultiplier } : {}),
    ...(base.costOutPerMtok !== undefined ? { costOutPerMtok: base.costOutPerMtok * rule.outputMultiplier } : {}),
    ...(base.cachedInPerMtok !== undefined ? { cachedInPerMtok: base.cachedInPerMtok * rule.inputMultiplier } : {}),
    ...(base.cacheWritePerMtok !== undefined ? { cacheWritePerMtok: base.cacheWritePerMtok * rule.inputMultiplier } : {}),
  }
}

export const GPT_DISPLAY_PINS: readonly GptDisplayPin[] = [
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    observedAt: '2026-09-04',
    contextWindow: 1_050_000,
    outputMax: 128_000,
    costInPerMtok: 10,
    costOutPerMtok: 50,
    cachedInPerMtok: 1,
    cacheWritePerMtok: 12.5,
    knowledgeCutoff: '2026-04-30',
    longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    observedAt: '2026-09-05',
    contextWindow: 1_050_000,
    outputMax: 128_000,
    costInPerMtok: 4,
    costOutPerMtok: 20,
    cachedInPerMtok: 0.4,
    cacheWritePerMtok: 5,
    knowledgeCutoff: '2026-02-16',
    longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    observedAt: '2026-09-05',
    contextWindow: 1_050_000,
    outputMax: 128_000,
    costInPerMtok: 2,
    costOutPerMtok: 12,
    cachedInPerMtok: 0.2,
    cacheWritePerMtok: 2.5,
    longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    observedAt: '2026-09-05',
    contextWindow: 1_050_000,
    outputMax: 128_000,
    costInPerMtok: 0.2,
    costOutPerMtok: 1.2,
    cachedInPerMtok: 0.02,
    cacheWritePerMtok: 0.25,
    knowledgeCutoff: '2026-02-16',
    longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    observedAt: '2026-07-17',
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    observedAt: '2026-07-17',
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    observedAt: '2026-07-17',
  },
  {
    id: 'gpt-5.3-codex-spark',
    displayName: 'GPT-5.3 Codex Spark',
    observedAt: '2026-07-17',
    availabilityNote: 'ChatGPT Pro only (research preview)',
  },
]

export function gptDisplayPin(id: string): GptDisplayPin | undefined {
  const lower = stripGptServedWindowSuffix(id).trim().toLowerCase()
  return GPT_DISPLAY_PINS.find(p => p.id === lower)
}

export function gptDisplayName(id: string): string | undefined {
  const pin = gptDisplayPin(id)
  if (pin) return pin.displayName
  const identity = parseGptModelId(id)
  if (!identity) return undefined
  const variant = identity.variant
    ? ` ${identity.variant.charAt(0).toUpperCase()}${identity.variant.slice(1)}`
    : ''
  return `GPT-${identity.major}${identity.minor ? `.${identity.minor}` : ''}${variant}`
}

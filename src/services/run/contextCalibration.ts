
export const CODEC_EPOCHS = Object.freeze({
  anthropic: 1,
  openai: 1,
  zai: 1,
  moonshot: 1,
  deepseek: 1,
  'openai-compat': 1,
  openrouter: 1,
  gemini: 1,
  huggingface: 1,
  local: 1,
} as const)

export type CalibrationRoute = keyof typeof CODEC_EPOCHS

export const BASE_CHARS_PER_TOKEN = 4

export function calibrationKeyFor(route: CalibrationRoute | 'unrecognised', model: string): string {
  const epoch = CODEC_EPOCHS[route === 'unrecognised' ? 'anthropic' : route]
  return `${route}:${model}:c${epoch}`
}

export type CalibrationRead =
  | { calibrated: true; ratio: number; samples: number }
  | { calibrated: false }

interface CalibrationAggregate {
  ratio: number
  samples: number
}

export const MAX_CALIBRATION_KEYS = 64
const EMA_ALPHA = 0.2

const aggregates = new Map<string, CalibrationAggregate>()

export function calibrationFor(key: string): CalibrationRead {
  const a = aggregates.get(key)
  return a ? { calibrated: true, ratio: a.ratio, samples: a.samples } : { calibrated: false }
}

export function noteMeasuredUsage(
  key: string,
  estimatedTokens: number,
  measuredTokens: number,
): void {
  if (!(estimatedTokens > 0) || !(measuredTokens > 0)) return
  const observed = measuredTokens / estimatedTokens
  const existing = aggregates.get(key)
  if (existing) {
    existing.ratio = existing.ratio * (1 - EMA_ALPHA) + observed * EMA_ALPHA
    existing.samples++
    return
  }
  if (aggregates.size >= MAX_CALIBRATION_KEYS) {
    const oldest = aggregates.keys().next().value as string | undefined
    if (oldest !== undefined) aggregates.delete(oldest)
  }
  aggregates.set(key, { ratio: observed, samples: 1 })
}

export function estimateTokensFromChars(chars: number, cal: CalibrationRead): number {
  const base = chars / BASE_CHARS_PER_TOKEN
  return Math.ceil(cal.calibrated ? base * cal.ratio : base)
}

export function resetCalibration(): void {
  aggregates.clear()
}

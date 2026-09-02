// ============================================================================
//  run/contextCalibration — provider/model/codec-epoch-keyed token
//  calibration.
//
//  Token estimates for the request-context plan start from the base
//  chars-per-token heuristic and are RECONCILED against measured usage
//  after settlement (the turn machine reconciles the FIRST call of a turn
//  — the one whose request is the plan's view). Laws:
//
//    · keyed by provider route + model + CODEC EPOCH: a codec revision that
//      changes how messages encode invalidates old ratios — the epoch table
//      below MUST be bumped in the same change (a stale ratio would leak
//      across epochs silently). Absence of calibration data is TYPED
//      ({calibrated:false}); a read never falls back to another key.
//    · bounded: one decayed aggregate per key (EMA), keys hard-capped with
//      iterator-front eviction — no unbounded per-use log (the law).
// ============================================================================

/** Declared codec epochs per provider route. DUTY: bump the route's epoch
 *  in the SAME commit as a wire-shape change in its codec leaf
 *  (responsesBridge.ts · zaiCodec.ts · the anthropic native carry). */
export const CODEC_EPOCHS = Object.freeze({
  anthropic: 1,
  openai: 1,
  zai: 1,
  // Provider-08-21: the shared chat-completions codec (zaiCodec's
  // message mapping + compatChatClient) — one epoch each, bumped with any
  // wire-shape change in that leaf.
  moonshot: 1,
  deepseek: 1,
  'openai-compat': 1,
  // Fold seam: recognized routes whose runtimes land with the
  // auth lane — epoch 1 from recognition; the fold bumps on wire changes.
  openrouter: 1,
  gemini: 1,
  // The Hugging Face router and the local servers ride the same shared
  // chat-completions codec — epoch 1 from recognition.
  huggingface: 1,
  local: 1,
} as const)

export type CalibrationRoute = keyof typeof CODEC_EPOCHS

/** The base heuristic (chars per token) estimates start from. */
export const BASE_CHARS_PER_TOKEN = 4

export function calibrationKeyFor(route: CalibrationRoute | 'unrecognised', model: string): string {
  // A stranger id ('unrecognised' — no family declares it) keeps its honest
  // route word in the key (never the anthropic bucket), while its EPOCH is
  // the codec fact: the only transport such an id can ever ride is the
  // anthropic native carry (the earned gateway ride), so its estimates
  // recalibrate exactly when that codec's wire shape changes.
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

/** Hard cap on distinct calibration keys (bounded state — law). */
export const MAX_CALIBRATION_KEYS = 64
/** EMA weight of a new observation. */
const EMA_ALPHA = 0.2

const aggregates = new Map<string, CalibrationAggregate>()

/** Typed read — absence is explicit, never a cross-key/epoch fallback. */
export function calibrationFor(key: string): CalibrationRead {
  const a = aggregates.get(key)
  return a ? { calibrated: true, ratio: a.ratio, samples: a.samples } : { calibrated: false }
}

/** Reconcile one settled call: measured usage against the estimate the
 *  applied plan carried. Ratios fold as a bounded EMA per key. */
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

/** Estimate tokens for a character count under a calibration read: the
 *  base heuristic, scaled by the key's ratio when (and only when) the key
 *  is calibrated. */
export function estimateTokensFromChars(chars: number, cal: CalibrationRead): number {
  const base = chars / BASE_CHARS_PER_TOKEN
  return Math.ceil(cal.calibrated ? base * cal.ratio : base)
}

/** Proof hygiene: reset the aggregate store (provers only). */
export function resetCalibration(): void {
  aggregates.clear()
}

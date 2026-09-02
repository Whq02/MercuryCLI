// ============================================================================
//  providers/huggingface/huggingfacePins — the PURE Hugging Face id grammar +
//  the LAST-OBSERVED display pins. Zero imports BY DESIGN (the gptPins
//  convention): the capability edge, the wire, and the picker read the SAME
//  table, and low-level utils stay bun-loadable.
// ----------------------------------------------------------------------------
//  Identity: Hugging Face Inference Providers — one Hub token reaches the
//  open-weight models served by the partner providers through the router,
//  https://router.huggingface.co/v1 (OpenAI-compatible chat completions;
//  huggingface.co/docs/inference-providers/index, fetched).
//
//  The id grammar (the same page): the Hub slug `<org>/<model>`, optionally
//  followed by ONE `:`-suffix that chooses the backend — a provider name
//  (`:groq`, `:together`, …) or a routing policy (`:fastest` is the default,
//  `:cheapest`, `:preferred` follows the account's provider order). Mercury
//  persists `huggingface/<org>/<model>[:suffix]`; the namespace is detached at
//  the wire and the slug rides verbatim (case preserved — Hub slugs are
//  case-sensitive spellings).
//
//  Laws (the gptPins laws verbatim):
//    - THE LIVE ANSWER IS THE AUTHORITY where one exists. The router serves
//      GET /v1/models (huggingface.co/docs/inference-providers/hub-api,
//      fetched) — the catalogue module derives the lineup LIVE
//      and these pins are only the display/fixture FALLBACK while that fetch
//      is pending or failed; every entry carries observedAt and readers
//      present pin facts as observed-on-this-date, never as current.
//    - Never guessed, never invented — an absent field means "no official
//      fact recorded", never zero.
//  Source of the rows: the live GET https://router.huggingface.co/v1/models
//  answer fetched 2026-08-22 (131 models; the rows below are the flagship
//  set in the router's own ordering). Context = the largest context_length a
//  live provider stated; price floors = the LOWEST per-provider USD-per-
//  million prices stated that day (the router's default `:fastest` choice
//  may bill a higher listed provider — the floor is a floor, never a quote).
// ============================================================================

export const HUGGINGFACE_MODEL_PREFIX = 'huggingface/'

/** True iff this id rides the Hugging Face lane (the routing-law family). */
export function isHuggingfaceModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(HUGGINGFACE_MODEL_PREFIX)
}

/** Split a wire slug into the Hub model id and its optional router suffix
 *  (`openai/gpt-oss-120b:groq` → { hubId: 'openai/gpt-oss-120b', suffix:
 *  'groq' }). A bare slug has no suffix. The namespace must already be
 *  detached. */
export function splitHuggingfaceSlug(wireSlug: string): { hubId: string; suffix?: string } {
  const trimmed = wireSlug.trim()
  const colon = trimmed.lastIndexOf(':')
  // A suffix never contains '/', so a colon before the last '/' belongs to
  // the slug itself (no documented Hub slug does, but the rule is safe).
  if (colon === -1 || trimmed.indexOf('/', colon) !== -1) return { hubId: trimmed }
  const suffix = trimmed.slice(colon + 1)
  return suffix ? { hubId: trimmed.slice(0, colon), suffix } : { hubId: trimmed.slice(0, colon) }
}

/** The model part of a Hub slug ('deepseek-ai/DeepSeek-V4-Pro-0813' →
 *  'DeepSeek-V4-Pro-0813') — the label column's width is the org's cost;
 *  the full slug always rides the description beside it. */
export function huggingfaceSlugModelName(slug: string): string {
  const { hubId } = splitHuggingfaceSlug(slug.trim())
  const slash = hubId.lastIndexOf('/')
  return slash === -1 ? hubId : hubId.slice(slash + 1)
}

/** The documented routing-policy suffixes (not provider names). */
export const HUGGINGFACE_POLICY_SUFFIXES: ReadonlySet<string> = new Set(['fastest', 'cheapest', 'preferred'])

export interface HuggingfaceDisplayPin {
  /** The Hub slug exactly as the router lists it (`<org>/<model>`). */
  id: string
  displayName: string
  /** Date (YYYY-MM-DD) the entry's facts were last fetched from the live
   *  router catalogue. REQUIRED — a pin without a provenance date is a fake
   *  truth waiting to age. */
  observedAt: string
  /** The largest context_length a live provider stated that day. */
  contextWindow?: number
  /** Every live provider stated supports_tools that day. */
  supportsTools: boolean
  /** USD per million tokens — the LOWEST stated across providers. */
  priceFloorInPerMtok?: number
  priceFloorOutPerMtok?: number
}

export const HUGGINGFACE_DISPLAY_PINS: readonly HuggingfaceDisplayPin[] = [
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    displayName: 'DeepSeek V4 Pro (0813)',
    observedAt: '2026-08-22',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 1.32,
    priceFloorOutPerMtok: 3.96,
  },
  {
    id: 'Qwen/Qwen3.8-2.4T-A95B',
    displayName: 'Qwen3.8 2.4T-A95B',
    observedAt: '2026-08-22',
    contextWindow: 1_010_000,
    supportsTools: true,
    priceFloorInPerMtok: 2.5,
    priceFloorOutPerMtok: 6.25,
  },
  {
    id: 'moonshotai/Kimi-K3',
    displayName: 'Kimi K3',
    observedAt: '2026-08-22',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 2.85,
    priceFloorOutPerMtok: 14.25,
  },
  {
    id: 'zai-org/GLM-5.2',
    displayName: 'GLM-5.2',
    observedAt: '2026-08-22',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 0.75,
    priceFloorOutPerMtok: 2.4,
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    displayName: 'DeepSeek V4 Flash (0731)',
    observedAt: '2026-08-22',
    contextWindow: 1_048_576,
    supportsTools: true,
    priceFloorInPerMtok: 0.08,
    priceFloorOutPerMtok: 0.18,
  },
  {
    id: 'MiniMaxAI/MiniMax-M3',
    displayName: 'MiniMax M3',
    observedAt: '2026-08-22',
    contextWindow: 1_000_000,
    supportsTools: true,
    priceFloorInPerMtok: 0.28,
    priceFloorOutPerMtok: 1.1,
  },
  {
    id: 'Qwen/Qwen3.5-397B-A17B',
    displayName: 'Qwen3.5 397B-A17B',
    observedAt: '2026-08-22',
    contextWindow: 262_144,
    supportsTools: true,
    priceFloorInPerMtok: 0.45,
    priceFloorOutPerMtok: 3,
  },
  {
    id: 'openai/gpt-oss-120b',
    displayName: 'gpt-oss 120B',
    observedAt: '2026-08-22',
    contextWindow: 131_072,
    supportsTools: true,
    priceFloorInPerMtok: 0.037,
    priceFloorOutPerMtok: 0.17,
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code',
    displayName: 'Kimi K2.7 Code',
    observedAt: '2026-08-22',
    contextWindow: 262_144,
    supportsTools: true,
    priceFloorInPerMtok: 0.68,
    priceFloorOutPerMtok: 3.4,
  },
  {
    id: 'google/gemma-4-31B-it',
    displayName: 'Gemma 4 31B',
    observedAt: '2026-08-22',
    contextWindow: 262_144,
    supportsTools: true,
    priceFloorInPerMtok: 0.13,
    priceFloorOutPerMtok: 0.38,
  },
]

/** The pin for a Hub slug (case-insensitive match; the wire keeps the
 *  pin's own casing). Accepts a namespaced or suffixed spelling. */
export function huggingfaceDisplayPin(id: string): HuggingfaceDisplayPin | undefined {
  const raw = id.trim()
  const slug = isHuggingfaceModelId(raw) ? raw.slice(HUGGINGFACE_MODEL_PREFIX.length) : raw
  const { hubId } = splitHuggingfaceSlug(slug)
  const lower = hubId.toLowerCase()
  return HUGGINGFACE_DISPLAY_PINS.find(p => p.id.toLowerCase() === lower)
}

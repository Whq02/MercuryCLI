// ============================================================================
//  providers/moonshot/kimiPins — the PURE Kimi/Moonshot grammar + the
//  LAST-OBSERVED display pins. Zero imports BY
//  DESIGN (the gptPins convention): the capability edge, the wire, and the
//  picker rank from the SAME table, and low-level utils stay bun-loadable.
//
//  Provider identity, verified live: Kimi is MOONSHOT AI's model
//  line (the operator's "Alibaba" attribution was checked and is not what the
//  live sources say — Alibaba's line is Qwen). The API platform is
//  platform.kimi.ai (platform.moonshot.ai 301s onto it); the API base stays
//  https://api.moonshot.ai/v1. Mainland platform.moonshot.cn is a SEPARATE
//  console with separate keys — not modeled here.
//
//  Laws (the gptPins laws verbatim):
//    - THE LIVE ANSWER IS THE AUTHORITY where one exists. Moonshot documents
//      NO GET /v1/models list endpoint, so these pins are
//      the display/fixture record — every entry carries observedAt and
//      readers present pin facts as observed-on-this-date, never as current.
//    - Never guessed, never invented — an absent field means "no official
//      fact recorded", never zero.
//  Sources: platform.kimi.ai/docs/guide/kimi-k3-quickstart
//  and platform.kimi.ai/docs/api/chat (the LANE-RECEIPT carries the list).
// ============================================================================

/** True iff this id rides the Moonshot/Kimi lane (the routing-law family). */
export function isKimiModelId(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m === 'kimi' || m.startsWith('kimi-') || m.startsWith('moonshot-')
}

/** The documented reasoning_effort vocabulary — kimi-k3 (quickstart,
 *  observed; default 'max'; reasoning always enabled on K3). */
export const KIMI_EFFORT_MODELS: ReadonlySet<string> = new Set(['kimi-k3'])
export const KIMI_EFFORTS: ReadonlySet<string> = new Set(['low', 'high', 'max'])

/** True iff the documented vocabulary accepts `effort` for `model` — exactly
 *  the wire's send condition, consumed by the capability edge so display
 *  truth equals dispatch truth. */
export function kimiAcceptsEffort(model: string, effort: string): boolean {
  return KIMI_EFFORT_MODELS.has(model.trim().toLowerCase()) && KIMI_EFFORTS.has(effort)
}

/** kimi-k3 / kimi-k2.x fix their sampling (the chat API page states the
 *  temperature parameter only for the legacy moonshot-v1-* family) — the
 *  request builder must OMIT temperature/top_p for modern ids. */
export function kimiSupportsTemperature(model: string): boolean {
  return model.trim().toLowerCase().startsWith('moonshot-v1-')
}

export interface KimiDisplayPin {
  id: string
  displayName: string
  /** Date (YYYY-MM-DD) the entry's facts were last fetched from the official
   *  platform pages. REQUIRED — a pin without a provenance date is a fake
   *  truth waiting to age. */
  observedAt: string
  /** Stated only where the official pages state one; absent beats invented. */
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
}

// The lineup as last observed on the official chat API page + K3 quickstart
// kimi-k3: 1,048,576-token context;
// max output default 131072, raisable to 1048576; $3/M cache-miss input,
// $0.30/M cache-hit, $15/M output (flat, no context tiering). The K2.x rows
// are listed as served on the chat page with no windows stated there — those
// fields stay honestly absent. The legacy moonshot-v1-* family is served but
// not pinned as picker rows (previous-generation completion models).
/** Models whose Preserved Thinking is ALWAYS ON (platform.kimi.ai
 *  use-thinking-models, fetched): historical assistant
 *  reasoning_content must ride back in messages "as-is" — the docs mark it
 *  mandatory ("not optionally") for kimi-k2.7-code and state always-on for
 *  kimi-k3. kimi-k2.6 is the opt-in model (thinking.keep, which this wire
 *  does not send), so its documented default — history ignored, shorter
 *  context — governs and it stays OFF this list. */
export const KIMI_PRESERVED_THINKING_MODELS: ReadonlySet<string> = new Set([
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
])

export const KIMI_DISPLAY_PINS: readonly KimiDisplayPin[] = [
  {
    id: 'kimi-k3',
    displayName: 'Kimi K3',
    observedAt: '2026-08-21',
    contextWindow: 1_048_576,
    // The RAISABLE ceiling (the docs state max output default 131,072,
    // raisable to 1,048,576) — this field pins the ceiling, not the default.
    outputMax: 1_048_576,
    costInPerMtok: 3,
    costOutPerMtok: 15,
    cachedInPerMtok: 0.3,
  },
  {
    id: 'kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    observedAt: '2026-08-21',
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    displayName: 'Kimi K2.7 Code Highspeed',
    observedAt: '2026-08-21',
  },
  {
    id: 'kimi-k2.6',
    displayName: 'Kimi K2.6',
    observedAt: '2026-08-21',
  },
  {
    id: 'kimi-k2.5',
    displayName: 'Kimi K2.5',
    observedAt: '2026-08-21',
  },
]

export function kimiDisplayPin(id: string): KimiDisplayPin | undefined {
  const lower = id.trim().toLowerCase()
  return KIMI_DISPLAY_PINS.find(p => p.id === lower)
}

/** Display name for a Kimi id: the pin's, else a mechanical title
 *  ('kimi-k3' → 'Kimi K3'), else undefined for non-Kimi ids. */
export function kimiDisplayName(id: string): string | undefined {
  const pin = kimiDisplayPin(id)
  if (pin) return pin.displayName
  if (!isKimiModelId(id)) return undefined
  const lower = id.trim().toLowerCase()
  return lower
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

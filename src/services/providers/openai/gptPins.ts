// ============================================================================
//  providers/openai/gptPins — the PURE GPT grammar + the LAST-OBSERVED display
//  pins. Zero imports BY DESIGN: the selector estate (display,
//  context window, cost, seat validation) consumes THIS module, so low-level
//  utils stay bun-loadable and cycle-free; the catalogue owner
//  (openaiCatalogue.ts) re-exports everything here and layers the LIVE
//  qualification machinery on top.
//
//  Laws:
//    - THE LIVE CATALOGUE IS THE AUTHORITY. Which models exist, what they
//      serve, and what is selectable is the account source's answer at the
//      moment of asking — never this file's.
//    - STATIC PINS NEVER ACTIVATE — the pin table serves display, fixtures,
//      docs and cold-boot fallbacks only; selectability always comes from the
//      LIVE catalogue + qualification owner.
//    - EVERY PIN IS A LAST-OBSERVED RECORD, not an eternal fact: each entry
//      carries `observedAt` (the date its facts were fetched from the official
//      model pages).
//      Provider facts move;
//      before trusting or extending a pin, verify against the live source and
//      update `observedAt`. Never guessed, never invented — and never eternal.
// ============================================================================

// ── The Mercury window-choice annotation ───────
//
// The GPT window toggle persists EXACTLY like the Anthropic 1M toggle: as a
// bracketed annotation on the persisted model id (the one persistence owner —
// no side store). Polarity: a BARE gpt id budgets the account source's
// DECLARED ceiling when one exists;
// `<id>[served]` is the operator's explicit opt-DOWN onto the source's served
// default window. The annotation is Mercury client-side dressing — it must
// never reach the wire (normalizeModelStringForAPI strips it) and never
// change the id's GPT identity (parseGptModelId tolerates it).

export const GPT_SERVED_WINDOW_SUFFIX = '[served]'
const TRAILING_SERVED_RE = /\[served\]$/i
const ANY_SERVED_RE = /\[served\]/gi

/** True when the id carries the served-window opt-down annotation. */
export function hasGptServedWindowSuffix(id: string): boolean {
  return TRAILING_SERVED_RE.test(id.trim())
}

/** Apply the served-window annotation (idempotent). */
export function withGptServedWindowSuffix(id: string): string {
  if (TRAILING_SERVED_RE.test(id.trim())) return id
  return `${id}${GPT_SERVED_WINDOW_SUFFIX}`
}

/** Remove the served-window annotation (global, case-insensitive). */
export function stripGptServedWindowSuffix(id: string): string {
  return id.replace(ANY_SERVED_RE, '')
}

// ── Family/generation grammar (brief: a REAL parser, not a regex vibe) ───

export interface GptModelIdentity {
  family: 'gpt'
  major: number
  minor: number
  /** Tier/variant suffix ('sol' | 'terra' | 'luna' | 'codex-spark' | '' …). */
  variant: string
  canonicalId: string
}

/** Parse a GPT model id per the current naming grammar
 *  `gpt-<major>[.<minor>][-<variant…>]`. Returns undefined for non-GPT ids
 *  and for shapes the grammar does not understand (never a guess). Mercury's
 *  window-choice annotation (`[served]`) is dressing, not identity — it is
 *  detached before matching, and `canonicalId` is always the bare wire id. */
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

// The "GPT_PRIMARY_FLOOR" (≥5.6) and its comparator are DELETED
// the era ruling contradicted the standing
// provider-parity direction that the FULL account-served GPT
// catalogue is selectable. No live-verifiable API constraint backs a
// generation gate — what the account source serves and shows IS the
// qualification law (openaiCatalogue.ts).

// ── Wire-effort ordering ──────

/** The observed wire-effort ORDER.
 *  Mercury's own ladder (low…max) embeds in it, so a requested level that is
 *  not in a model's vocabulary resolves to the DEEPEST supported level at or
 *  below the request — never the model default (which can silently LOWER a
 *  raised effort). Owned HERE (the pure grammar module) so the capability
 *  edge, the effort-policy owner and the reasoning-profile wire all rank from
 *  the SAME table — a second copy is the display/dispatch-divergence class. */
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

/** Nearest supported level at-or-below `requested`; the vocabulary floor when
 *  the request ranks below everything; undefined when nothing is rankable. */
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

// ── Display pins (NEVER activate; last-observed official-page facts) ────────

export interface GptDisplayPin {
  id: string
  displayName: string
  /** Date (YYYY-MM-DD) the entry's facts were last fetched from the official
   *  model pages. REQUIRED: a pin without a provenance date is a fake truth
   *  waiting to age. UI/readers presenting a pin fact where live truth is
   *  absent should present it as observed-on-this-date, not as current. */
  observedAt: string
  /** Last-observed model-page facts — display + fixture material only. Every
   *  field below is stated ONLY where the repo holds a fetched receipt
   * an absent
   *  field means "no official fact recorded", never zero — consumers fall to
   *  their honest defaults instead of an invented number. The live account
   *  catalogue overrides every one of these at runtime. */
  contextWindow?: number
  outputMax?: number
  costInPerMtok?: number
  costOutPerMtok?: number
  cachedInPerMtok?: number
  /** Verified knowledge-cutoff display string — omitted when not recorded
   *  (absent beats fabricated). */
  knowledgeCutoff?: string
  /** Official availability caveat from the models page (e.g. a research
   *  preview restricted to one plan) — display copy for unavailable rows. */
  availabilityNote?: string
}

// The lineup as last observed on the official models page (learn.chatgpt.com/
// docs/models, fetched — recorded provider
// research.md) + the 5.6 model pages. Deprecated
// ids (gpt-5.2, gpt-5.3-codex) were not current at observation and never
// enter this table. This is a CACHE of that observation, not the catalogue:
// the account source's live answer decides what actually exists and serves
// today. To refresh: re-fetch the official pages, update facts + observedAt.
export const GPT_DISPLAY_PINS: readonly GptDisplayPin[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    observedAt: '2026-07-21',
    contextWindow: 1_050_000,
    outputMax: 128_000,
    costInPerMtok: 5,
    costOutPerMtok: 30,
    cachedInPerMtok: 0.5,
    knowledgeCutoff: '2026-02-16',
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    observedAt: '2026-07-21',
    contextWindow: 1_050_000,
    outputMax: 128_000,
    costInPerMtok: 2.5,
    costOutPerMtok: 15,
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    observedAt: '2026-07-21',
    contextWindow: 1_050_000,
    outputMax: 128_000,
    costInPerMtok: 1,
    costOutPerMtok: 6,
  },
  // Previous-generation + smaller tiers: current per the models page at
  // observation; the page stated no window/output/pricing the repo has
  // receipts for, so those fields stay honestly absent (live account truth
  // still governs windows).
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

/** Display name for a GPT id: the official pin's, else a mechanical title
 *  from the parsed grammar ('gpt-5.7-nova' → 'GPT-5.7 Nova'), else undefined
 *  for non-GPT ids (callers fall through to their own defaults). */
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

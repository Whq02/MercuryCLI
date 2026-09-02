// ============================================================================
//  providers/idSpaces — the provider id-space DATA and its pure predicates
//  (dependency-free leaf).
//
//  This is the ONE table routeLaw's recognition law walks (routeLaw re-exports
//  it — services-side consumers keep that seam), split into a leaf so the
//  utils-layer model-truth modules (canonicalization, capability predicates,
//  picker option grammar) can ask "is this id inside a reserved provider
//  namespace?" without importing the routing law's module graph. An id inside
//  a qualified namespace carries the VENDOR's identity: it must never
//  substring-join onto a first-party canonical, never grow Mercury context
//  dressing, and its wire form is owned by canonicalWireModelId (routeLaw).
// ============================================================================
//
//  THE HOME LANE IS A DECLARED FAMILY TOO (the ride
//  made earned-only by the operator's neutrality ruling): the
//  first-party id space is spelled at the foot of this file like every other
//  family's, so an id that matches NO declaration is recognised as exactly
//  that — 'unrecognised' — rather than silently classed first-party because
//  first-party happened to be the routing law's remainder. The one
//  classifier is classifyModelRoute below (absence and unknownness are
//  first-class verdicts, built on this recognition); the remainder-era
//  resolveCallModelRoute is retired. The RIDE is homeLaneAdmission's: an
//  unrecognised id reaches the home wire only on an operator-owned fact —
//  an ANTHROPIC_* model pin (recognition then says first-party/env-pin), or
//  a gateway base URL (the operator named the endpoint) — and refuses
//  typed, before any HTTP, with neither. Recognition is what the refusal
//  surfaces read, so an unresolvable id names itself.
import { MODEL_ALIASES } from '../../utils/model/aliases.js'

export type CallModelRoute =
  | 'anthropic'
  | 'zai'
  | 'openai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'

/** One provider family's id-space declaration (see routeLaw's header). */
export interface ProviderIdSpace {
  route: Exclude<CallModelRoute, 'anthropic'>
  /** Reserved qualified namespace ('compat/' · 'openrouter/') — checked
   *  FIRST; detached before the wire (routeLaw.qualifiedWireId). */
  qualifiedPrefix?: string
  /** Native bare-id prefixes ('kimi-', 'glm-', …). */
  barePrefixes?: readonly string[]
  /** Bare class aliases ('kimi', 'glm', …). */
  bareAliases?: readonly string[]
  /** The family's INNER-slug grammar after the namespace detaches:
   *  'segments-2' — exactly two non-empty /-segments (openrouter's
   *  vendor/model, the Hub's org/model; a ':variant' suffix rides the last
   *  segment); 'named' — the operator's/server's own naming, structurally
   *  unchecked apart from Mercury annotations and self-nesting. Families
   *  without a qualified prefix carry none. */
  innerGrammar?: 'segments-2' | 'named'
}

/** The ONE id-space table (data, not arms — the fold seam adds rows). */
export const PROVIDER_ID_SPACES: readonly ProviderIdSpace[] = [
  { route: 'openai-compat', qualifiedPrefix: 'compat/', innerGrammar: 'named' },
  { route: 'openrouter', qualifiedPrefix: 'openrouter/', innerGrammar: 'segments-2' },
  // huggingface/<org>/<model>[:provider|:policy] — the Hub's own slug plus the
  // router's optional backend suffix ride verbatim after the namespace;
  // local/<model> — a model name as the discovered local server lists it
  // (Ollama names carry dots, colons and slashes — structurally unchecked).
  { route: 'huggingface', qualifiedPrefix: 'huggingface/', innerGrammar: 'segments-2' },
  { route: 'local', qualifiedPrefix: 'local/', innerGrammar: 'named' },
  { route: 'zai', barePrefixes: ['glm-'], bareAliases: ['glm'] },
  { route: 'openai', barePrefixes: ['gpt-'], bareAliases: ['gpt'] },
  { route: 'moonshot', barePrefixes: ['kimi-', 'moonshot-'], bareAliases: ['kimi'] },
  { route: 'deepseek', barePrefixes: ['deepseek-'], bareAliases: ['deepseek'] },
  { route: 'gemini', barePrefixes: ['gemini-'], bareAliases: ['gemini'] },
]

/** The operator-named OpenAI-compatible slot's namespace (compat spelling —
 *  kept as a named constant; readers of the generic table don't need it). */
export const COMPAT_MODEL_PREFIX = 'compat/'

/** The declaring space when the id sits inside a reserved qualified
 *  namespace, else undefined. Trim/lowercase only — deliberately NO
 *  annotation normalization: this is a namespace test, not a resolution. */
export function qualifiedIdSpaceOf(model: string): ProviderIdSpace | undefined {
  const lowered = model.trim().toLowerCase()
  return PROVIDER_ID_SPACES.find(
    space => space.qualifiedPrefix !== undefined && lowered.startsWith(space.qualifiedPrefix),
  )
}

/** True when the id sits inside any reserved qualified provider namespace —
 *  the guard the first-party model-truth joins (canonical fold, future-
 *  catalog match, 1M-support, context toggle) check FIRST: a carrier id's
 *  identity is the vendor's, never a first-party model's. */
export function isQualifiedProviderId(model: string): boolean {
  return qualifiedIdSpaceOf(model) !== undefined
}

/** True for any carrier-shaped id: a reserved qualified namespace OR a bare
 *  vendor slug ('anthropic/claude-opus-5' · 'openai/gpt-5.6-sol' — a
 *  catalogue row spelled without its carrier prefix). No first-party
 *  Anthropic id contains '/', so a path separator anywhere marks the string
 *  foreign to every first-party identity join — the live class this closes:
 *  a bare vendor slug containing a first-party family word substring-joined
 *  onto our canonical and grew Mercury's [1m] dressing. */
export function isCarrierShapedId(model: string): boolean {
  return model.includes('/') || qualifiedIdSpaceOf(model) !== undefined
}

// ── the first-party id space ────────────────────────────────────────────────

/** Every first-party id carries this mark — anywhere in the id, so the
 *  gateway spellings ('anthropic.claude-…', 'us.anthropic.claude-…') stay
 *  inside the family. */
export const FIRST_PARTY_ID_MARK = 'claude-'

/** The bare setting spellings the first-party resolver accepts: the alias
 *  vocabulary (context riders detached) plus the two point-release
 *  spellings parseUserSpecifiedModel also resolves. */
const FIRST_PARTY_ALIASES: ReadonlySet<string> = new Set([
  ...MODEL_ALIASES.map(alias => alias.replace(/\[1m\]$/i, '')),
  'sonnet5',
  'opus5',
])

/** The env pins whose VALUE is, by the pin's own name, a first-party lane
 *  id — whatever the operator wrote there (a gateway-served spelling
 *  included) is theirs to name for this lane. */
export const FIRST_PARTY_MODEL_ENV_PINS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
] as const

// Mercury's client-side context annotations — the same shape routeLaw and
// model.ts spell; duplicated here because this leaf imports neither.
const ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

export type ModelIdRecognition =
  /** Inside a declared non-first-party family's id space. */
  | { kind: 'declared'; route: Exclude<CallModelRoute, 'anthropic'> }
  /** Inside the first-party id space, and how it got there. */
  | { kind: 'first-party'; why: 'claude-mark' | 'alias' | 'env-pin'; envPin?: string }
  /** A bare vendor slug ('anthropic/claude-opus-5', 'qwen/qwen3-coder')
   *  outside every qualified namespace — a catalogue row spelled without
   *  its carrier; the wire-id owner refuses it on every bare lane. */
  | { kind: 'carrier-shaped' }
  /** No family declares it. The routing law still classes it home (the
   *  total classifier's remainder), but the home-lane admission
   *  (homeLaneAdmission.ts) refuses it before any wire unless the home
   *  lane is re-pointed at a gateway — the endpoint then owns its ids. */
  | { kind: 'unrecognised' }

/**
 * Recognise a model id against EVERY declared id space, the first-party one
 * included. Pure over (id, env); the declared families are checked in the
 * routing law's own order (qualified namespaces, then bare spellings), so
 * recognition and routing can never disagree about a declared family.
 */
export function recognizeModelId(
  model: string,
  env: Record<string, string | undefined> = process.env,
): ModelIdRecognition {
  const bare = model.trim().replace(ANNOTATION_RE, '')
  const lowered = bare.toLowerCase()
  const qualified = qualifiedIdSpaceOf(lowered)
  if (qualified !== undefined) return { kind: 'declared', route: qualified.route }
  for (const space of PROVIDER_ID_SPACES) {
    if (space.bareAliases?.includes(lowered)) return { kind: 'declared', route: space.route }
    if (space.barePrefixes?.some(prefix => lowered.startsWith(prefix))) {
      return { kind: 'declared', route: space.route }
    }
  }
  if (lowered.includes('/')) return { kind: 'carrier-shaped' }
  for (const pin of FIRST_PARTY_MODEL_ENV_PINS) {
    const value = env[pin]?.trim().replace(ANNOTATION_RE, '').toLowerCase()
    if (value !== undefined && value !== '' && value === lowered) {
      return { kind: 'first-party', why: 'env-pin', envPin: pin }
    }
  }
  if (FIRST_PARTY_ALIASES.has(lowered)) return { kind: 'first-party', why: 'alias' }
  if (lowered.includes(FIRST_PARTY_ID_MARK)) return { kind: 'first-party', why: 'claude-mark' }
  return { kind: 'unrecognised' }
}

// ── the honest route verdict (the operator's phase-2 neutrality ruling) ─────

/** The classifier's full truth: a DECLARED ride (a provider family's own id
 *  space, the first-party space included — the why names the earned fact),
 *  an id NO family declares (carrierShaped marks a bare vendor slug outside
 *  every qualified namespace), or ABSENCE (no id at all — '' / undefined).
 *  Absence and unknownness are first-class and DISTINCT: neither is any
 *  family's remainder. */
export type ModelRouteVerdict =
  | { kind: 'route'; route: CallModelRoute; why?: 'claude-mark' | 'alias' | 'env-pin' }
  | { kind: 'unrecognised'; carrierShaped: boolean }
  | { kind: 'absence' }

/**
 * The ONE total honest classifier — built ON recognizeModelId, so
 * recognition and routing are one law and cannot disagree by construction.
 * Every id that routes to a family routes exactly as the RETIRED
 * remainder-era law routed it; the ids that law silently classed home name
 * themselves ('unrecognised'), and no-id-at-all names itself ('absence').
 */
export function classifyModelRoute(
  model: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ModelRouteVerdict {
  if (model === undefined || model.trim() === '') return { kind: 'absence' }
  const recognition = recognizeModelId(model, env)
  switch (recognition.kind) {
    case 'declared':
      return { kind: 'route', route: recognition.route }
    case 'first-party':
      return { kind: 'route', route: 'anthropic', why: recognition.why }
    case 'carrier-shaped':
      return { kind: 'unrecognised', carrierShaped: true }
    case 'unrecognised':
      return { kind: 'unrecognised', carrierShaped: false }
  }
}

/** Every declared id space in one operator-readable line — the vocabulary
 *  a refusal names beside an unrecognised id, derived from the table so a
 *  new family joins the sentence with its row. */
export function declaredIdSpacesLine(): string {
  const families = PROVIDER_ID_SPACES.map(space =>
    space.qualifiedPrefix !== undefined
      ? `${space.qualifiedPrefix}…`
      : (space.barePrefixes ?? []).map(prefix => `${prefix}*`).join('/'),
  )
  return [`${FIRST_PARTY_ID_MARK}* (and the opus/sonnet/haiku/fable aliases)`, ...families].join(' · ')
}

/** The one spelling of "no family declares this id" — the head of every
 *  refusal that names an unrecognised id (the surfaces append their own
 *  remedy); the tail names the two operator-owned roads onto the home
 *  wire, because without one of them the id does not ride at all. Never a
 *  secret, never a guess at a family. */
export function unrecognisedModelIdReason(model: string): string {
  return `'${model.trim()}' is not a model id any provider family declares (${declaredIdSpacesLine()}); only an operator-owned fact puts it on the home wire — an ANTHROPIC_* model pin naming it, or ANTHROPIC_BASE_URL re-pointed at a gateway that serves it`
}

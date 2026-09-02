// ============================================================================
//  providers/routeLaw — the PURE model→provider routing law,
// split out of callModelRouter so light modules — the capability
//  edge, pins consumers, permission gates — read the SAME law without pulling
//  the runtime graph in).
//
//  ONE provider-generic recognition seam:
//  every provider family declares its ID SPACE in ONE table — a reserved
//  QUALIFIED namespace ('<family>/…', stripped before the wire) and/or its
//  native BARE spellings (prefixes + class aliases). classifyModelRoute
//  walks the declarations (qualified namespaces first — they are reserved
//  words and can never be shadowed by a bare prefix), so a new family is one
//  DATA row, never a bespoke arm. /submodels and the reroute lane read the
//  same table.
//
//  The current declarations:
//    glm-* (+'glm')                 → 'zai'
//    gpt-* (+'gpt')                 → 'openai'
//    kimi-* · moonshot-* (+'kimi')  → 'moonshot'
//    deepseek-* (+'deepseek')       → 'deepseek'
//    compat/<vendor-id>             → 'openai-compat'   (qualified; stripped)
//    openrouter/<vendor-slug>       → 'openrouter'      (qualified; stripped —
//        OpenRouter's ids are themselves vendor/model slugs, so ONLY a
//        qualified namespace disambiguates them from the compat slot; the
//        persisted spelling is openrouter/<full-slug>, e.g.
//        openrouter/qwen/qwen3-coder → wire 'qwen/qwen3-coder' and
//        openrouter/openrouter/auto → wire 'openrouter/auto')
//    gemini-* (+'gemini')           → 'gemini'
//    everything else                → NOTHING. There is no remainder (the
//        operator's phase-2 neutrality ruling): classifyModelRoute answers
//        'unrecognised' for an id no family declares and 'absence' for no
//        id at all — neither is any family's leftover, and no consumer maps
//        either back to a family. The first-party space is a declared
//        family like every other (claude-mark · aliases · ANTHROPIC_* env
//        pins, via recognizeModelId). The RIDE of a stranger is
//        homeLaneAdmission's: refused before any HTTP unless an
//        operator-owned fact carries it — an ANTHROPIC_* model pin, or a
//        gateway base URL.
//
//  Every declared route has a live runtime in callModelRouter (the
//  openrouter and gemini lanes ride the shared compat chat runtime) —
//  recognition is THIS table's fact, dispatch is the runtime's, and an
//  unrecognized id never falls through to another provider (NO
//  cross-provider fallback) nor rides the home lane by remainder alone.
// ============================================================================
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  classifyModelRoute,
  COMPAT_MODEL_PREFIX,
  PROVIDER_ID_SPACES,
  qualifiedIdSpaceOf,
  type CallModelRoute,
  type ModelRouteVerdict,
  type ProviderIdSpace,
} from './idSpaces.js'

// The id-space DATA lives in ./idSpaces.ts (a dependency-free leaf the
// utils-layer model-truth modules read too); this module stays the public
// routing-law seam, so the table and its types re-export here.
export {
  classifyModelRoute,
  COMPAT_MODEL_PREFIX,
  PROVIDER_ID_SPACES,
  isQualifiedProviderId,
  qualifiedIdSpaceOf,
  type CallModelRoute,
  type ModelRouteVerdict,
  type ProviderIdSpace,
} from './idSpaces.js'

/** The ONE provider display-name table:
 *  every surface that names a provider family derives its label here —
 *  never a per-surface brand spelling ('GPT ENGINES') or invented family
 *  name. Keyed by the same route ids the id-space table declares; an
 *  unknown id shows itself, so a future family is never silent. */
const PROVIDER_DISPLAY_NAMES: Record<CallModelRoute, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zai: 'Z.AI',
  moonshot: 'Moonshot',
  deepseek: 'DeepSeek',
  'openai-compat': 'Custom endpoint',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  huggingface: 'Hugging Face',
  local: 'Local models',
}

export function providerDisplayName(route: string): string {
  return (PROVIDER_DISPLAY_NAMES as Record<string, string>)[route] ?? route
}

/** The routing-law verdict for a RESOLVED model id, reduced to the boolean-
 *  gate shape: the declared route, or null — never a borrowed family. null
 *  compares equal to no CallModelRoute, so a `=== 'anthropic'` gate cannot
 *  class an id Anthropic never declared, and a `!== 'anthropic'` gate reads
 *  an unrecognised id as exactly not-anthropic. Absence-shaped input ('')
 *  answers null too — callers hold resolved ids here; a surface that can
 *  hold absence switches on classifyModelRoute's own verdict instead. */
export function declaredRouteOf(
  model: string,
  env?: Record<string, string | undefined>,
): CallModelRoute | null {
  const verdict = classifyModelRoute(model, env)
  return verdict.kind === 'route' ? verdict.route : null
}

/** The ONE lane-label grammar over the verdict (paint-time only — never a
 *  rewrite of stored records): a declared route shows its family's own
 *  display name; an unrecognised id shows the honest word — and when it is
 *  actually RIDING (the gateway world is the only world it runs), the lane
 *  says what carries it; absence shows an unset mark, never a family. */
export function laneLabelForVerdict(
  verdict: ModelRouteVerdict,
  opts?: { rode?: boolean },
): string {
  switch (verdict.kind) {
    case 'route':
      return providerDisplayName(verdict.route)
    case 'unrecognised':
      return opts?.rode === true ? 'Gateway (Anthropic-compatible)' : 'Unrecognised'
    case 'absence':
      return 'unset'
  }
}

export function isCompatModelId(model: string): boolean {
  return normalizedRaw(model).startsWith(COMPAT_MODEL_PREFIX)
}

/** Trim/lowercase WITHOUT the API normalization — the qualified-namespace
 *  checks used by schema/id helpers on raw operator input. */
function normalizedRaw(model: string): string {
  return model.trim().toLowerCase()
}

/** The wire id for a compat-slot model (prefix detached; other ids pass). */
export function stripCompatModelPrefix(model: string): string {
  const trimmed = model.trim()
  return trimmed.toLowerCase().startsWith(COMPAT_MODEL_PREFIX)
    ? trimmed.slice(COMPAT_MODEL_PREFIX.length)
    : trimmed
}

/** Generic qualified-namespace strip: the wire id for ANY family that
 *  declares a qualified prefix (compat/openrouter today); ids outside every
 *  qualified namespace pass through unchanged. */
export function qualifiedWireId(model: string): string {
  const trimmed = model.trim()
  const lowered = trimmed.toLowerCase()
  for (const space of PROVIDER_ID_SPACES) {
    if (space.qualifiedPrefix && lowered.startsWith(space.qualifiedPrefix)) {
      return trimmed.slice(space.qualifiedPrefix.length)
    }
  }
  return trimmed
}

// ── canonicalWireModelId: the ONE wire-id canonicalization owner ────────────
//
//  Every dispatch seam (the compat chat lanes, the Agent-tool engine grammar)
//  asks THIS law for the id it may put on a wire. Two laws, both proven on
//  the live catalogues (2026-08-24 probe: 417 OpenRouter rows, zero ids
//  containing '[', zero ids with more than one '/'):
//
//    1. Mercury's context annotations ([<n>m]/[served]) are CLIENT-SIDE
//       display dressing on the persisted id — they never reach any wire, in
//       or out of a qualified namespace (model.ts's own header law; the
//       2026-08-21 "vendors serve bracket slugs" exception was built on a
//       mis-read of this very bug's junk and is retired). A dressed but
//       otherwise-valid id HEALS: the annotation strips, the id dispatches.
//    2. What remains must fit the family's declared inner grammar
//       (idSpaces.ts): a leftover bracket or a third path segment inside a
//       segments-2 namespace is JUNK — display words or a second vendor
//       prefix composed onto an already carrier-shaped id (the live
//       OpenRouter 400: 'anthropic/openai/gpt-5.6-terra[1m]'). Junk REFUSES
//       here, typed and catalogue-worded, before any HTTP — never a
//       provider 400.
//
//  'named' families (the operator's compat slot, local servers) keep their
//  own naming freedom: only Mercury annotations and self-nesting (a
//  'compat/compat/…' double composition) are Mercury-certain junk there.

export type WireIdVerdict =
  | {
      ok: true
      /** The id exactly as it may ride the wire (namespace detached). */
      wireId: string
      /** Present when a Mercury annotation was stripped to get there. */
      healed?: true
    }
  | {
      ok: false
      /** Honest catalogue-worded refusal — surfaces verbatim to the
       *  operator/model; never carries a secret. */
      reason: string
    }

const MERCURY_ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

/** The wire id for a model id, canonicalized under the two laws above. */
export function canonicalWireModelId(model: string): WireIdVerdict {
  const trimmed = model.trim()
  const space = qualifiedIdSpaceOf(trimmed)
  if (space?.qualifiedPrefix === undefined) {
    // Bare families: the wire id is the annotation-stripped id (existing
    // normalize semantics, one owner). No bare family's ids contain a path
    // separator (kimi-k3 · deepseek-v4-pro · glm-5.2 · gemini-3-pro), so a
    // slash here is a carrier-shaped string that mis-entered a bare lane —
    // junk, refused before it mangles a request path or body.
    const wireId = normalizeModelStringForAPI(trimmed)
    if (wireId.includes('/')) {
      return {
        ok: false,
        reason: `'${trimmed}' is not a dispatchable model id on this lane — bare-family ids carry no '/'. Carrier catalogue rows persist provider-qualified (openrouter/<vendor>/<model> · huggingface/<org>/<model> · compat/<id> · local/<name>); the /model picker lists the live catalogues.`,
      }
    }
    return wireId === trimmed ? { ok: true, wireId } : { ok: true, wireId, healed: true }
  }
  const inner = trimmed.slice(space.qualifiedPrefix.length)
  const stripped = inner.replace(MERCURY_ANNOTATION_RE, '')
  const healed = stripped !== inner
  if (stripped === '') {
    return { ok: false, reason: `'${trimmed}' names no model inside the ${space.route} namespace — the /model picker lists the live catalogue.` }
  }
  if (space.innerGrammar === 'segments-2') {
    if (/[[\]]/.test(stripped)) {
      // Bracket residue beyond Mercury's own annotations: display words in
      // an id position. No live catalogue serves bracket ids (probed).
      return {
        ok: false,
        reason: `'${trimmed}' carries display dressing ('${stripped.match(/\[[^\]]*\]?/)?.[0] ?? '['}…') that is not part of any catalogue id — pick the row again from /model (ids persist as ${space.qualifiedPrefix}<vendor>/<model>).`,
      }
    }
    const segments = stripped.split('/')
    if (segments.length !== 2 || segments.some(s => s === '')) {
      return {
        ok: false,
        reason: `'${trimmed}' is not a dispatchable ${space.route} id — the catalogue's ids are exactly <vendor>/<model> under the ${space.qualifiedPrefix} namespace${segments.length > 2 ? ` and '${stripped}' composes a second vendor prefix onto an already carrier-shaped id` : ''}. The /model picker lists the live catalogue.`,
      }
    }
    return healed ? { ok: true, wireId: stripped, healed: true } : { ok: true, wireId: stripped }
  }
  // 'named' families: the operator's/server's own naming rides verbatim —
  // only a self-nested namespace is Mercury-certain double composition.
  if (stripped.toLowerCase().startsWith(space.qualifiedPrefix)) {
    return {
      ok: false,
      reason: `'${trimmed}' nests the ${space.qualifiedPrefix} namespace inside itself — a composed id was re-prefixed. Name the model once (${space.qualifiedPrefix}<id>).`,
    }
  }
  return healed ? { ok: true, wireId: stripped, healed: true } : { ok: true, wireId: stripped }
}

/** Heal a carrier CATALOGUE ROW id against the listed catalogue itself
 *  (pure): Mercury annotations strip, and ONE spurious leading vendor
 *  segment peels, exactly when the resulting spelling IS a listed id —
 *  vendor truth adjudicates, never a guess. The live class this closes: a
 *  poisoned feed serving 'anthropic/openai/gpt-5.6-sol[1m]' beside the real
 *  'openai/gpt-5.6-sol' row heals onto the real row; junk with no listed
 *  twin stays junk (the caller renders it visible-but-unavailable).
 *  Returns the healed LISTED id, the id itself when already listed, or
 *  undefined when no listed spelling redeems it. */
export function healListedCatalogueRowId(
  rowId: string,
  listed: ReadonlySet<string>,
): string | undefined {
  // The caller asks only after the wire owner rejected the raw spelling,
  // and a poisoned feed lists the junk rows themselves — so a candidate
  // must be STRICTLY DIFFERENT from the raw id: a row never self-validates
  // by being listed.
  const raw = rowId.trim()
  const stripped = raw.replace(MERCURY_ANNOTATION_RE, '')
  if (stripped !== raw && listed.has(stripped)) return stripped
  const peeled = stripped.includes('/') ? stripped.slice(stripped.indexOf('/') + 1) : undefined
  if (peeled !== undefined && peeled !== raw && listed.has(peeled)) return peeled
  return undefined
}

// resolveCallModelRoute — the remainder-era total classifier ('everything
// else → anthropic') — is RETIRED (the operator's phase-2 neutrality ruling:
// "why does there have to be a default fallback? Why can the default
// fallback be nothing?"). classifyModelRoute (idSpaces.ts) is the one
// classifier — absence and unknownness are first-class verdicts — and
// declaredRouteOf/laneLabelForVerdict above are its consumer shapes. The
// zero-spellings needle in prove-route-law §8 keeps the name from
// regrowing.

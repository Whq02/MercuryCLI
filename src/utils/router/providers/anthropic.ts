// ============================================================================
//  providers/anthropic.ts — the COMPLETE Anthropic RouterProviderAdapter.
//
//  The only LIVE provider today. Model truth is derived from EXISTING helpers
//  — nothing here hardcodes a fact a helper already owns:
//    - SEAT_ALLOWED_FAMILIES / validateSeatModel (seatSlots.ts) — the ONE
//      never-Haiku, allowed-family gate every roster seat already uses.
//    - getCanonicalName (model.ts) — folds an id to its seat-family canonical
//      ('claude-opus-4-8[1m]' → 'claude-opus-4-6', per seatSlots.ts:56-60).
//    - isHaikuTier (modelFloor.ts) — the mechanical never-Haiku check.
//    - getContextWindowForModel (context.ts:63) — the REAL context-window
//      resolver (has1mContext → future-model catalog → capability cache →
//      1M-beta/experiment fallthrough → MODEL_CONTEXT_WINDOW_DEFAULT). Probed
//      bun-loadable and correct for our three class defaults:
//        getContextWindowForModel('claude-opus-4-8[1m]')  === 1_000_000
//        getContextWindowForModel('claude-sonnet-5')      === 1_000_000  (the
//          first-party natively-1M static pin, capabilities.ts)
//        getContextWindowForModel('claude-fable-5')       === 200_000  (no
//          '[1m]' suffix on the bare id and fable-5 carries NO natively-1M
//          static pin — modelSupports1M would say true for fable-5, but
//          getContextWindowForModel only consults that inside the explicit
//          1M-beta-header branch, so a bare pin without the suffix or beta
//          genuinely runs 200K today; this is real production behavior, not
//          a gap introduced here — see context.ts:63-98).
//    - renderModelChip (model.ts:556) — the compact display-name form
//      ("Opus 4.8 [1m]", "Sonnet 5", "Fable 5") for RouterProviderModel
//      labels; never a raw id, never a new hardcoded label table.
//
//  Class resolution uses LITERAL ids (not aliases) — the exact strings the
//  seat allowlist already pins (SEAT_ALLOWED_FAMILIES, seatSlots.ts) — then
//  re-validates each through validateSeatModel against itself. That validate-against-self call is a FAIL-CLOSED guard, not a
//  formality: if a future edit ever mis-pins a class default to a Haiku or
//  off-family id, validateSeatModel returns a `note` (the substitution
//  advisory) and resolveModel REFUSES the class (returns null) rather than
//  silently emitting a relabeled substitute under the requested class's
//  name — a wrong-but-present ref is worse than an honest absence here.
//
//  Effort defaults: resolveModel's ref carries a SANE DEFAULT effort per
//  posture — the kernel overrides it downstream per its own routing
//  decision; this is only what a caller gets before that override.
//    quality  → 'max'   (opus) / 'xhigh' (sonnet, fable)
//    other    → 'xhigh' (opus) / 'high'  (sonnet, fable)
//
//  Never Haiku, never a network call, never throws — status()/listModels()/
//  resolveModel() are pure reads over the seat-slot + context-window helpers
//  above (all synchronous, all probed bun-loadable — unlike src/utils/effort.ts,
//  which is NOT bun-run loadable as a value import per seatSlots.ts:23-26;
//  this file imports no value from effort.ts, only the local RouteEffortLevel
//  union in types.ts).
// ============================================================================
import { getContextWindowForModel } from '../../context.js'
import { modelSupportsMaxEffort, modelSupportsXHighEffort } from '../../model/capabilities.js'
import { getCanonicalName, renderModelChip } from '../../model/model.js'
import { SEAT_ALLOWED_FAMILIES, validateSeatModel } from '../../model/seatSlots.js'
import type {
  ProviderDescription,
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
} from './types.js'
import { SPECIALIST_ROLES } from './types.js'

/** Anthropic-native model classes (the other two — 'gpt'/'glm' — are never this provider's). */
type AnthropicModelClass = 'opus' | 'sonnet' | 'fable'

function isAnthropicModelClass(modelClass: RouterModelClass): modelClass is AnthropicModelClass {
  return modelClass === 'opus' || modelClass === 'sonnet' || modelClass === 'fable'
}

/**
 * The literal (non-alias) default id per class — mirrors PARTY_SEAT_DEFAULTS
 * (seatSlots.ts): the fable class runs the frontier seat form (fable[1m] —
 * the orchestration default), the sonnet seats run the bare
 * 1M-by-default id, and the opus class runs the current Opus (Opus 5,
 * natively 1M on the bare id).
 */
const CLASS_DEFAULT_MODEL: Readonly<Record<AnthropicModelClass, string>> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5[1m]',
}

/** Canonical (post-fold) family string → the class it represents. */
function classForCanonical(canonical: string): AnthropicModelClass | null {
  if (canonical === 'claude-opus-4-6') return 'opus'
  if (canonical === 'claude-opus-5') return 'opus'
  if (canonical === 'claude-sonnet-5') return 'sonnet'
  if (canonical === 'claude-fable-5') return 'fable'
  if (canonical === 'claude-fable-5-1') return 'fable'
  return null
}

/** The router's own ladder (the seat convention starts at high). */
const ROUTE_EFFORT_LADDER: readonly RouteEffortLevel[] = ['high', 'xhigh', 'max']

/** The router ladder a MODEL can actually run: the one capability edge
 *  decides the ceiling (a fixed three-word list advertised max on every
 *  family row, whatever the model served). */
export function routeEffortsFor(model: string): RouteEffortLevel[] {
  return ROUTE_EFFORT_LADDER.filter(level =>
    level === 'high' ? true : level === 'xhigh' ? modelSupportsXHighEffort(model) : modelSupportsMaxEffort(model),
  )
}

/** Sane default effort per class+posture — the kernel overrides downstream. */
function defaultEffortFor(modelClass: AnthropicModelClass, posture: RouterPosture): RouteEffortLevel {
  if (posture === 'quality') return modelClass === 'opus' ? 'max' : 'xhigh'
  return modelClass === 'opus' ? 'xhigh' : 'high'
}

export function anthropicStatus(): RouterProviderStatus {
  return { available: true }
}

export function resolveAnthropicModel(
  modelClass: RouterModelClass,
  posture: RouterPosture,
): RouteModelRef | null {
  if (!isAnthropicModelClass(modelClass)) return null // 'gpt'/'glm' are never this provider's
  const fallback = CLASS_DEFAULT_MODEL[modelClass]
  // Validate the class default AGAINST ITSELF — a fail-closed guard against a
  // future mis-pin (see file header). raw === fallback, so a clean validation
  // returns { model: fallback } with no note; ANY note means the pinned
  // default itself is not an allowed seat family (Haiku or off-list), and we
  // refuse the whole class rather than emit a silently-relabeled ref.
  const validated = validateSeatModel(fallback, fallback)
  if (validated.note) return null
  const model = validated.model
  const canonical = getCanonicalName(model)
  if (!SEAT_ALLOWED_FAMILIES.includes(canonical)) return null // defense-in-depth; unreachable for a correct pin table
  const effort = defaultEffortFor(modelClass, posture)
  const contextWindow = getContextWindowForModel(model)
  return { provider: 'anthropic', model, modelClass, effort, contextWindow }
}

export function listAnthropicModels(): RouterProviderModel[] {
  const classes: AnthropicModelClass[] = ['opus', 'sonnet', 'fable']
  const out: RouterProviderModel[] = []
  for (const modelClass of classes) {
    // 'adaptive' is a neutral posture for a display listing — the kernel
    // resolves the caller's real posture at route time via resolveModel().
    const ref = resolveAnthropicModel(modelClass, 'adaptive')
    if (ref) out.push({ ref, displayLabel: renderModelChip(ref.model) })
  }
  return out
}

export function buildAnthropicLaunchPatch(ref: RouteModelRef): { model: string; effort: string } {
  return { model: ref.model, effort: ref.effort }
}

/** the typed description surface. The catalogue is the seat table
 *  projected through listModels() — a static pin by design (the ratified
 *  PARTY_SEAT_DEFAULTS families), running on the session's own credentials. */
export function describeAnthropicProvider(): ProviderDescription {
  return {
    transport: 'anthropic-messages',
    capabilities: [
      'streaming',
      'tool-calls',
      'structured-output',
      'reasoning-deltas',
      'usage-accounting',
      'cancellation',
      'worktree-authoring',
    ],
    roles: SPECIALIST_ROLES,
    account: { kind: 'inherited-main', label: 'main-loop credentials' },
    catalogue: listAnthropicModels().map(m => ({
      id: m.ref.model,
      displayLabel: m.displayLabel,
      modelClass: m.ref.modelClass,
      contextWindow: m.ref.contextWindow,
      efforts: routeEffortsFor(m.ref.model),
      roles: SPECIALIST_ROLES,
    })),
    catalogueSource: 'static-pin',
  }
}

export const anthropicProviderAdapter: RouterProviderAdapter = {
  id: 'anthropic',
  transport: 'anthropic-messages',
  status: anthropicStatus,
  describe: describeAnthropicProvider,
  listModels: listAnthropicModels,
  resolveModel: resolveAnthropicModel,
  buildLaunchPatch: buildAnthropicLaunchPatch,
}

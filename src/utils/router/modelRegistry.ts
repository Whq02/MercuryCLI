// ============================================================================
//  modelRegistry.ts — the router-facing snapshot over the provider adapters.
//
//  ONE seam the routing kernel reads for "what can I run, and what
//  does class X resolve to" — never a provider file directly. Every landed
//  family registers its adapter here (anthropic · openai · zai · gemini ·
//  openrouter · moonshot · deepseek · openai-compat · huggingface · local);
//  AVAILABILITY is each adapter's own status() answer — credential presence
//  from the owning account resolver, never assumed. A class whose family
//  reports unavailable resolves null — no fallthrough to Anthropic, ever.
//
//  buildRouterModelSnapshot() returns a FRESH snapshot each call (providers
//  are re-polled via status()) — cheap and pure, matching the adapters'
//  "never a network call" contract; there is no cached/stale snapshot to
//  invalidate.
//
//  resolveExact() is deliberately NOT validateSeatModel's fail-closed-to-
//  default semantics — an operator-typed EXACT pin that is Haiku-tier or
//  off-family must REFUSE (null), never silently substitute a different
//  model under the pin's name. This mirrors validateSeatModel's own
//  Haiku/bare-sonnet/off-family checks (seatSlots.ts:105-138) step for step,
//  but returns null at each refusal point instead of the seat's substituted
//  fallback — the seat-resolution doctrine ("never nothing, always a pinned
//  default") and the exact-pin doctrine ("never silently alias") are
//  deliberately different contracts over the same allowlist.
// ============================================================================
import { getContextWindowForModel } from '../context.js'
import { getCanonicalName, parseUserSpecifiedModel } from '../model/model.js'
import { isHaikuTier } from '../model/modelFloor.js'
import { SEAT_ALLOWED_FAMILIES } from '../model/seatSlots.js'
import { anthropicProviderAdapter } from './providers/anthropic.js'
import { geminiProviderAdapter } from './providers/gemini.js'
import { openaiProviderAdapter } from './providers/openai.js'
import { openrouterProviderAdapter } from './providers/openrouter.js'
import type {
  ProviderDescription,
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderId,
  RouterProviderModel,
  RouterTransport,
} from './providers/types.js'
import { zaiProviderAdapter } from './providers/zai.js'
import { moonshotProviderAdapter } from './providers/moonshot.js'
import { deepseekProviderAdapter } from './providers/deepseek.js'
import { compatProviderAdapter } from './providers/openaicompat.js'
import { huggingfaceProviderAdapter } from './providers/huggingface.js'
import { localProviderAdapter } from './providers/local.js'

export interface RouterModelSnapshot {
  providers: Array<{
    id: RouterProviderId
    available: boolean
    reason?: string
    /** additions — additive; existing consumers keep reading
     *  id/available/reason unchanged. */
    transport: RouterTransport
    description: ProviderDescription
  }>
  /** Resolve class → ref across providers: anthropic first, future providers only when available (today: never). */
  resolve(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null
  /**
   * Resolve an EXACT operator pin (a raw model string). null when it cannot
   * resolve — the caller surfaces the refusal; NEVER silently alias to a
   * different model.
   */
  resolveExact(pin: string): RouteModelRef | null
  listAvailable(): RouterProviderModel[]
}

// Order is the resolution priority: anthropic first, future providers after
// (moot today — both future adapters are permanently unavailable until a
// real adapter replaces the stub).
const PROVIDER_ADAPTERS: readonly RouterProviderAdapter[] = [
  anthropicProviderAdapter,
  openaiProviderAdapter,
  zaiProviderAdapter,
  // The auth lane: auth/wallet/catalogue estates are
  // live; both stay seatless (resolveModel null) until their dispatch wires
  // land with the provider-wire fold.
  openrouterProviderAdapter,
  geminiProviderAdapter,
  // Provider-08-21 — each an equal engine family:
  moonshotProviderAdapter,
  deepseekProviderAdapter,
  compatProviderAdapter,
  huggingfaceProviderAdapter,
  localProviderAdapter,
]

/** Canonical (post-fold) seat family → the class it represents (mirrors anthropic.ts). */
function classForCanonical(canonical: string): RouterModelClass | null {
  if (canonical === 'claude-opus-4-6') return 'opus'
  if (canonical === 'claude-opus-5') return 'opus'
  if (canonical === 'claude-sonnet-5') return 'sonnet'
  if (canonical === 'claude-fable-5') return 'fable'
  if (canonical === 'claude-fable-5-1') return 'fable'
  return null
}

/** The model CLASS of a raw model id (any alias/suffix spelling), or undefined
 *  for off-family ids — the adapters' affinity comparisons key on this. */
export function classOfModel(model: string | undefined): RouterModelClass | undefined {
  if (!model?.trim()) return undefined
  return classForCanonical(getCanonicalName(parseUserSpecifiedModel(model.trim()))) ?? undefined
}

/** Same ref-default effort convention as anthropic.ts's non-quality branch. */
function defaultExactEffort(modelClass: RouterModelClass): RouteEffortLevel {
  return modelClass === 'opus' ? 'xhigh' : 'high'
}

export function buildRouterModelSnapshot(): RouterModelSnapshot {
  const providers = PROVIDER_ADAPTERS.map(adapter => {
    const status = adapter.status()
    return {
      id: adapter.id,
      available: status.available,
      reason: status.reason,
      transport: adapter.transport,
      description: adapter.describe(),
    }
  })

  function resolve(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null {
    for (const adapter of PROVIDER_ADAPTERS) {
      if (!adapter.status().available) continue // unavailable providers never resolve
      const ref = adapter.resolveModel(modelClass, posture)
      if (ref) return ref
    }
    return null
  }

  function resolveExact(pin: string): RouteModelRef | null {
    const trimmed = pin?.trim()
    if (!trimmed) return null
    if (isHaikuTier(trimmed)) return null
    // Mirrors validateSeatModel's bare-'sonnet' refusal (seatSlots.ts:117-122):
    // it resolves to sonnet-4-6, which is NOT a seat family — refuse rather
    // than silently accept a pin that doesn't mean what it looks like it means.
    const lowered = trimmed.toLowerCase()
    if (lowered === 'sonnet' || lowered === 'sonnet[1m]') return null
    const resolved = parseUserSpecifiedModel(trimmed)
    if (isHaikuTier(resolved)) return null
    const canonical = getCanonicalName(resolved)
    if (!SEAT_ALLOWED_FAMILIES.includes(canonical)) return null
    const modelClass = classForCanonical(canonical)
    if (!modelClass) return null
    const contextWindow = getContextWindowForModel(resolved)
    const effort = defaultExactEffort(modelClass)
    return { provider: 'anthropic', model: resolved, modelClass, effort, contextWindow }
  }

  function listAvailable(): RouterProviderModel[] {
    const out: RouterProviderModel[] = []
    for (const adapter of PROVIDER_ADAPTERS) {
      if (!adapter.status().available) continue
      out.push(...adapter.listModels())
    }
    return out
  }

  return { providers, resolve, resolveExact, listAvailable }
}

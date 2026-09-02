// ============================================================================
//  modelFloor — Mercury's mechanical never-Haiku floor for delegated work.
// ----------------------------------------------------------------------------
//  Operator directive (scripts/model-floor/ pins it): NO subagent, teammate, seat,
//  or workflow agent may ever run on Haiku — it is too weak for this repo's
//  off-distribution work. Until this module, that rule was operator discipline
//  only: EXPLORE_AGENT pins literal 'haiku' for non-ants (exploreAgent.ts),
//  MERCURY_SCRIBE_MODEL / MERCURY_IMPLEMENTER_MODEL
//  are raw pass-through, and `model:'inherit'` resolves to Haiku whenever the
//  main loop itself sits on the global default. This floor makes the rule
//  mechanical at the RESOLUTION chokepoints (getAgentModel, the daemon child
//  spawn, the reconfigure RPC) rather than at the many entry surfaces.
//
//  Design decisions:
//  - Fallback is a FIXED 'claude-sonnet-5': a haiku pick signals "cheap/fast
//    wanted", sonnet-5 is the cheapest allowed tier; inherit-parent is not a
//    safe fallback because the parent can itself be Haiku (global default).
//  - No kill-switch: this is a fork INVARIANT like never-auto-update, not a
//    tunable. No env read ⇒ no flag-registry row.
//  - Silent upgrade + visible truth: every consumer already displays/logs the
//    RESOLVED model, so the floored value is automatically visible; we also
//    log and record a bounded FloorEvent ring for the telemetry surfaces.
// ============================================================================
import { logForDebugging } from '../debug.js'
import { getCanonicalName } from './model.js'

/** The fixed floor fallback — cheapest ALLOWED tier (never Haiku). */
export const NEVER_HAIKU_FALLBACK = 'claude-sonnet-5'

export type FloorEvent = {
  /** epoch ms when the floor fired */
  ts: number
  /** which resolution seam fired (e.g. 'getAgentModel', 'daemon:tank') */
  origin: string
  /** the haiku-tier model string that was blocked */
  blocked: string
  /** what it was floored to (NEVER_HAIKU_FALLBACK) */
  fallback: string
}

const FLOOR_EVENT_CAP = 20
const floorEvents: FloorEvent[] = []

/**
 * True when a model string resolves to the Haiku tier in ANY spelling:
 * bare alias ('haiku', 'haiku[1m]'), full ids ('claude-haiku-4-5-20251001',
 * 'claude-3-5-haiku-…'), provider-prefixed forms ('us.anthropic.claude-haiku-…'),
 * ARN-overridden ids that getCanonicalName folds back to a haiku canonical,
 * and the haiku-SLOT env-pin values (ANTHROPIC_DEFAULT_HAIKU_MODEL /
 * ANTHROPIC_SMALL_FAST_MODEL) in the operator's own spelling — the 'haiku'
 * alias RESOLVES to that value before the floor sees it, so a pin without
 * 'haiku' in its string would otherwise carry the bare alias straight past
 * the floor.
 */
export function isHaikuTier(model: string): boolean {
  if (!model) return false
  // A non-Anthropic id is never haiku-TIER, whatever its name contains: a
  // Hugging Face, local or openrouter model with 'haiku' in its slug must
  // not be silently swapped onto an Anthropic model — the floor's fallback
  // would be exactly the cross-provider fallback the routing law forbids.
  // Lazy-required: routeLaw imports utils/model/model.js, which imports
  // this module — a static import would close that cycle.
  const { declaredRouteOf } =
    require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
  if (declaredRouteOf(model) !== 'anthropic') return false
  if (model.toLowerCase().includes('haiku')) return true
  const canonical = getCanonicalName(model).toLowerCase()
  if (canonical.includes('haiku')) return true
  // A pin value whose own string canonicalizes to another first-party
  // family is recognizably NOT haiku-tier: an operator may route the small
  // slot UP (e.g. a sonnet gateway spelling), and flooring that would
  // rewrite strength that is already lawful.
  if (/claude-(?:opus|sonnet|fable)/.test(canonical)) return false
  return matchesHaikuSlotPin(model)
}

/** The haiku-SLOT env pins: each names, by the pin's own contract, the id
 *  the 'haiku' tier dispatches — so the VALUE is the operator's haiku-tier
 *  stand-in whatever its spelling (a gateway slug, an opaque ARN). */
const HAIKU_SLOT_ENV_PINS = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const

// Mercury's client-side context annotations, detached before equality —
// the same riders idSpaces strips before its env-pin comparison.
const PIN_ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

function matchesHaikuSlotPin(model: string): boolean {
  const bare = model.trim().replace(PIN_ANNOTATION_RE, '').toLowerCase()
  if (bare === '') return false
  for (const pin of HAIKU_SLOT_ENV_PINS) {
    const value = process.env[pin]?.trim().replace(PIN_ANNOTATION_RE, '').toLowerCase()
    if (value !== undefined && value !== '' && value === bare) return true
  }
  return false
}

/**
 * The floor itself. Call with a FULLY RESOLVED model string (post-alias, post
 * inherit) — flooring at the definition layer is insufficient because
 * 'inherit' from a Haiku main loop still resolves to Haiku.
 *
 */
export function enforceSubagentModelFloor(
  resolved: string,
  origin: string,
): string {
  
  if (!isHaikuTier(resolved)) return resolved
  const event: FloorEvent = {
    ts: Date.now(),
    origin,
    blocked: resolved,
    fallback: NEVER_HAIKU_FALLBACK,
  }
  floorEvents.push(event)
  if (floorEvents.length > FLOOR_EVENT_CAP) {
    floorEvents.splice(0, floorEvents.length - FLOOR_EVENT_CAP)
  }
  logForDebugging(
    `[modelFloor] never-Haiku floor fired at ${origin}: '${resolved}' → '${NEVER_HAIKU_FALLBACK}'`,
  )
  return NEVER_HAIKU_FALLBACK
}

/** Bounded ring of recent floor firings — for telemetry/inspection surfaces. */
export function recentFloorEvents(): readonly FloorEvent[] {
  return floorEvents
}

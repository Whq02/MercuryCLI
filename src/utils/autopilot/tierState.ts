// ============================================================================
//  AUTOPILOT tier state — the mechanical rails under the SetTier tool.
//
//  Semantics (the design contract, docs/AUTOPILOT-TIER.md):
//   • Closed table: a tier change names a KEY from the operator allowlist
//     (autopilotGates — default opus|sonnet|fable|fable51, narrowed by the
//     operator allowlist; haiku unrepresentable). The key resolves through the SAME family defaults the
//     /model picker uses, preserving the session's [1m] context suffix.
//   • Effort is clamped to the TARGET model's real ceiling
//     (getMaxSupportedEffortLevel); MERCURY_EFFORT_LEVEL stays supreme
//     inside resolveAppliedEffort, and the deepthink turn floor stays
//     raise-only ABOVE whatever base a tier change sets.
//   • scope:'turn' lands in a thread-keyed slot applied at the query loop's
//     callModel assembly and REVERTED at turn end (the deepthink-floor
//     lifecycle); scope:'session' writes the SAME AppState fields /model and
//     the effort slider own — the pickers always show the truth and always
//     override.
//   • Rails: min TURNS_BETWEEN_SWITCHES full turns between switches, at most
//     MAX_SWITCHES_PER_SESSION per session, every switch surfaced (the tool
//     result line + the MercuryFrame modeBand tier readout + an evolution-
//     ledger row from the tool). Rails are per-process (a session).
// ============================================================================

import type { EffortLevel } from '../effort.js'
import { EFFORT_LEVELS, getMaxSupportedEffortLevel } from '../effort.js'
import {
  getDefaultFableModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  parseUserSpecifiedModel,
} from '../model/model.js'
import { withContext1m } from '../model/modelOptions.js'
import { has1mContext } from '../context.js'
import {
  autopilotAllowedModels,
  AUTOPILOT_TIER_KEYS,
  type AutopilotTierKey,
} from './autopilotGates.js'

export const MAX_SWITCHES_PER_SESSION = 8
export const TURNS_BETWEEN_SWITCHES = 3

export interface TierChangeRequest {
  model?: AutopilotTierKey
  effort?: EffortLevel
  scope: 'turn' | 'session'
  reason: string
}

export interface TierOverride {
  model?: string
  effort?: EffortLevel
}

export type TierVerdict =
  | { ok: true; applied: TierOverride; line: string }
  | { ok: false; refused: string }

// Session-lifetime rails state. `turn` advances when the MAIN thread's query()
// completes (tierTurnEnded from the query loop's finally — the same lifecycle
// that clears the deepthink floor), so the cooldown counts REAL turns.
let turnCounter = 0
let switchesThisSession = 0
let lastSwitchTurn = -Infinity
const turnOverrides = new Map<string, TierOverride>()

const threadKey = (agentId: string | undefined): string => agentId ?? 'main'

/** Resolve a tier KEY to the family default model id, carrying the session's
 *  current [1m] posture forward (the picker's default-1M convention). */
export function resolveTierKey(key: AutopilotTierKey, currentModel: string): string {
  // Claude Fable 5.1 is an exact member, not a family default: it rides
  // bare (1M is its default and maximum, so no [1m] rider to carry).
  if (key === 'fable51') return parseUserSpecifiedModel('fable51')
  const base =
    key === 'opus'
      ? getDefaultOpusModel()
      : key === 'sonnet'
        ? getDefaultSonnetModel()
        : getDefaultFableModel()
  return has1mContext(currentModel) ? withContext1m(base) : base
}

/**
 * Validate a SetTier request against the rails. Pure of side effects — the
 * caller (SetTierTool) commits via recordSwitch/setTurnOverride/AppState.
 */
export function validateTierChange(
  req: TierChangeRequest,
  currentModel: string,
  currentEffort?: EffortLevel | number,
): TierVerdict {
  if (!req.model && !req.effort) {
    return { ok: false, refused: 'nothing to change — pass model and/or effort' }
  }
  if (!req.reason || req.reason.trim().length < 8) {
    return { ok: false, refused: 'a one-line reason is required (surfaced to the operator)' }
  }
  if (switchesThisSession >= MAX_SWITCHES_PER_SESSION) {
    return {
      ok: false,
      refused: `session switch cap reached (${MAX_SWITCHES_PER_SESSION}) — ask the operator to retune via /model`,
    }
  }
  if (turnCounter - lastSwitchTurn < TURNS_BETWEEN_SWITCHES) {
    const wait = TURNS_BETWEEN_SWITCHES - (turnCounter - lastSwitchTurn)
    return {
      ok: false,
      refused: `cooldown — ${wait} more full turn(s) before another switch (switching thrashes the prompt cache)`,
    }
  }
  const applied: TierOverride = {}
  if (req.model !== undefined) {
    if (!(AUTOPILOT_TIER_KEYS as readonly string[]).includes(req.model)) {
      return { ok: false, refused: `unknown model key '${String(req.model)}' — closed table: ${AUTOPILOT_TIER_KEYS.join('|')}` }
    }
    const allowed = autopilotAllowedModels()
    if (!allowed.includes(req.model)) {
      return {
        ok: false,
        refused:
          req.model === 'fable'
            ? `fable is not in the operator allowlist — MERCURY_AUTOPILOT_MODELS=opus,sonnet,fable opts it in`
            : `'${req.model}' is not in the operator allowlist (${allowed.join(',')})`,
      }
    }
    applied.model = resolveTierKey(req.model, currentModel)
  }
  if (req.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(req.effort)) {
      return { ok: false, refused: `unknown effort '${String(req.effort)}' — one of ${EFFORT_LEVELS.join('|')}` }
    }
    const targetModel = applied.model ?? currentModel
    const ceiling = getMaxSupportedEffortLevel(targetModel)
    const clamped =
      EFFORT_LEVELS.indexOf(req.effort) > EFFORT_LEVELS.indexOf(ceiling) ? ceiling : req.effort
    applied.effort = clamped
  }
  // The spec's from→to transcript line: `⇅ autopilot · opus-4-8 @high →
  // sonnet-5 @medium (turn) — reason`. Only the moving parts appear on each
  // side; [1m] suffixes are stripped for the display (posture is carried, not
  // news).
  const short = (m: string) => m.replace(/\[1m\]$/, '')
  const fromParts: string[] = []
  const toParts: string[] = []
  if (applied.model) {
    fromParts.push(short(currentModel))
    toParts.push(short(applied.model))
  }
  if (applied.effort) {
    if (currentEffort !== undefined) fromParts.push(`@${currentEffort}`)
    toParts.push(`@${applied.effort}`)
  }
  const line = `⇅ autopilot · ${fromParts.length ? `${fromParts.join(' ')} → ` : ''}${toParts.join(' ')} (${req.scope}) — ${req.reason.trim()}`
  return { ok: true, applied, line }
}

/** Commit a validated switch against the rails counters. */
export function recordSwitch(): void {
  switchesThisSession++
  lastSwitchTurn = turnCounter
}

export function setTurnOverride(agentId: string | undefined, o: TierOverride): void {
  turnOverrides.set(threadKey(agentId), o)
}

/** The query loop's callModel assembly: turn-model override (autopilot only). */
export function applyTurnTierModel(agentId: string | undefined, model: string): string {
  return turnOverrides.get(threadKey(agentId))?.model ?? model
}

/** The query loop's callModel assembly: turn-effort BASE override — applied
 *  BENEATH the deepthink raise-only floor and the env supremacy. */
export function applyTurnTierEffort(
  agentId: string | undefined,
  base: EffortLevel | number | undefined,
): EffortLevel | number | undefined {
  return turnOverrides.get(threadKey(agentId))?.effort ?? base
}

/** Turn boundary (the query loop's finally, MAIN thread): advance the
 *  cooldown clock and revert this thread's turn-scoped override. */
export function tierTurnEnded(agentId: string | undefined): void {
  if (threadKey(agentId) === 'main') turnCounter++
  turnOverrides.delete(threadKey(agentId))
}

/** The live tier readout for the MercuryFrame modeBand + boards. */
export function describeTurnOverride(agentId: string | undefined): string | null {
  const o = turnOverrides.get(threadKey(agentId))
  if (!o) return null
  const parts: string[] = []
  if (o.model) parts.push(o.model.replace(/\[1m\]$/, ''))
  if (o.effort) parts.push(`@${o.effort}`)
  return parts.length ? `${parts.join(' ')} · turn` : null
}

export function autopilotRailsSnapshot(): {
  switches: number
  cap: number
  turnsSinceSwitch: number
} {
  return {
    switches: switchesThisSession,
    cap: MAX_SWITCHES_PER_SESSION,
    turnsSinceSwitch: turnCounter - (lastSwitchTurn === -Infinity ? turnCounter : lastSwitchTurn),
  }
}

/** Proof seam — never called in production. */
export function resetTierStateForTests(): void {
  turnCounter = 0
  switchesThisSession = 0
  lastSwitchTurn = -Infinity
  turnOverrides.clear()
}

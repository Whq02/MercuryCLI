// ============================================================================
//  AUTOPILOT gates — flag + model-allowlist seams for the self-serve tier mode.
//
//  AUTOPILOT is Mercury's bypass-posture mode that additionally lets the
//  model retune its own model/effort (the SetTier tool) under mechanical
//  rails. The gates here answer only AVAILABILITY questions:
//   • MERCURY_AUTOPILOT — DEFAULT-OFF, explicit '=1' opt-in (always
// armed from the boot menu, never a standing default). OFF ⇒
//     no carousel station, no SetTier tool — base cycle, byte-identical.
//     Availability is necessary but NOT sufficient: entry also requires the
//     session's bypass eligibility (setPermissionModeWithGuards) — the mode
//     is never a consent backdoor around --dangerously-skip-permissions.
//   • MERCURY_AUTOPILOT_MODELS — the CSV allowlist of self-selectable tier
//     KEYS. Default 'opus,sonnet,fable,fable51' since:
//     Fable-5 is the frontier-operator foreground default on the eligible
//     Max-20x path and subscription-included (the old metered-cost exclusion
//     rationale is stale) — an armed session must be able to return to its
//     own default tier. The operator narrows via the env ('opus,sonnet').
//     Haiku is unrepresentable: the key table simply has no haiku row (the
//     mechanical never-Haiku floor), and unknown keys are dropped, never
//     coerced.
//  Read LIVE on every call (authority-toggle honesty).
// ============================================================================

import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function isAutopilotEnabled(): boolean {
  
  return isEnvTruthy(flagEnv('MERCURY_AUTOPILOT'))
}

/** The closed key table — the ONLY models SetTier can name. */
export const AUTOPILOT_TIER_KEYS = ['opus', 'sonnet', 'fable', 'fable51'] as const
export type AutopilotTierKey = (typeof AUTOPILOT_TIER_KEYS)[number]

const DEFAULT_ALLOWED: readonly AutopilotTierKey[] = ['opus', 'sonnet', 'fable', 'fable51']

/** The operator's allowlist of self-selectable tier keys. UNSET/empty is
 *  the default set; a SET value NARROWS and never silently widens (FC-155
 *  — an all-invalid narrowing used to return the FULL default set, so
 *  opus;sonnet granted more than the correct spelling of the same intent).
 *  The family decision: the sibling separators (`;`, whitespace) and stray
 *  quotes are forgiven so the intent lands; what still parses to nothing
 *  yields the EMPTY allowlist — a garbled narrowing narrows all the way,
 *  and doctor's flag surfaces carry the registry row naming the grammar. */
export function autopilotAllowedModels(): readonly AutopilotTierKey[] {
  const raw = flagEnv('MERCURY_AUTOPILOT_MODELS')
  if (!raw || !raw.trim().replace(/^["']+|["']+$/g, '').trim()) return DEFAULT_ALLOWED
  const parsed = raw
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter((s): s is AutopilotTierKey =>
      (AUTOPILOT_TIER_KEYS as readonly string[]).includes(s),
    )
  return parsed
}

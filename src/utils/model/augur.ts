// biome-ignore-all assist/source/organizeImports: these imports resolve gates in a deliberate order
// =============================================================================
// model/augur.ts — the Augur variant-selection gate family, three switches.
// -----------------------------------------------------------------------------
//   augur_header : contributes AUGUR_BETA_HEADER to the request's per-model
//                  beta-feature set (utils/betas.ts reads it).
//   augur_tool   : selects the alternate Brief/SendUserMessage tool
//                  description (the chooser is tools/BriefTool/promptSelect.ts,
//                  the prose lives with the other prompts in
//                  tools/BriefTool/prompt.ts).
//   augur_brief  : the family's brief-mode switch.
//
// How a switch resolves:
//   1. MERCURY_AUGUR, tri-state, governs the whole family — set means
//      decided, unset means keep going.
//   2. A pin may narrow the family to one model line: env MERCURY_AUGUR_MODEL
//      first, the clientDataCache pin second. Pinned + current model's
//      canonical id lacking the substring ⇒ off. No pin at all ⇒ no model
//      restriction, so flipping a flag is enough to try any arm against
//      whatever is running right now.
//   3. Failing both, the arm's own clientDataCache boolean decides.
// The tool and brief arms each get one more layer on top —
// MERCURY_AUGUR_TOOL and MERCURY_AUGUR_BRIEF — their private tri-states,
// consulted before anything family-wide. Every knob is a registered flag and
// is read through the registry (flagEnv), never raw process.env.
//
// Everything defaults off, and nothing here throws: these gates run as
// early as pre-config bootstrap, where a config read can fail — such reads
// degrade to "no pin" / "off" instead of propagating.
// =============================================================================

import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig } from '../config.js'
import { getCanonicalName, getMainLoopModel } from './model.js'

/**
 * Beta header advertised while the header variant is active. The literal is a
 * wire value carried in the request's beta-feature set (utils/betas.ts) and
 * follows the dated `*-2026-*` convention of the other entries there.
 * WIRE CONTRACT: the API receives this exact value; it stays byte-exact.
 */
export const AUGUR_BETA_HEADER = 'pewter-owl-2026-04-01'

const AUGUR_VARIANTS = ['augur_header', 'augur_tool', 'augur_brief'] as const
export type AugurVariant = (typeof AUGUR_VARIANTS)[number]

// WIRE CONTRACT: clientDataCache is filled from the server's bootstrap
// client_data record, so each arm reads its externally-pushed key spelling.
const CLIENT_DATA_KEY: Record<AugurVariant, string> = {
  augur_header: 'pewter_owl_header',
  augur_tool: 'pewter_owl_tool',
  augur_brief: 'pewter_owl_brief',
}
// WIRE CONTRACT: the model-pin key pushed in the same client_data record.
const CLIENT_DATA_MODEL_PIN_KEY = 'pewter_owl_model'

/**
 * An override flag has three meaningful states, and only the first two
 * decide anything: a recognized truthy value forces on, a recognized falsy
 * value forces off, and everything else (absent, empty, junk) yields
 * undefined so the next layer of the ladder gets its turn. Read live through
 * the registry on every call.
 */
function triBoolFlag(name: string): boolean | undefined {
  const raw = flagEnv(name)
  if (raw === undefined || raw === '') return undefined
  if (isEnvTruthy(raw)) return true
  if (isEnvDefinedFalsy(raw)) return false
  return undefined
}

/**
 * Which model line the family is restricted to — a substring matched against
 * the canonical main-loop model id — or '' meaning no restriction. The env
 * spelling outranks the clientDataCache one.
 *
 * Guarded config read: this can run before the config subsystem comes up,
 * and a capability gate that throws would take its caller down with it, so
 * unreadable config simply means "no pin".
 */
export function augurPinnedModel(): string {
  const fromEnv = flagEnv('MERCURY_AUGUR_MODEL')
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim()
  }
  try {
    const cached = getGlobalConfig().clientDataCache?.[CLIENT_DATA_MODEL_PIN_KEY]
    if (typeof cached === 'string' && cached !== '') {
      return cached
    }
  } catch {
    /* pre-bootstrap or unreadable config ⇒ treat as no pin */
  }
  return ''
}

/**
 * The shared ladder every arm climbs: family override first, then the model
 * pin (a mismatch is an off), then the arm's own clientDataCache boolean.
 */
function augurVariantEnabled(variant: AugurVariant): boolean {
  const familyOverride = triBoolFlag('MERCURY_AUGUR')
  if (familyOverride !== undefined) {
    return familyOverride
  }
  const pinned = augurPinnedModel()
  if (pinned !== '' && !getCanonicalName(getMainLoopModel()).includes(pinned)) {
    return false
  }
  // Same degradation as the pin read — an early consult must answer, not throw.
  try {
    return getGlobalConfig().clientDataCache?.[CLIENT_DATA_KEY[variant]] === true
  } catch {
    return false
  }
}

/** The beta-header switch. */
export function isAugurHeader(): boolean {
  return augurVariantEnabled('augur_header')
}

/**
 * The alternate-tool-description switch. Its private tri-state
 * (MERCURY_AUGUR_TOOL) sits above the family ladder, which both lets this
 * arm flip alone and lets an arm-level setting outvote a family-level one.
 */
export function isAugurTool(): boolean {
  const armOverride = triBoolFlag('MERCURY_AUGUR_TOOL')
  if (armOverride !== undefined) {
    return armOverride
  }
  return augurVariantEnabled('augur_tool')
}

/**
 * The brief-mode switch, with a private tri-state (MERCURY_AUGUR_BRIEF)
 * shaped exactly like the tool arm's — every arm of the family can be tried
 * on its own.
 */
export function isAugurBrief(): boolean {
  const armOverride = triBoolFlag('MERCURY_AUGUR_BRIEF')
  if (armOverride !== undefined) {
    return armOverride
  }
  return augurVariantEnabled('augur_brief')
}

// ============================================================================
//  utils/cockpit/agentHeadData — MACHINE MARKS: the per-AGENT identity marks
//  for the workflow/task surfaces (operator direction: workflow
//  agents read as little machines in Mercury's fleet, each wearing its own
//  color theme — the SESSION critters (hero · companion · /critter picker ·
//  sessionAccent) are untouched and stay the og creatures).
//
//  (operator fix): the 11×6 half-block FACE ART is ABSENT. On
//  line-spaced terminal profiles (Apple Terminal etc.) the paired half-block
//  rows shear into detached bars — unfixable from our side — so the mark is
//  now the single-line ✧ hue chip + persona name everywhere (the run lanes
//  already wore exactly that). What survives is the identity table: five
//  instrument personas, each an EXISTING identity hue pair re-used from the
//  single-source palette (mercuryPalette + critterData's exported pairs) — zero
//  new hex by construction. React-free leaf, same as critterData.
//
//  The personas:
//    relay   (TERRA red)   — the messenger's telegraph machine
//    dynamo  (violet)      — the triple-coil generator
//    echo    (sky)         — the swept-fin listener
//    gyro    (teal)        — the gimbal-mounted pivot
//    furnace (ember)       — the flame-toothed burner
// ============================================================================

import { CLAW, TERRA } from '../../components/mercuryPalette.js'
import {
  CLAM_HUE,
  CLAM_HUE_DEEP,
  EMBER_HUE,
  EMBER_HUE_DEEP,
  JELLYFISH_HUE,
  JELLYFISH_HUE_DEEP,
  OCTOPUS_HUE,
  OCTOPUS_HUE_DEEP,
} from './critterData.js'

/** A workflow agent's identity mark: persona name + its theme hue pair. */
export type AgentMark = { name: string; hue: string; hueDeep: string }

/** The agent mark pool, in assignment order. */
export const AGENT_HEADS: AgentMark[] = [
  { name: 'relay', hue: TERRA, hueDeep: CLAW },
  { name: 'dynamo', hue: OCTOPUS_HUE, hueDeep: OCTOPUS_HUE_DEEP },
  { name: 'echo', hue: JELLYFISH_HUE, hueDeep: JELLYFISH_HUE_DEEP },
  { name: 'gyro', hue: CLAM_HUE, hueDeep: CLAM_HUE_DEEP },
  { name: 'furnace', hue: EMBER_HUE, hueDeep: EMBER_HUE_DEEP },
]

/** The mark at an agent index, folded into the pool by true modulo (same
 *  contract as critterData.critterAt — negative/out-of-range still resolves;
 *  the pool is never empty, so this never returns undefined). */
export function agentHeadAt(i: number): AgentMark {
  return AGENT_HEADS[((i % AGENT_HEADS.length) + AGENT_HEADS.length) % AGENT_HEADS.length]!
}

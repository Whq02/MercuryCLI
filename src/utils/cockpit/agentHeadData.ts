
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

export type AgentMark = { name: string; hue: string; hueDeep: string }

export const AGENT_HEADS: AgentMark[] = [
  { name: 'relay', hue: TERRA, hueDeep: CLAW },
  { name: 'dynamo', hue: OCTOPUS_HUE, hueDeep: OCTOPUS_HUE_DEEP },
  { name: 'echo', hue: JELLYFISH_HUE, hueDeep: JELLYFISH_HUE_DEEP },
  { name: 'gyro', hue: CLAM_HUE, hueDeep: CLAM_HUE_DEEP },
  { name: 'furnace', hue: EMBER_HUE, hueDeep: EMBER_HUE_DEEP },
]

export function agentHeadAt(i: number): AgentMark {
  return AGENT_HEADS[((i % AGENT_HEADS.length) + AGENT_HEADS.length) % AGENT_HEADS.length]!
}

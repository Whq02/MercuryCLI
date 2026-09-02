import { getInitialSettings } from '../../utils/settings/settings.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type {
  InstructionProfile,
  InstructionProfileOrigin,
} from './contracts.js'
import { INSTRUCTION_PROFILES } from './contracts.js'

let sessionProfile: InstructionProfile | null = null
let agentProfile: InstructionProfile | null = null

export function isInstructionProfile(
  value: unknown,
): value is InstructionProfile {
  return (
    typeof value === 'string' &&
    (INSTRUCTION_PROFILES as readonly string[]).includes(value)
  )
}

export function setSessionInstructionProfile(
  profile: InstructionProfile | null,
): void {
  sessionProfile = profile
}

export function setAgentInstructionProfile(
  profile: InstructionProfile | null,
): void {
  agentProfile = profile
}

export function resolveRequestedInstructionProfile(): {
  profile: InstructionProfile
  origin: InstructionProfileOrigin
} {
  if (agentProfile !== null) {
    return { profile: agentProfile, origin: 'agent' }
  }
  const envCarrier = flagEnv('MERCURY_INSTRUCTION_PROFILE')
  if (isInstructionProfile(envCarrier)) {
    return { profile: envCarrier, origin: 'agent' }
  }
  if (sessionProfile !== null) {
    return { profile: sessionProfile, origin: 'session' }
  }
  let durable: unknown
  try {
    durable = getInitialSettings().instructionProfile
  } catch {
    durable = undefined
  }
  if (isInstructionProfile(durable)) {
    return { profile: durable, origin: 'session' }
  }
  return { profile: 'auto', origin: 'default' }
}

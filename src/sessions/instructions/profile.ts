import { getInitialSettings } from '../../platform/settings/settings.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import type {
  InstructionProfile,
  InstructionProfileOrigin,
} from '../instruction-contracts/contracts.js'
import { INSTRUCTION_PROFILES } from '../instruction-contracts/contracts.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'

let sessionProfile: InstructionProfile | null = null

export function isInstructionProfile(
  value: unknown,
): value is InstructionProfile {
  return (
    typeof value === 'string' &&
    isOneOf(INSTRUCTION_PROFILES, value)
  )
}

export function setSessionInstructionProfile(
  profile: InstructionProfile | null,
): void {
  sessionProfile = profile
}

export function resolveRequestedInstructionProfile(): {
  profile: InstructionProfile
  origin: InstructionProfileOrigin
} {
  const envCarrier = flagEnv('MERCURY_INSTRUCTION_PROFILE')
  if (isInstructionProfile(envCarrier)) {
    return { profile: envCarrier, origin: 'agent' }
  }
  if (sessionProfile !== null) {
    return { profile: sessionProfile, origin: 'session' }
  }
  let durable: unknown
  try {
    durable = getInitialSettings().briefs?.profile
  } catch {
    durable = undefined
  }
  if (isInstructionProfile(durable)) {
    return { profile: durable, origin: 'session' }
  }
  return { profile: 'auto', origin: 'default' }
}

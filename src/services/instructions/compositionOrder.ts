import { foreignInstructionConventions } from './adapters/agentsMd.js'
import type { InstructionConvention, InstructionProfile } from './contracts.js'
import { mercuryNativeConvention } from './nativeSource.js'

export function conventionsForProfile(profile: InstructionProfile): InstructionConvention[] {
  return profile === 'native'
    ? [mercuryNativeConvention]
    : [mercuryNativeConvention, ...foreignInstructionConventions()]
}

import { agentsMdConvention } from './adapters/agentsMd.js'
import { copilotConvention } from './adapters/copilot.js'
import { geminiConvention } from './adapters/gemini.js'
import type { InstructionConvention, InstructionProfile } from './contracts.js'
import { mercuryNativeConvention } from './nativeSource.js'

const SHARED_CONVENTIONS: readonly InstructionConvention[] = [agentsMdConvention, geminiConvention, copilotConvention]

export function conventionsForProfile(profile: InstructionProfile): InstructionConvention[] {
  return profile === 'native'
    ? [mercuryNativeConvention]
    : [mercuryNativeConvention, ...SHARED_CONVENTIONS]
}

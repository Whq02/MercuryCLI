import { agentFoldersConvention } from './adapters/agentFolders.js'
import { agentsMdConvention } from './adapters/agentsMd.js'
import { copilotConvention } from './adapters/copilot.js'
import { cursorConvention } from './adapters/cursor.js'
import { geminiConvention } from './adapters/gemini.js'
import { windsurfConvention } from './adapters/windsurf.js'
import type { InstructionConvention, InstructionProfile } from './contracts.js'
import { mercuryNativeConvention } from './nativeSource.js'

const SHARED_CONVENTIONS: readonly InstructionConvention[] = [
  agentsMdConvention,
  agentFoldersConvention,
  geminiConvention,
  copilotConvention,
  cursorConvention,
  windsurfConvention,
]

export function sharedRuleFormatOf(conventionId: string | undefined): InstructionConvention | undefined {
  return SHARED_CONVENTIONS.find(convention => convention.id === conventionId && convention.rules !== undefined)
}

export function conventionsForProfile(profile: InstructionProfile): InstructionConvention[] {
  return profile === 'native'
    ? [mercuryNativeConvention]
    : [mercuryNativeConvention, ...SHARED_CONVENTIONS]
}

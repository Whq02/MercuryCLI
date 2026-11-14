import { agentFoldersConvention } from './adapters/agentFolders.js'
import { agentsMdConvention } from './adapters/agentsMd.js'
import { claudeConvention } from './adapters/claudeCode.js'
import { clineConvention } from './adapters/cline.js'
import { copilotConvention } from './adapters/copilot.js'
import { cursorConvention } from './adapters/cursor.js'
import { geminiConvention } from './adapters/gemini.js'
import { windsurfConvention } from './adapters/windsurf.js'
import type { InstructionConvention, InstructionProfile } from './contracts.js'
import { mercuryNativeConvention } from './nativeSource.js'

const SHARED_CONVENTIONS: readonly InstructionConvention[] = [
  agentsMdConvention,
  agentFoldersConvention,
  claudeConvention,
  geminiConvention,
  copilotConvention,
  cursorConvention,
  windsurfConvention,
  clineConvention,
]

export function sharedFormatLabel(conventionId: string | undefined): string | undefined {
  return SHARED_CONVENTIONS.find(convention => convention.id === conventionId)?.label
}

export function otherToolFormats(): InstructionConvention[] {
  return SHARED_CONVENTIONS.filter(convention => convention.belowHome)
}

export function sharedRuleFormats(): InstructionConvention[] {
  return SHARED_CONVENTIONS.filter(convention => convention.rules !== undefined)
}

export function sharedRuleFormatOf(conventionId: string | undefined): InstructionConvention | undefined {
  return sharedRuleFormats().find(convention => convention.id === conventionId)
}

export function conventionsForProfile(profile: InstructionProfile): InstructionConvention[] {
  return profile === 'native'
    ? [mercuryNativeConvention]
    : [mercuryNativeConvention, ...SHARED_CONVENTIONS]
}

import { registerDebugSkill } from './debug.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerSimplifySkill } from './simplify.js'
import { registerSkillifySkill } from './skillify.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import { registerAestheticDirectionSkill } from './aesthetic-direction.js'
import { registerAppProofSkill } from './app-proof.js'
import { registerDraftingPartnerSkill } from './drafting-partner.js'
import { registerExtensionMakerSkill } from './extension-maker.js'
import { registerMcpSmithySkill } from './mcp-smithy.js'
import { registerPdfDocumentsSkill } from './pdf-documents.js'
import { registerProviderApisSkill } from './provider-apis.js'
import { registerSkillForgeSkill } from './skill-forge.js'
import { registerSlideDecksSkill } from './slide-decks.js'
import { registerSpreadsheetsSkill } from './spreadsheets.js'
import { registerWordDocumentsSkill } from './word-documents.js'
import { registerLoopSkill } from './loop.js'
import { registerScheduleRemoteAgentsSkill } from './scheduleRemoteAgents.js'

export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerDebugSkill()
  registerSkillifySkill()
  registerSimplifySkill()

  registerAestheticDirectionSkill()
  registerAppProofSkill()
  registerDraftingPartnerSkill()
  registerExtensionMakerSkill()
  registerMcpSmithySkill()
  registerPdfDocumentsSkill()
  registerProviderApisSkill()
  registerSkillForgeSkill()
  registerSlideDecksSkill()
  registerSpreadsheetsSkill()
  registerWordDocumentsSkill()

  registerLoopSkill()
  registerScheduleRemoteAgentsSkill()
}

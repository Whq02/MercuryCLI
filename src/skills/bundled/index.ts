import { registerDebugSkill } from './debug.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerSimplifySkill } from './simplify.js'
import { registerSkillifySkill } from './skillify.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
// Skills compiled from mercury-skills/ by scripts/skills/gen-bundled.ts.
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
// The /loop and /schedule family; each skill's own isEnabled gates visibility.
import { registerLoopSkill } from './loop.js'
import { registerScheduleRemoteAgentsSkill } from './scheduleRemoteAgents.js'

/**
 * Register every skill that ships inside the binary. The entry layer runs
 * this once at boot, before any command lookup happens.
 *
 * A new bundled skill gets its own module under src/skills/bundled/
 * exporting a register function that wraps registerBundledSkill(); that
 * function is then imported and invoked from here. Bundled skills register
 * before the external and extension loaders, so a bundled copy wins a name
 * collision with an extension's copy (the external copy is
 * skipped).
 */
export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerDebugSkill()
  registerSkillifySkill()
  registerSimplifySkill()
  // /verify is the red-team command and /remember the memory-card writer;
  // bundled skills win name collisions, so none is registered under those
  // names either.

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

import { registerDebugSkill } from './debug.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerMercuryDocsSkill } from './mercuryDocs.js'
import { registerSkillifySkill } from './skillify.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import { registerExtensionMakerSkill } from './extension-maker.js'
import { registerImageGenerationSkill } from './image-generation.js'
import { registerMcpSmithySkill } from './mcp-smithy.js'
import { registerProviderApisSkill } from './provider-apis.js'
import { registerSkillForgeSkill } from './skill-forge.js'
import { registerLoopSkill } from './loop.js'
import { registerScheduleRemoteAgentsSkill } from './scheduleRemoteAgents.js'
import { registerResearchSkill } from './research.js'

export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerDebugSkill()
  registerSkillifySkill()
  registerMercuryDocsSkill()

  registerExtensionMakerSkill()
  registerImageGenerationSkill()
  registerMcpSmithySkill()
  registerProviderApisSkill()
  registerSkillForgeSkill()

  registerLoopSkill()
  registerScheduleRemoteAgentsSkill()
  registerResearchSkill()
}

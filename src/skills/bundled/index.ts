import { registerCodeReviewSkill } from './code-review.js'
import { registerDebugSkill } from './debug.js'
import { registerDeepResearchSkill } from './deep-research.js'
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
import { notBuilt } from '../../pi/holes.js'

export function initBundledSkills(): void {
  return notBuilt('src/skills/bundled/index.ts:17')
}

import { readdir, stat } from 'fs/promises'
import { relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { getProjectRoot, getSdkBetas } from '../../bootstrap/state.js'
import { getMcpSkillCommands, getSkillToolCommands } from '../../commands.js'
import { formatCommandsWithinBudgetDetailed } from '../skillListingFormat.js'
import { SKILL_TOOL_NAME } from '../../constants/tools/skill.js'
import { getContextWindowForModel } from '../context.js'
import { logForDebugging } from '../debug.js'
import type { Attachment } from './types.js'
import { capsuleStateFor, resetCapsuleSkillNames, suppressCapsuleSkillListing } from './capsuleState.js'
import { passedOver } from '../passedOver.js'
import { notBuilt } from '../../pi/holes.js'

export async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  return notBuilt('src/utils/attachments/skillListing.ts:16')
}

export function resetSentSkillNames(): void {
  return notBuilt('src/utils/attachments/skillListing.ts:45')
}

export function suppressNextSkillListing(): void {
  return notBuilt('src/utils/attachments/skillListing.ts:49')
}

export async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  return notBuilt('src/utils/attachments/skillListing.ts:53')
}

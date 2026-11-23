import { readdir, stat } from 'fs/promises'
import { relative, resolve } from 'path'
import { getCwd } from 'src/platform/files/cwd.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { toolMatchesName, type ToolUseContext } from '../../tools/kit/tool.js'
import { getProjectRoot, getSdkBetas } from '../../boot/process-state/processState.js'
import { getMcpSkillCommands, getSkillToolCommands } from '../../commands/catalogue/commands.js'
import { formatCommandsWithinBudgetDetailed } from '../attachments/skillListingFormat.js'
import { SKILL_TOOL_NAME } from '../../tools/kit/names/skill.js'
import { getContextWindowForModel } from '../compaction-window/contextFill.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { Attachment } from './attachmentTypes.js'
import { capsuleStateFor, resetCapsuleSkillNames, suppressCapsuleSkillListing } from './capsuleState.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import type { Command } from '../../commands/catalogue/command.js'

export async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const triggers = toolUseContext.dynamicSkillDirTriggers
  if (!triggers?.size) return []
  const folders = [...triggers]
  const result = await Promise.all(folders.map(async (skillDir): Promise<Attachment[]> => {
    try {
      const entries = await readdir(skillDir, { withFileTypes: true })
      const skillNames: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        try {
          if ((await stat(resolve(skillDir, entry.name, 'SKILL.md'))).isFile()) skillNames.push(entry.name)
        } catch (error) {
          passedOver(error)
        }
      }
      return skillNames.length ? [{ type: 'dynamic_skill', skillDir, skillNames, displayPath: relative(getCwd(), skillDir) }] : []
    } catch (error) {
      passedOver(error)
      return []
    }
  }))
  for (const folder of folders) triggers.delete(folder)
  return result.flat()
}

export function resetSentSkillNames(): void {
  resetCapsuleSkillNames()
}

export function suppressNextSkillListing(): void {
  suppressCapsuleSkillListing()
}

export async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!toolUseContext.options.tools.some(tool => toolMatchesName(tool, SKILL_TOOL_NAME))) return []
  const state = capsuleStateFor(toolUseContext, toolUseContext.messages)
  const local: Command[] = await getSkillToolCommands(getProjectRoot())
  const mcp = getMcpSkillCommands(toolUseContext.getAppState().mcp?.commands ?? [])
  let commands = mcp.length ? uniqBy([...local, ...mcp], command => command.name) : local
  if (toolUseContext.agentId !== undefined) commands = commands.filter(command => command.type !== 'prompt' || command.context !== 'fork')
  if (state.suppressNextSkills) {
    state.suppressNextSkills = false
    for (const command of commands) state.sentSkillNames.add(command.name)
    return []
  }
  const added = commands.filter(command => !state.sentSkillNames.has(command.name))
  const names = new Set(commands.map(command => command.name))
  const removedNames = [...state.sentSkillNames].filter(name => !names.has(name))
  for (const name of removedNames) state.sentSkillNames.delete(name)
  if (!added.length && !removedNames.length) return []
  const isInitial = state.sentSkillNames.size === 0
  for (const command of added) state.sentSkillNames.add(command.name)
  logForDebugging(`Sending ${added.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${removedNames.length} removed, ${state.sentSkillNames.size} total sent)`)
  const window = getContextWindowForModel(toolUseContext.options.engineModel, getSdkBetas())
  const { content, truncation } = added.length ? formatCommandsWithinBudgetDetailed(added, window) : { content: '', truncation: null }
  return [{ type: 'skill_listing', content, skillCount: added.length, isInitial, removedNames, truncation }]
}

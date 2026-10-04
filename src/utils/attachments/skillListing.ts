import { readdir, stat } from 'fs/promises'
import { relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { getProjectRoot, getSdkBetas } from '../../bootstrap/state.js'
import { getMcpSkillCommands, getSkillToolCommands } from '../../commands.js'
import { formatCommandsWithinBudgetDetailed } from '../../tools/SkillTool/prompt.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import { getContextWindowForModel } from '../context.js'
import { logForDebugging } from '../debug.js'
import type { Attachment } from './types.js'
import { capsuleStateFor, resetCapsuleSkillNames, suppressCapsuleSkillListing } from './capsuleState.js'

export async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const triggers = toolUseContext.dynamicSkillDirTriggers
  if (!triggers?.size) return []
  const directories = [...triggers]
  const rows = await Promise.all(directories.map(async skillDir => {
    try {
      const entries = await readdir(skillDir, { withFileTypes: true })
      const names = await Promise.all(entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(async entry => {
        try {
          await stat(resolve(skillDir, entry.name, 'SKILL.md'))
          return entry.name
        } catch {
          return null
        }
      }))
      const skillNames = names.filter((name): name is string => name !== null)
      return skillNames.length ? { type: 'dynamic_skill' as const, skillDir, skillNames, displayPath: relative(getCwd(), skillDir) } : null
    } catch {
      return null
    }
  }))
  for (const directory of directories) triggers.delete(directory)
  return rows.filter((row): row is NonNullable<typeof row> => row !== null)
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
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))) return []
  const state = capsuleStateFor(toolUseContext, toolUseContext.messages)
  const localCommands = await getSkillToolCommands(getProjectRoot())
  const mcpSkills = getMcpSkillCommands(toolUseContext.getAppState().mcp.commands)
  const commands = mcpSkills.length ? uniqBy([...localCommands, ...mcpSkills], 'name') : localCommands
  const sent = state.sentSkillNames
  if (state.suppressNextSkills) {
    state.suppressNextSkills = false
    for (const command of commands) sent.add(command.name)
    return []
  }
  const current = new Set(commands.map(command => command.name))
  const newSkills = commands.filter(command => !sent.has(command.name))
  const removedNames = [...sent].filter(name => !current.has(name))
  for (const name of removedNames) sent.delete(name)
  if (!newSkills.length && !removedNames.length) return []
  const isInitial = sent.size === 0
  for (const command of newSkills) sent.add(command.name)
  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${removedNames.length} removed, ${sent.size} total sent)`,
  )
  const contextWindowTokens = getContextWindowForModel(toolUseContext.options.engineModel, getSdkBetas())
  const formatted = newSkills.length ? formatCommandsWithinBudgetDetailed(newSkills, contextWindowTokens) : { content: '', truncation: null }
  return [{ type: 'skill_listing', content: formatted.content, skillCount: newSkills.length, isInitial, removedNames, truncation: formatted.truncation }]
}

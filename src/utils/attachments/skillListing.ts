
import { readdir, stat } from 'fs/promises'
import { relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { getProjectRoot, getSdkBetas } from '../../bootstrap/state.js'
import { getMcpSkillCommands, getSkillToolCommands } from '../../commands.js'
import { formatCommandsWithinBudgetDetailed } from '../../tools/SkillTool/prompt.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import type { Command } from '../../types/command.js'
import { getContextWindowForModel } from '../context.js'
import { logForDebugging } from '../debug.js'
import type { Attachment } from './types.js'


export async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  if (
    toolUseContext.dynamicSkillDirTriggers &&
    toolUseContext.dynamicSkillDirTriggers.size > 0
  ) {
    const perDirResults = await Promise.all(
      Array.from(toolUseContext.dynamicSkillDirTriggers).map(async skillDir => {
        try {
          const entries = await readdir(skillDir, { withFileTypes: true })
          const candidates = entries
            .filter(e => e.isDirectory() || e.isSymbolicLink())
            .map(e => e.name)
          const checked = await Promise.all(
            candidates.map(async name => {
              try {
                await stat(resolve(skillDir, name, 'SKILL.md'))
                return name
              } catch {
                return null
              }
            }),
          )
          return {
            skillDir,
            skillNames: checked.filter((n): n is string => n !== null),
          }
        } catch {
          return { skillDir, skillNames: [] }
        }
      }),
    )

    for (const { skillDir, skillNames } of perDirResults) {
      if (skillNames.length > 0) {
        attachments.push({
          type: 'dynamic_skill',
          skillDir,
          skillNames,
          displayPath: relative(getCwd(), skillDir),
        })
      }
    }

    toolUseContext.dynamicSkillDirTriggers.clear()
  }

  return attachments
}

const sentSkillNames = new Map<string, Set<string>>()

export function resetSentSkillNames(): void {
  sentSkillNames.clear()
  suppressNext = false
}

export function suppressNextSkillListing(): void {
  suppressNext = true
}
let suppressNext = false

export async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return []
  }

  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))
  ) {
    return []
  }

  const cwd = getProjectRoot()
  const localCommands = await getSkillToolCommands(cwd)
  const mcpSkills = getMcpSkillCommands(
    toolUseContext.getAppState().mcp.commands,
  )
  let allCommands =
    mcpSkills.length > 0
      ? uniqBy([...localCommands, ...mcpSkills], 'name')
      : localCommands

  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) {
    sent = new Set()
    sentSkillNames.set(agentKey, sent)
  }

  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) {
      sent.add(cmd.name)
    }
    return []
  }

  const newSkills = allCommands.filter((cmd: Command) => !sent.has(cmd.name))

  const currentNames = new Set(allCommands.map(cmd => cmd.name))
  const removedNames = [...sent].filter(name => !currentNames.has(name))
  for (const name of removedNames) {
    sent.delete(name)
  }

  if (newSkills.length === 0 && removedNames.length === 0) {
    return []
  }

  const isInitial = sent.size === 0

  for (const cmd of newSkills) {
    sent.add(cmd.name)
  }

  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${removedNames.length} removed, ${sent.size} total sent)`,
  )

  const contextWindowTokens = getContextWindowForModel(
    toolUseContext.options.mainLoopModel,
    getSdkBetas(),
  )
  const formatted =
    newSkills.length > 0
      ? formatCommandsWithinBudgetDetailed(newSkills, contextWindowTokens)
      : { content: '', truncation: null }

  return [
    {
      type: 'skill_listing',
      content: formatted.content,
      skillCount: newSkills.length,
      isInitial,
      removedNames,
      truncation: formatted.truncation,
    },
  ]
}

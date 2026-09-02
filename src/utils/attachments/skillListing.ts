// Skill listing + discovery producers — dynamic skill-dir announcements, the
// per-agent sent-set dedup (subagents get their own turn-0 listing), the
// --resume suppression seam (conversationRecovery), and the bundled+MCP
// filter that resolves the subagent turn-0 gap. Owned Mercury module
//

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


/**
 * Announce skill directories the turn's file operations uncovered: drain
 * ToolUseContext.dynamicSkillDirTriggers, list each directory's skills
 * (a skill = a subdirectory holding SKILL.md), and clear the set.
 */
export async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  if (
    toolUseContext.dynamicSkillDirTriggers &&
    toolUseContext.dynamicSkillDirTriggers.size > 0
  ) {
    // All triggered directories list concurrently…
    const perDirResults = await Promise.all(
      Array.from(toolUseContext.dynamicSkillDirTriggers).map(async skillDir => {
        try {
          const entries = await readdir(skillDir, { withFileTypes: true })
          const candidates = entries
            .filter(e => e.isDirectory() || e.isSymbolicLink())
            .map(e => e.name)
          // …and inside each, every candidate's SKILL.md stats concurrently.
          const checked = await Promise.all(
            candidates.map(async name => {
              try {
                await stat(resolve(skillDir, name, 'SKILL.md'))
                return name
              } catch {
                return null // no SKILL.md ⇒ not a skill
              }
            }),
          )
          return {
            skillDir,
            skillNames: checked.filter((n): n is string => n !== null),
          }
        } catch {
          // An unreadable or vanished directory announces nothing.
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

// The sent ledger: which skill names each agent has already been told
// about, keyed by agentId ('' = main thread). Per-agent scoping is what
// gives every subagent its own turn-0 listing — one shared set would let
// the main thread's announcements dedup the subagents' down to nothing.
const sentSkillNames = new Map<string, Set<string>>()

// Reset only on a REAL roster change — an extensions reload, a skill file
// moving on disk — so the newcomers announce. Compaction deliberately
// does not reset: re-injecting the listing after every compact spends
// thousands of tokens per event and buys almost nothing.
export function resetSentSkillNames(): void {
  sentSkillNames.clear()
  suppressNext = false
}

/**
 * Arm a one-shot suppression of the next listing injection —
 * conversationRecovery arms it on --resume whenever the transcript already
 * carries a skill_listing attachment.
 *
 * Why it exists: the sent ledger is module state, so a fresh process boots
 * with it empty. Resume without this one-shot means the prior process's
 * ~600-token listing gets injected AGAIN into a conversation that already
 * contains it — on every single resume, worst for frequently-respawning
 * headless daemons.
 *
 * The accepted cost: a skill added between processes stays unannounced
 * until the next fresh session. Fine — cross-process deltas were never
 * this feature's job, and the Skill tool's runtime registry serves the
 * skill either way.
 */
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

  // No Skill tool in the pool ⇒ the listing would advertise the unusable.
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

  // The armed one-shot: the transcript already holds a listing from the
  // previous process, so everything currently known counts as sent —
  // future announcements cover only what arrives after the resume
  // (an /extensions reload, a new skill file).
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) {
      sent.add(cmd.name)
    }
    return []
  }

  const newSkills = allCommands.filter((cmd: Command) => !sent.has(cmd.name))

  // The removal arm (FN-013 MCP-01): names the model was told about that
  // have LEFT the governed roster — a kit dial to off or invocable, a
  // skill file gone, an MCP server disconnected. Without it the earlier
  // listing stands in the transcript and the model discovers the de-apply
  // only by calling the skill. Pruned from the ledger in the same pass, so
  // a later re-enable announces as an addition.
  const currentNames = new Set(allCommands.map(cmd => cmd.name))
  const removedNames = [...sent].filter(name => !currentNames.has(name))
  for (const name of removedNames) {
    sent.delete(name)
  }

  if (newSkills.length === 0 && removedNames.length === 0) {
    return []
  }

  // An empty ledger marks this as the conversation's first listing.
  const isInitial = sent.size === 0

  for (const cmd of newSkills) {
    sent.add(cmd.name)
  }

  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${removedNames.length} removed, ${sent.size} total sent)`,
  )

  // The shared budget formatter keeps the listing inside its share of the
  // model's context window; its degradation record rides the attachment so
  // a name-only or withheld entry is a stated fact, never a silent one
  // (FN-013 MCP-05).
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

import memoize from 'lodash-es/memoize.js'

import { getSkillToolCommands } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { Command } from '../../types/command.js'
import { logError } from '../../utils/log.js'
import { truncateToWidth } from '../../utils/format.js'
import { SKILL_TOOL_NAME } from './constants.js'


export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000
export const MAX_LISTING_DESC_CHARS = 250

const MIN_DESCRIPTION_ALLOWANCE = 20
const NAME_OVERHEAD = 4

export function getCharBudget(contextWindowTokens?: number): number {
  const override = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  if (Number.isFinite(override) && override !== 0) return override
  if (contextWindowTokens !== undefined && contextWindowTokens > 0) {
    return Math.floor(contextWindowTokens * SKILL_BUDGET_CONTEXT_PERCENT * CHARS_PER_TOKEN)
  }
  return DEFAULT_CHAR_BUDGET
}

type ListingCommand = Command & { whenToUse?: string; loadedFrom?: string }

function entryDescription(command: ListingCommand): string {
  const whenToUse = command.whenToUse
  const joined = whenToUse ? `${command.description} - ${whenToUse}` : command.description
  return joined.length > MAX_LISTING_DESC_CHARS ? `${joined.slice(0, MAX_LISTING_DESC_CHARS - 1)}…` : joined
}

function entryLine(name: string, description: string): string {
  return description.length > 0 ? `- ${name}: ${description}` : `- ${name}`
}

function isBundled(command: ListingCommand): boolean {
  return command.loadedFrom === 'bundled'
}

export type SkillListingTruncation = {
  budgetChars: number
  nameOnly: number
  withheld: number
}

export function formatCommandsWithinBudgetDetailed(
  commands: Command[],
  contextWindowTokens?: number,
): { content: string; truncation: SkillListingTruncation | null } {
  const budget = getCharBudget(contextWindowTokens)
  const entries = (commands as ListingCommand[]).map(command => ({
    command,
    name: command.name,
    description: entryDescription(command),
  }))
  const fullLines = entries.map(entry => entryLine(entry.name, entry.description))
  const fullWidth =
    fullLines.reduce((total, line) => total + stringWidth(line), 0) + Math.max(0, fullLines.length - 1)
  if (fullWidth <= budget) return { content: fullLines.join('\n'), truncation: null }

  const bundled = entries.filter(entry => isBundled(entry.command))
  const nonBundled = entries.filter(entry => !isBundled(entry.command))
  if (nonBundled.length === 0) return { content: fullLines.join('\n'), truncation: null }

  const bundledCost = bundled.reduce(
    (total, entry) => total + stringWidth(entryLine(entry.name, entry.description)) + 1,
    0,
  )
  const nameOverhead = nonBundled.reduce((total, entry) => total + stringWidth(entry.name) + NAME_OVERHEAD, 0)
  const joiningNewlines = Math.max(0, nonBundled.length - 1)
  const remaining = budget - bundledCost - nameOverhead - joiningNewlines
  const allowance = Math.floor(remaining / nonBundled.length)

  if (allowance >= MIN_DESCRIPTION_ALLOWANCE) {
    const lines = entries.map(entry => {
      if (isBundled(entry.command)) return entryLine(entry.name, entry.description)
      return entryLine(entry.name, truncateToWidth(entry.description, allowance))
    })
    return { content: lines.join('\n'), truncation: null }
  }

  const keptNonBundled = new Set<ListingCommand>()
  let width = bundledCost
  for (const entry of nonBundled) {
    const lineWidth = stringWidth(entryLine(entry.name, '')) + 1
    if (width + lineWidth > budget) break
    width += lineWidth
    keptNonBundled.add(entry.command)
  }
  const lines = entries
    .filter(entry => isBundled(entry.command) || keptNonBundled.has(entry.command))
    .map(entry => (isBundled(entry.command) ? entryLine(entry.name, entry.description) : entryLine(entry.name, '')))
  return {
    content: lines.join('\n'),
    truncation: {
      budgetChars: budget,
      nameOnly: keptNonBundled.size,
      withheld: nonBundled.length - keptNonBundled.size,
    },
  }
}

export function formatCommandsWithinBudget(commands: Command[], contextWindowTokens?: number): string {
  return formatCommandsWithinBudgetDetailed(commands, contextWindowTokens).content
}

function buildPrompt(): string {
  return `Run a skill inline in this conversation.

Before acting on a request, sweep the available skills for one that covers it. When the user says "slash command" or types "/something", they mean a skill — invoke it with this tool.

How to invoke:
- A bare skill name: skill: "commit"
- With arguments: skill: "review", args: "src/server.ts"
- An extension's skill by its namespaced name: skill: "<extension>:skill"

The available skills ride in system-reminder messages in this conversation.

Rules:
- A matching skill BLOCKS everything else: invoke it ahead of any other response to the task.
- Naming a skill means invoking it through this tool — never one without the other.
- A skill already running is never re-invoked.
- Built-in CLI commands are not skills and cannot be invoked here.
- If a <${COMMAND_NAME_TAG}> tag appears in the current turn, that skill is already loaded: follow its instructions directly instead of calling ${SKILL_TOOL_NAME} again.`
}

const promptForRoot = memoize(async (_cwd: string): Promise<string> => buildPrompt())

export async function getPrompt(cwd: string): Promise<string> {
  return promptForRoot(cwd)
}

export function clearPromptCache(): void {
  promptForRoot.cache.clear?.()
}

export async function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export async function getSkillToolInfo(cwd: string): Promise<{ totalCommands: number; includedCommands: number }> {
  const commands = await getSkillToolCommands(cwd)
  return { totalCommands: commands.length, includedCommands: commands.length }
}

export async function getSkillInfo(cwd: string): Promise<{ totalSkills: number; includedSkills: number }> {
  try {
    const commands = await getSkillToolCommands(cwd)
    return { totalSkills: commands.length, includedSkills: commands.length }
  } catch (error) {
    logError(error)
    return { totalSkills: 0, includedSkills: 0 }
  }
}

import memoize from 'lodash-es/memoize.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

import { getSkillToolCommands } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { Command } from '../../types/command.js'
import { truncateToWidth } from '../../utils/format.js'
import { MAX_LISTING_DESC_CHARS } from './constants.js'


const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
const CHARS_PER_TOKEN = 4
const DEFAULT_CHAR_BUDGET = 8_000

const MIN_DESCRIPTION_ALLOWANCE = 20
const NAME_OVERHEAD = 4

function getCharBudget(contextWindowTokens?: number): number {
  const override = Number(flagEnv('MERCURY_SKILL_CHAR_BUDGET'))
  if (Number.isFinite(override) && override !== 0) return override
  if (contextWindowTokens !== undefined && contextWindowTokens > 0) {
    return Math.floor(contextWindowTokens * SKILL_BUDGET_CONTEXT_PERCENT * CHARS_PER_TOKEN)
  }
  return DEFAULT_CHAR_BUDGET
}

type ListingCommand = Command & { whenToUse?: string; loadedFrom?: string }

const SENTENCE_CLIP_FLOOR = 0.7

function clipDescription(description: string, limit: number, width = false): string {
  if ((width ? stringWidth(description) : description.length) <= limit) return description
  const head = width ? truncateToWidth(description, limit).slice(0, -1) : description.slice(0, limit - 1)
  const sentence = /^[\s\S]*[.!?](?=\s)/.exec(head)
  if (sentence && sentence[0].length >= limit * SENTENCE_CLIP_FLOOR) return sentence[0]
  if (/\s/.test(description.charAt(head.length))) return `${head.trimEnd()}…`
  const boundary = /\s\S*$/.exec(head)
  return `${boundary && boundary.index > 0 ? head.slice(0, boundary.index).trimEnd() : head}…`
}
function entryDescription(command: ListingCommand): string {
  const whenToUse = command.whenToUse
  const joined = whenToUse ? `${command.description} - ${whenToUse}` : command.description
  return clipDescription(joined, MAX_LISTING_DESC_CHARS)
}

function entryLine(name: string, description: string): string {
  return description.length > 0 ? `- ${name}: ${description}` : `- ${name}`
}

function isBundled(command: ListingCommand): boolean {
  return command.loadedFrom === 'bundled'
}

type SkillListingTruncation = {
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
      return entryLine(entry.name, clipDescription(entry.description, allowance, true))
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
  return `Runs a skill inline in this conversation, by name, with optional arguments. The skills on offer ride in system-reminder messages in this conversation; a request one of them covers goes through that skill first, and a user's "slash command" or "/something" means a skill. A skill named in a <${COMMAND_NAME_TAG}> tag in the current turn is already loaded, and its instructions apply directly.`
}


const promptForRoot = memoize(async (_cwd: string): Promise<string> => buildPrompt())

export async function getPrompt(cwd: string): Promise<string> {
  return promptForRoot(cwd)
}

export async function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export async function getSkillToolInfo(cwd: string): Promise<{ totalCommands: number; includedCommands: number }> {
  const commands = await getSkillToolCommands(cwd)
  return { totalCommands: commands.length, includedCommands: commands.length }
}

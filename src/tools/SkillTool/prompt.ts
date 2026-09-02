import memoize from 'lodash-es/memoize.js'

import { getSkillToolCommands } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { Command } from '../../types/command.js'
import { logError } from '../../utils/log.js'
import { truncateToWidth } from '../../utils/format.js'
import { SKILL_TOOL_NAME } from './constants.js'

/**
 * The skill-listing character budget and the model-facing skill invocation
 * doctrine.
 */

/** The listing budget as a fraction of the context window. */
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
/** Characters per token, for turning the token budget into characters. */
export const CHARS_PER_TOKEN = 4
/** The fallback budget when no context window size is known. */
export const DEFAULT_CHAR_BUDGET = 8_000
/** Per-entry description cap, measured in code units (not display cells). */
export const MAX_LISTING_DESC_CHARS = 250

/** Below this per-entry allowance non-bundled entries degrade to names only. */
const MIN_DESCRIPTION_ALLOWANCE = 20
/** `- ` before the name and `: ` after it. */
const NAME_OVERHEAD = 4

/**
 * The listing budget in characters: the environment override (contract
 * data: SLASH_COMMAND_TOOL_CHAR_BUDGET) wins when it parses as a non-zero
 * number; otherwise 1% of the context window at 4 characters per token; or
 * the fixed fallback when the window is unknown.
 */
export function getCharBudget(contextWindowTokens?: number): number {
  const override = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  if (Number.isFinite(override) && override !== 0) return override
  if (contextWindowTokens !== undefined && contextWindowTokens > 0) {
    return Math.floor(contextWindowTokens * SKILL_BUDGET_CONTEXT_PERCENT * CHARS_PER_TOKEN)
  }
  return DEFAULT_CHAR_BUDGET
}

type ListingCommand = Command & { whenToUse?: string; loadedFrom?: string }

/**
 * The entry description: the command description joined to its "when to
 * use" text with a dash, then hard-capped at 250 code units (truncate to
 * 249 and append an ellipsis).
 */
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

/** The machine-readable degradation record (FN-013 MCP-05): what the
 *  budget did to the listing. null ⇒ nothing degraded (descriptions may be
 *  evenly shortened, but every entry still carries one). */
export type SkillListingTruncation = {
  /** The character budget the listing was fitted into. */
  budgetChars: number
  /** Entries reduced to name-only (their selection signal removed). */
  nameOnly: number
  /** Entries withheld entirely — even their names did not fit. */
  withheld: number
}

/**
 * Render the dash-prefixed `name: description` listing within the budget.
 * Bundled commands always keep their full descriptions; the remaining
 * budget is shared evenly among the non-bundled ones, which degrade to
 * names only below a 20-character allowance — and when even the name-only
 * set does not fit, trailing non-bundled names are withheld rather than
 * silently overflowing. When every command is bundled the full listing is
 * returned even if it overflows. The truncation record makes every
 * degradation observable to the caller (FN-013 MCP-05 — the silent
 * name-only fall left the catalogue unselectable with no error, no
 * warning and no /context row).
 */
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
    // Evenly shortened, every entry still described — not a degradation.
    const lines = entries.map(entry => {
      if (isBundled(entry.command)) return entryLine(entry.name, entry.description)
      return entryLine(entry.name, truncateToWidth(entry.description, allowance))
    })
    return { content: lines.join('\n'), truncation: null }
  }

  // Name-only fall — and, when even names overflow, bounded withholding:
  // bundled entries always render whole; non-bundled names keep landing in
  // original order while they fit, the rest are withheld AND COUNTED.
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

/** The string-only view — callers that only need the rendered listing. */
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

/** The model-facing skill prompt, memoized per project root. */
export async function getPrompt(cwd: string): Promise<string> {
  return promptForRoot(cwd)
}

export function clearPromptCache(): void {
  promptForRoot.cache.clear?.()
}

/** The commands the skill listing includes for this project (all of them; only descriptions are truncated). */
export async function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

/** Total and included command counts for the current project (currently equal). */
export async function getSkillToolInfo(cwd: string): Promise<{ totalCommands: number; includedCommands: number }> {
  const commands = await getSkillToolCommands(cwd)
  return { totalCommands: commands.length, includedCommands: commands.length }
}

/** The skill variant swallows errors and reports zeros rather than throwing. */
export async function getSkillInfo(cwd: string): Promise<{ totalSkills: number; includedSkills: number }> {
  try {
    const commands = await getSkillToolCommands(cwd)
    return { totalSkills: commands.length, includedSkills: commands.length }
  } catch (error) {
    logError(error)
    return { totalSkills: 0, includedSkills: 0 }
  }
}

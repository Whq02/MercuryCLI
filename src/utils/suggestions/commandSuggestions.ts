import Fuse from 'fuse.js'

import type { Command } from '../../commands.js'
import type { MenuLiveState } from '../../types/command.js'
import { formatDescriptionWithSource, getCommandName } from '../../commands.js'
import { getSkillUsageScore } from './skillUsageTracking.js'

/**
 * Slash-command typeahead: matching, ranking, categorisation, application
 * and highlight positions.
 */

export type MidInputSlashCommand = {
  token: string
  startPos: number
  partialCommand: string
}

export type CommandSuggestionItem = {
  id: string
  displayText: string
  tag?: string
  /** Live value of the mode/setting the command owns (menu-open snapshot). */
  value?: string
  description?: string
  metadata?: unknown
}

export function isCommandInput(input: string): boolean {
  return input.startsWith('/')
}

/** A space that is not merely trailing means arguments have begun. */
export function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) return false
  const spaceIndex = input.indexOf(' ')
  if (spaceIndex === -1) return false
  return spaceIndex !== input.length - 1 || input.trimEnd().includes(' ')
}

export function formatCommand(name: string): string {
  return `/${name} `
}

type CommandLike = Command & {
  isHidden?: boolean
  aliases?: string[]
  argNames?: string[]
  kind?: string
  source?: string
  type: string
}

function suggestionIdentifier(command: CommandLike): string {
  const name = getCommandName(command)
  if (command.type === 'prompt') {
    // Only prompt commands can collide (built-ins are defined once in
    // code); the extension id disambiguates extension-provided ones.
    const repository = (command as { extensionInfo?: { id?: string } }).extensionInfo?.id
    return `${name}-${command.source ?? 'unknown'}${repository !== undefined ? `-${repository}` : ''}`
  }
  return `${name}-${command.type}`
}

function toSuggestionItem(
  command: CommandLike,
  typedQuery: string,
  live: MenuLiveState = {},
): CommandSuggestionItem {
  const name = getCommandName(command)
  // Live row value: the command's own reader, guarded — a throwing or slow
  // owner must cost the menu nothing (the row simply renders valueless).
  let value: string | undefined
  if (command.currentValue !== undefined) {
    try {
      value = command.currentValue(live)
    } catch {
      value = undefined
    }
  }
  // The alias parenthetical appears only when the user actually typed a
  // prefix of that alias.
  let aliasSuffix = ''
  if (typedQuery !== '') {
    const matchedAlias = (command.aliases ?? []).find(alias => alias.toLowerCase().startsWith(typedQuery))
    if (matchedAlias !== undefined) aliasSuffix = ` (${matchedAlias})`
  }
  const isWorkflow = command.type === 'prompt' && command.kind === 'workflow'
  let description = isWorkflow ? command.description : formatDescriptionWithSource(command)
  if (command.type === 'prompt' && command.argNames !== undefined && command.argNames.length > 0) {
    description += ` (arguments: ${command.argNames.join(', ')})`
  }
  return {
    id: suggestionIdentifier(command),
    displayText: `/${name}${aliasSuffix}`,
    ...(isWorkflow ? { tag: 'workflow' } : {}),
    ...(value !== undefined && value !== '' ? { value } : {}),
    description,
    metadata: command,
  }
}

const MAX_RECENTLY_USED = 5

function emptyQuerySuggestions(commands: Command[], live: MenuLiveState): CommandSuggestionItem[] {
  const visible = (commands as CommandLike[]).filter(cmd => !cmd.isHidden)

  // Up to five most-used prompt commands with a positive usage score.
  const recentlyUsed = visible
    .filter(cmd => cmd.type === 'prompt')
    .map(cmd => ({ cmd, score: getSkillUsageScore(getCommandName(cmd)) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RECENTLY_USED)
    .map(entry => entry.cmd)
  const recentIds = new Set(recentlyUsed.map(cmd => suggestionIdentifier(cmd)))

  const remaining = visible.filter(cmd => !recentIds.has(suggestionIdentifier(cmd)))
  const byName = (a: CommandLike, b: CommandLike): number =>
    getCommandName(a).localeCompare(getCommandName(b))

  // Built-ins directly after recently-used, so they stay visible when many
  // skills are installed; then user/local, project, policy, the rest.
  const builtins = remaining.filter(cmd => cmd.type !== 'prompt').sort(byName)
  const userLocal = remaining.filter(
    cmd => cmd.type === 'prompt' && (cmd.source === 'userSettings' || cmd.source === 'localSettings'),
  ).sort(byName)
  const project = remaining.filter(cmd => cmd.type === 'prompt' && cmd.source === 'projectSettings').sort(byName)
  const policy = remaining.filter(cmd => cmd.type === 'prompt' && cmd.source === 'policySettings').sort(byName)
  const claimed = new Set([...builtins, ...userLocal, ...project, ...policy].map(cmd => suggestionIdentifier(cmd)))
  const everythingElse = remaining.filter(cmd => !claimed.has(suggestionIdentifier(cmd))).sort(byName)

  return [...recentlyUsed, ...builtins, ...userLocal, ...project, ...policy, ...everythingElse].map(cmd =>
    toSuggestionItem(cmd, '', live),
  )
}

type IndexedCommand = {
  command: CommandLike
  name: string
  nameParts: string[]
  aliases: string[]
  descriptionWords: string[]
}

// Rebuilt only when the identity of the commands array changes, so typing
// does not rebuild per keystroke; hidden commands are excluded AT BUILD
// TIME.
let indexedFor: Command[] | null = null
let fuseIndex: Fuse<IndexedCommand> | null = null

function getFuseIndex(commands: Command[]): Fuse<IndexedCommand> {
  if (indexedFor === commands && fuseIndex !== null) return fuseIndex
  const indexed: IndexedCommand[] = (commands as CommandLike[])
    .filter(cmd => !cmd.isHidden)
    .map(cmd => {
      const name = getCommandName(cmd)
      const nameParts = name.split(/[:_-]/)
      return {
        command: cmd,
        name,
        nameParts: nameParts.length > 1 ? nameParts : [],
        aliases: cmd.aliases ?? [],
        descriptionWords: cmd.description
          .split(/\s+/)
          .map(word => word.toLowerCase().replace(/[^a-z0-9]/g, ''))
          .filter(word => word !== ''),
      }
    })
  fuseIndex = new Fuse(indexed, {
    keys: [
      { name: 'name', weight: 3 },
      { name: 'nameParts', weight: 2 },
      { name: 'aliases', weight: 2 },
      { name: 'descriptionWords', weight: 0.5 },
    ],
    threshold: 0.3,
    location: 0,
    distance: 100,
    includeScore: true,
  })
  indexedFor = commands
  return fuseIndex
}

function rankResults(
  results: Array<{ item: IndexedCommand; score?: number }>,
  query: string,
): CommandLike[] {
  type Ranked = {
    command: CommandLike
    tier: number
    tieBreak: number
    fuzzyScore: number
  }
  const ranked: Ranked[] = results.map(result => {
    const { item } = result
    const name = item.name.toLowerCase()
    const aliases = item.aliases.map(alias => alias.toLowerCase())
    let tier = 4
    let tieBreak = 0
    if (name === query) tier = 0
    else if (aliases.includes(query)) tier = 1
    else if (name.startsWith(query)) {
      tier = 2
      tieBreak = item.name.length
    } else {
      const prefixAlias = aliases.find(alias => alias.startsWith(query))
      if (prefixAlias !== undefined) {
        tier = 3
        tieBreak = prefixAlias.length
      }
    }
    return { command: item.command, tier, tieBreak, fuzzyScore: result.score ?? 1 }
  })
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.tier === 2 || a.tier === 3) {
      if (a.tieBreak !== b.tieBreak) return a.tieBreak - b.tieBreak
    }
    // Near-equal fuzzy scores break toward the more-used command.
    if (Math.abs(a.fuzzyScore - b.fuzzyScore) < 0.1) {
      return getSkillUsageScore(getCommandName(b.command)) - getSkillUsageScore(getCommandName(a.command))
    }
    return a.fuzzyScore - b.fuzzyScore
  })
  return ranked.map(entry => entry.command)
}

export function generateCommandSuggestions(
  input: string,
  commands: Command[],
  live: MenuLiveState = {},
): CommandSuggestionItem[] {
  // Both gates precede any matching work: non-command input, and a command
  // that already has arguments.
  if (!isCommandInput(input)) return []
  if (hasCommandArgs(input)) return []

  const query = input.slice(1).toLowerCase().trim()
  if (query === '') return emptyQuerySuggestions(commands, live)

  const results = getFuseIndex(commands).search(query)
  const orderedCommands = rankResults(results, query)
  let items = orderedCommands.map(cmd => toSuggestionItem(cmd, query, live))

  // The hidden-command escape hatch: an exact typed name surfaces a hidden
  // command — unless a VISIBLE command shares the name (the user's
  // deliberate override wins), and never twice.
  const hiddenExact = (commands as CommandLike[]).find(cmd => cmd.isHidden && getCommandName(cmd).toLowerCase() === query)
  if (hiddenExact !== undefined) {
    const visibleSameName = (commands as CommandLike[]).some(
      cmd => !cmd.isHidden && getCommandName(cmd).toLowerCase() === query,
    )
    const alreadyPresent = items.some(item => item.id === suggestionIdentifier(hiddenExact))
    if (!visibleSameName && !alreadyPresent) {
      // Prepended, not replacing — visible prefix-siblings stay listed.
      items = [toSuggestionItem(hiddenExact, query, live), ...items]
    }
  }
  // Deliberately NOT de-duplicated by name: same-named commands from
  // different sources are genuinely different.
  return items
}

/**
 * A `/` after whitespace (never at position 0) starts a mid-input command.
 * The backwards scan avoids lookbehind assertions for performance.
 */
export function findMidInputSlashCommand(input: string, cursorOffset: number): MidInputSlashCommand | null {
  const beforeCursor = input.slice(0, cursorOffset)
  const match = beforeCursor.match(/\s(\/[A-Za-z0-9_:-]*)$/)
  if (!match || match.index === undefined) return null
  const slashPos = match.index + 1
  if (slashPos === 0) return null
  // The token continues past the cursor up to the next whitespace.
  let end = cursorOffset
  while (end < input.length && !/\s/.test(input[end] as string)) end++
  const token = input.slice(slashPos, end)
  // A cursor past the command (into arguments) means no mid-input command.
  if (cursorOffset > slashPos + token.length) return null
  return { token, startPos: slashPos, partialCommand: (match[1] as string).slice(1) }
}

/** First suggestion whose name starts with the partial (case-insensitive) with a non-empty remainder. */
export function getBestCommandMatch(
  partialCommand: string,
  commands: Command[],
): { suffix: string; fullCommand: string } | null {
  if (partialCommand === '') return null
  const suggestions = generateCommandSuggestions(`/${partialCommand}`, commands)
  const lowered = partialCommand.toLowerCase()
  for (const suggestion of suggestions) {
    const name = getCommandName(suggestion.metadata as Command)
    if (!name.toLowerCase().startsWith(lowered)) continue
    const suffix = name.slice(partialCommand.length)
    if (suffix === '') continue
    return { suffix, fullCommand: name }
  }
  return null
}

/** NAME-ANCHORED (the bare-↵ law): the command's name, a name part or an
 *  alias starts with the typed fragment. The Fuse index also matches
 *  DESCRIPTION words — wanted for the visible menu, but a bare ↵ (nothing
 *  arrowed) auto-applies the top row, and a description-only match then
 *  EXECUTES a command the operator never named: a typed "/theme" ran
 *  /update-config, a prompt-class skill — a model turn spent on a typo). A bare ↵ applies only a name-anchored
 *  top row; an arrowed pick stays deliberate, whatever matched it. */
export function isNameAnchoredSuggestion(input: string, suggestion: CommandSuggestionItem): boolean {
  if (!input.startsWith('/')) return true
  const fragment = input.slice(1).toLowerCase().trim()
  if (fragment === '') return true
  const cmd = suggestion.metadata as CommandLike | undefined
  if (cmd === undefined || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false
  const name = getCommandName(cmd).toLowerCase()
  if (name.startsWith(fragment)) return true
  if (name.split(/[:_-]/).some(part => part.startsWith(fragment))) return true
  return (cmd.aliases ?? []).some(alias => alias.toLowerCase().startsWith(fragment))
}

export function applyCommandSuggestion(
  suggestion: CommandSuggestionItem | string,
  shouldExecute: boolean,
  commands: Command[],
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void,
): void {
  let command: CommandLike | undefined
  if (typeof suggestion === 'string') {
    command = (commands as CommandLike[]).find(cmd => getCommandName(cmd) === suggestion)
  } else {
    const metadata = suggestion.metadata as CommandLike | undefined
    // An item whose metadata is not a command is rejected.
    if (metadata === undefined || typeof metadata !== 'object' || typeof metadata.type !== 'string') return
    command = metadata
  }
  if (command === undefined) return
  const formatted = formatCommand(getCommandName(command))
  onInputChange(formatted)
  setCursorOffset(formatted.length)
  if (shouldExecute) {
    const takesArguments =
      command.type === 'prompt' && command.argNames !== undefined && command.argNames.length > 0
    if (!takesArguments) {
      onSubmit(formatted, true)
    }
  }
}

/**
 * `/command` spans for syntax highlighting: a slash at the start or after
 * whitespace, then a letter, then command characters — which is what stops
 * absolute paths like /usr/bin from lighting up (only their first segment
 * after whitespace can).
 */
export function findSlashCommandPositions(text: string): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const pattern = /(^|\s)(\/[A-Za-z][A-Za-z0-9:_-]*)/g
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue
    const start = match.index + (match[1] as string).length
    positions.push({ start, end: start + (match[2] as string).length })
  }
  return positions
}

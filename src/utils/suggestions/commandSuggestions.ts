import Fuse from 'fuse.js'

import type { Command } from '../../commands.js'
import { formatDescriptionWithSource, getCommandName } from '../../commands.js'
import { requiresArgument } from '../../skills/argumentHint.js'
import { isRecord } from '../isRecord.js'
import { getSkillUsageScore } from './skillUsageTracking.js'


type MidInputSlashCommand = {
  token: string
  startPos: number
  partialCommand: string
}

type CommandSuggestionItem = {
  id: string
  displayText: string
  value?: string
  description?: string
  metadata?: unknown
}

function isCommandInput(input: string): boolean {
  return input.startsWith('/')
}

export function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) return false
  const spaceIndex = input.indexOf(' ')
  if (spaceIndex === -1) return false
  return spaceIndex !== input.length - 1 || input.trimEnd().includes(' ')
}

function formatCommand(name: string): string {
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
    const repository = (command as { extensionInfo?: { id?: string } }).extensionInfo?.id
    return `${name}-${command.source ?? 'unknown'}${repository !== undefined ? `-${repository}` : ''}`
  }
  return `${name}-${command.type}`
}

function toSuggestionItem(
  command: CommandLike,
  typedQuery: string,
): CommandSuggestionItem {
  const name = getCommandName(command)
  let value: string | undefined
  if (command.currentValue !== undefined) {
    try {
      value = command.currentValue()
    } catch {
      value = undefined
    }
  }
  let aliasSuffix = ''
  if (typedQuery !== '') {
    const matchedAlias = (command.aliases ?? []).find(
      alias => alias.toLowerCase().startsWith(typedQuery) && !name.toLowerCase().startsWith(alias.toLowerCase()),
    )
    if (matchedAlias !== undefined) aliasSuffix = ` (${matchedAlias})`
  }
  let description = formatDescriptionWithSource(command)
  if (command.type === 'prompt' && command.argNames !== undefined && command.argNames.length > 0) {
    description += ` (arguments: ${command.argNames.join(', ')})`
  }
  return {
    id: suggestionIdentifier(command),
    displayText: `/${name}${aliasSuffix}`,
    ...(value !== undefined && value !== '' ? { value } : {}),
    description,
    metadata: command,
  }
}

const MAX_RECENTLY_USED = 5

type IndexedCommand = {
  command: Command
  name: string
  nameParts: string[]
  aliases: string[]
  descriptionWords: string[]
}

let indexedFor: Command[] | null = null
let fuseIndex: Fuse<IndexedCommand> | null = null

function getCommandIndex(commands: Command[]): Fuse<IndexedCommand> {
  if (indexedFor === commands && fuseIndex !== null) return fuseIndex
  const indexed: IndexedCommand[] = []
  for (const command of commands) {
    if (command.isHidden) continue
    const name = getCommandName(command)
    const rawParts = name.split(/[:_-]/).filter(Boolean)
    const nameParts = rawParts.length > 1 ? rawParts : []
    const aliases = command.aliases ?? []
    const descriptionWords = command.description
      .split(/\s+/)
      .map(word => word.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean)
    indexed.push({ command, name, nameParts, aliases, descriptionWords })
  }
  indexedFor = commands
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
  return fuseIndex
}

function rankOf(entry: IndexedCommand, query: string): { tier: number; tieBreak: number } {
  const name = entry.name.toLowerCase()
  const aliases = entry.aliases.map(alias => alias.toLowerCase())
  if (name === query) return { tier: 0, tieBreak: 0 }
  if (aliases.includes(query)) return { tier: 1, tieBreak: 0 }
  if (name.startsWith(query)) return { tier: 2, tieBreak: name.length }
  const matchingAlias = aliases.find(alias => alias.startsWith(query))
  if (matchingAlias !== undefined) return { tier: 3, tieBreak: matchingAlias.length }
  return { tier: 4, tieBreak: 0 }
}

function rankResults(
  results: ReadonlyArray<{ item: IndexedCommand; score?: number }>,
  query: string,
): Command[] {
  return results
    .map(result => ({ command: result.item.command, ...rankOf(result.item, query), score: result.score ?? 1 }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.tieBreak !== b.tieBreak) return a.tieBreak - b.tieBreak
      if (Math.abs(a.score - b.score) < 0.1) {
        return getSkillUsageScore(getCommandName(b.command)) - getSkillUsageScore(getCommandName(a.command))
      }
      return a.score - b.score
    })
    .map(hit => hit.command)
}

function sortByName(commands: Command[]): Command[] {
  return [...commands].sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
}

export function generateCommandSuggestions(
  input: string,
  commands: Command[],
): CommandSuggestionItem[] {
  if (!isCommandInput(input) || hasCommandArgs(input)) return []
  const query = input.slice(1).toLowerCase().trim()

  if (query === '') {
    const visible = commands.filter(cmd => !cmd.isHidden)
    const recentScored = visible
      .map((cmd, index) => ({
        cmd,
        index,
        score: cmd.type === 'prompt' ? getSkillUsageScore(getCommandName(cmd)) : 0,
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, MAX_RECENTLY_USED)
      .map(entry => entry.cmd)

    const claimed = new Set<string>()
    const ordered: Command[] = []
    const take = (group: Command[]): void => {
      for (const cmd of group) {
        const id = suggestionIdentifier(cmd)
        if (claimed.has(id)) continue
        claimed.add(id)
        ordered.push(cmd)
      }
    }

    take(recentScored)
    const remaining = (): Command[] => visible.filter(cmd => !claimed.has(suggestionIdentifier(cmd)))
    take(sortByName(remaining().filter(cmd => cmd.type !== 'prompt')))
    take(sortByName(remaining().filter(cmd => cmd.type === 'prompt' && (cmd.source === 'userSettings' || cmd.source === 'localSettings'))))
    take(sortByName(remaining().filter(cmd => cmd.type === 'prompt' && cmd.source === 'projectSettings')))
    take(sortByName(remaining().filter(cmd => cmd.type === 'prompt' && cmd.source === 'policySettings')))
    take(sortByName(remaining()))

    return ordered.map(cmd => toSuggestionItem(cmd, ''))
  }

  const index = getCommandIndex(commands)
  const ranked = rankResults(index.search(query), query)
  const hasVisibleExact = ranked.some(cmd => getCommandName(cmd).toLowerCase() === query)
  if (!hasVisibleExact) {
    const shownIds = new Set(ranked.map(suggestionIdentifier))
    const hiddenExact = commands.find(
      cmd => cmd.isHidden && getCommandName(cmd).toLowerCase() === query && !shownIds.has(suggestionIdentifier(cmd)),
    )
    if (hiddenExact !== undefined) {
      ranked.unshift(hiddenExact)
    }
  }
  return ranked.map(cmd => toSuggestionItem(cmd, query))
}

export function findMidInputSlashCommand(input: string, cursorOffset: number): MidInputSlashCommand | null {
  const beforeCursor = input.slice(0, cursorOffset)
  const match = beforeCursor.match(/\s(\/[A-Za-z0-9_:-]*)$/)
  if (!match || match.index === undefined) return null
  const slashPos = match.index + 1
  if (slashPos === 0) return null
  let end = cursorOffset
  while (end < input.length && !/\s/.test(input[end] as string)) end++
  const token = input.slice(slashPos, end)
  if (cursorOffset > slashPos + token.length) return null
  return { token, startPos: slashPos, partialCommand: (match[1] as string).slice(1) }
}

function isCommandMetadata(value: unknown): value is Command {
  return isRecord(value) && typeof value.type === 'string'
}

export function getBestCommandMatch(
  partialCommand: string,
  commands: Command[],
): { suffix: string; fullCommand: string } | null {
  if (partialCommand === '') return null
  const suggestions = generateCommandSuggestions(`/${partialCommand}`, commands)
  const lowerPartial = partialCommand.toLowerCase()
  for (const suggestion of suggestions) {
    if (!isCommandMetadata(suggestion.metadata)) continue
    const fullCommand = getCommandName(suggestion.metadata)
    if (fullCommand.toLowerCase().startsWith(lowerPartial) && fullCommand.length > partialCommand.length) {
      return {
        suffix: fullCommand.slice(partialCommand.length),
        fullCommand,
      }
    }
  }
  return null
}

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
  let command: Command | undefined
  if (typeof suggestion === 'string') {
    command = commands.find(cmd => getCommandName(cmd) === suggestion)
  } else if (isCommandMetadata(suggestion.metadata)) {
    command = suggestion.metadata
  }
  if (command === undefined) return
  const formatted = formatCommand(getCommandName(command))
  onInputChange(formatted)
  setCursorOffset(formatted.length)
  if (!shouldExecute) return
  const needsArgs =
    (command.type === 'prompt' && command.argNames !== undefined && command.argNames.length > 0) ||
    requiresArgument(command)
  if (!needsArgs) {
    onSubmit(formatted, true)
  }
}

type ChannelTargetQuery = { kind: 'seat' | 'team'; start: number; query: string }

const CHANNEL_TARGET = /^\/(whisper|team|swarmchat\s+team)\s+/

export function findChannelTargetQuery(input: string, cursorOffset: number): ChannelTargetQuery | null {
  if (cursorOffset !== input.length) return null
  const head = CHANNEL_TARGET.exec(input)
  if (!head) return null
  const token = input.slice(head[0].length)
  const quoted = token.startsWith('"')
  if (!quoted && /\s/.test(token)) return null
  if (quoted && /^"[^"]*"\s/.test(token)) return null
  const query = (quoted ? token.slice(1).replace(/"$/, '') : token).replace(/^@/, '')
  return { kind: head[1] === 'whisper' ? 'seat' : 'team', start: head[0].length, query }
}

type ChannelTargetSeat = { agent: string; name: string; team?: string; captain?: true }
type ChannelTargetCandidate = { key: string; insert: string; description: string }

export function channelTargetCandidates(kind: ChannelTargetQuery['kind'], seats: readonly ChannelTargetSeat[]): ChannelTargetCandidate[] {
  const crew = seats.filter(seat => seat.agent !== 'main' && seat.name.toLowerCase() !== 'owner')
  if (kind === 'seat') {
    const names = new Map<string, number>()
    for (const seat of crew) names.set(seat.name.toLowerCase(), (names.get(seat.name.toLowerCase()) ?? 0) + 1)
    return crew.map(seat => {
      const duplicate = (names.get(seat.name.toLowerCase()) ?? 0) > 1
      return {
        key: duplicate ? `${seat.name} (${seat.agent})` : seat.name,
        insert: duplicate ? seat.agent : /\s/.test(seat.name) ? `"${seat.name}"` : seat.name,
        description: [seat.captain ? 'captain' : '', seat.team ?? ''].filter(Boolean).join(' · '),
      }
    })
  }
  const labels = new Map<string, ChannelTargetSeat[]>()
  for (const seat of crew) {
    if (seat.team === undefined || ['all', 'general'].includes(seat.team.toLowerCase())) continue
    const members = labels.get(seat.team) ?? []
    members.push(seat)
    labels.set(seat.team, members)
  }
  return [...labels].map(([team, members]) => {
    const captain = members.find(seat => seat.captain)
    return { key: team, insert: team, description: captain ? `captain ${captain.name}` : `${members.length} crewmate${members.length === 1 ? '' : 's'}` }
  })
}

export function rankChannelTargets(query: string, candidates: readonly ChannelTargetCandidate[]): CommandSuggestionItem[] {
  const lowered = query.toLowerCase()
  const parts = (key: string): string[] => key.toLowerCase().split(/[\s:_.()-]+/).filter(Boolean)
  const tierOf = (key: string): number => {
    const name = key.toLowerCase()
    if (lowered === '') return 2
    if (name === lowered) return 0
    if (name.startsWith(lowered)) return 2
    if (parts(key).some(part => part.startsWith(lowered))) return 3
    return 4
  }
  const fuzzy = lowered === '' ? new Set(candidates) : new Set(new Fuse([...candidates], { keys: ['key'], threshold: 0.3, location: 0, distance: 100 }).search(lowered).map(result => result.item))
  return candidates
    .map(candidate => ({ candidate, tier: tierOf(candidate.key) }))
    .filter(entry => entry.tier < 4 || fuzzy.has(entry.candidate))
    .sort((a, b) => a.tier - b.tier || (lowered === '' ? 0 : a.candidate.key.length - b.candidate.key.length) || a.candidate.key.localeCompare(b.candidate.key))
    .map(({ candidate }) => ({ id: `channel-${candidate.insert}`, displayText: candidate.key, ...(candidate.description ? { description: candidate.description } : {}), metadata: candidate.insert }))
}

export function findSlashCommandPositions(text: string): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const regex = /(?<=^|\s)\/[A-Za-z][A-Za-z0-9:_-]*/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    positions.push({ start: match.index, end: match.index + match[0].length })
  }
  return positions
}

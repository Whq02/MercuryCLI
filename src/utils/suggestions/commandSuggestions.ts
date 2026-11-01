import Fuse from 'fuse.js'

import type { Command } from '../../commands.js'
import { formatDescriptionWithSource, getCommandName } from '../../commands.js'
import { requiresArgument } from '../../skills/argumentHint.js'
import { getSkillUsageScore } from './skillUsageTracking.js'


type MidInputSlashCommand = {
  token: string
  startPos: number
  partialCommand: string
}

type CommandSuggestionItem = {
  id: string
  displayText: string
  tag?: string
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

function emptyQuerySuggestions(commands: Command[]): CommandSuggestionItem[] {
  const visible = (commands as CommandLike[]).filter(cmd => !cmd.isHidden)

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

  const builtins = remaining.filter(cmd => cmd.type !== 'prompt').sort(byName)
  const userLocal = remaining.filter(
    cmd => cmd.type === 'prompt' && (cmd.source === 'userSettings' || cmd.source === 'localSettings'),
  ).sort(byName)
  const project = remaining.filter(cmd => cmd.type === 'prompt' && cmd.source === 'projectSettings').sort(byName)
  const policy = remaining.filter(cmd => cmd.type === 'prompt' && cmd.source === 'policySettings').sort(byName)
  const claimed = new Set([...builtins, ...userLocal, ...project, ...policy].map(cmd => suggestionIdentifier(cmd)))
  const everythingElse = remaining.filter(cmd => !claimed.has(suggestionIdentifier(cmd))).sort(byName)

  return [...recentlyUsed, ...builtins, ...userLocal, ...project, ...policy, ...everythingElse].map(cmd =>
    toSuggestionItem(cmd, ''),
  )
}

type IndexedCommand = {
  command: CommandLike
  name: string
  nameParts: string[]
  aliases: string[]
  descriptionWords: string[]
}

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
): CommandSuggestionItem[] {
  if (!isCommandInput(input)) return []
  if (hasCommandArgs(input)) return []

  const query = input.slice(1).toLowerCase().trim()
  if (query === '') return emptyQuerySuggestions(commands)

  const results = getFuseIndex(commands).search(query)
  const orderedCommands = rankResults(results, query)
  let items = orderedCommands.map(cmd => toSuggestionItem(cmd, query))

  const hiddenExact = (commands as CommandLike[]).find(cmd => cmd.isHidden && getCommandName(cmd).toLowerCase() === query)
  if (hiddenExact !== undefined) {
    const visibleSameName = (commands as CommandLike[]).some(
      cmd => !cmd.isHidden && getCommandName(cmd).toLowerCase() === query,
    )
    const alreadyPresent = items.some(item => item.id === suggestionIdentifier(hiddenExact))
    if (!visibleSameName && !alreadyPresent) {
      items = [toSuggestionItem(hiddenExact, query), ...items]
    }
  }
  return items
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
    if (metadata === undefined || typeof metadata !== 'object' || typeof metadata.type !== 'string') return
    command = metadata
  }
  if (command === undefined) return
  const formatted = formatCommand(getCommandName(command))
  onInputChange(formatted)
  setCursorOffset(formatted.length)
  if (shouldExecute) {
    const takesArguments =
      (command.type === 'prompt' && command.argNames !== undefined && command.argNames.length > 0) ||
      requiresArgument(command)
    if (!takesArguments) {
      onSubmit(formatted, true)
    }
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
  const pattern = /(^|\s)(\/[A-Za-z][A-Za-z0-9:_-]*)/g
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue
    const start = match.index + (match[1] as string).length
    positions.push({ start, end: start + (match[2] as string).length })
  }
  return positions
}

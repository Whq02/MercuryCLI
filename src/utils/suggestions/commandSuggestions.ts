import Fuse from 'fuse.js'

import type { Command } from '../../commands.js'
import { formatDescriptionWithSource, getCommandName } from '../../commands.js'
import { requiresArgument } from '../../skills/argumentHint.js'
import { getSkillUsageScore } from './skillUsageTracking.js'
import { notBuilt } from '../../pi/holes.js'


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

const MAX_RECENTLY_USED = 5

export function generateCommandSuggestions(
  input: string,
  commands: Command[],
): CommandSuggestionItem[] {
  return notBuilt('src/utils/suggestions/commandSuggestions.ts:209')
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
  return notBuilt('src/utils/suggestions/commandSuggestions.ts:249')
}

export function isNameAnchoredSuggestion(input: string, suggestion: CommandSuggestionItem): boolean {
  return notBuilt('src/utils/suggestions/commandSuggestions.ts:266')
}

export function applyCommandSuggestion(
  suggestion: CommandSuggestionItem | string,
  shouldExecute: boolean,
  commands: Command[],
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void,
): void {
  return notBuilt('src/utils/suggestions/commandSuggestions.ts:278')
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
  return notBuilt('src/utils/suggestions/commandSuggestions.ts:373')
}

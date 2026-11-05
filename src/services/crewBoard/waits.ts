import { posix } from 'node:path'
import { boardLabelKey, type BoardEvent, type BoardPost, type BoardSeat } from './contracts.js'

type PublicKind = 'ask' | 'answer' | 'blocker' | 'result' | 'correction'
export type BoardWaitPredicate =
  | { kind: 'seat'; agent: string; name: string }
  | { kind: 'about'; subject: string }
  | { kind: 'kind'; value: PublicKind }
  | { kind: 'team'; team: string }
export type BoardWait = { eventId: string; seq: number; version: number; predicate: BoardWaitPredicate; standing: boolean }
type RoutedEvent = BoardEvent & { addresses?: string[]; authorRole?: 'peer' | 'owner' | 'system'; channel?: { kind: string }; recipients?: BoardSeat[] }
const publicKinds = new Set<string>(['ask', 'answer', 'blocker', 'result', 'correction'])
const grammar = '@main wake me when seat <name-or-id> posts | about <file-or-subject> | kind <ask|answer|blocker|result|correction> | team <own-team> posts'
const folded = (word: string): string => word.replace(/^@/, '').toLowerCase()
const fileWord = (word: string): string => posix.normalize(word.replaceAll('\\', '/'))
const quoted = (word: string): string => /\s/.test(word) ? JSON.stringify(word) : word

function addressToken(text: string): string | null {
  const match = /^("(?:[^"\\]|\\.)+"|'[^']+'|[^\s"']+) posts$/u.exec(text)
  if (!match) return null
  const token = match[1]!
  if (token.startsWith('"')) {
    try { return JSON.parse(token) as string } catch { return null }
  }
  return token.startsWith("'") ? token.slice(1, -1) : token
}

export function parseBoardWait(post: Pick<BoardPost, 'kind' | 'text'>, own: BoardSeat, seats: readonly BoardSeat[]): BoardWaitPredicate | null {
  const text = post.text.trim()
  if (!/^@main\s+wake\s+me\b/iu.test(text)) return null
  const invalid = (): never => { throw new Error(`Declare a wait with ${grammar}.`) }
  if (post.kind !== 'ask' || own.agent === 'main') return invalid()
  const match = /^@main wake me when (seat|about|kind|team) ([\s\S]+)$/u.exec(text)
  if (!match) return invalid()
  const kind = match[1]!
  const value = match[2]!
  if (kind === 'about') {
    const subject = value.trim()
    if (!subject) return invalid()
    return { kind, subject }
  }
  if (kind === 'kind') {
    if (!publicKinds.has(value)) return invalid()
    return { kind, value: value as PublicKind }
  }
  const token = addressToken(value)
  if (token === null) return invalid()
  if (kind === 'team') {
    if (!own.team || boardLabelKey(token.replace(/^@/, '')) !== boardLabelKey(own.team)) return invalid()
    return { kind, team: own.team }
  }
  const matches = seats.filter(seat => folded(token) === folded(seat.agent) || folded(token) === folded(seat.name))
  if (matches.length !== 1) throw new Error(`Name one enrolled seat for the wait: ${seats.map(seat => `${seat.name} (${seat.agent})`).join(', ')}. Use ${grammar}.`)
  return { kind: 'seat', agent: matches[0]!.agent, name: matches[0]!.name }
}

export function boardWaitWords(predicate: BoardWaitPredicate): string {
  if (predicate.kind === 'seat') return `seat ${quoted(predicate.name)} posts`
  if (predicate.kind === 'about') return `about ${predicate.subject}`
  if (predicate.kind === 'kind') return `kind ${predicate.value}`
  return `team ${quoted(predicate.team)} posts`
}

export const boardBroadcast = (event: RoutedEvent): boolean => (event.addresses ?? []).some(address => folded(address) === 'all')

export function boardWakeEligible(event: RoutedEvent, agent: string): boolean {
  return agent !== 'main' && event.author.agentId !== agent && event.authorRole !== 'system' && publicKinds.has(event.kind) && event.channel?.kind !== 'general' && (event.authorRole !== 'owner' || event.mentions.includes(agent))
}

export function boardAddressesSeat(event: RoutedEvent, seat: BoardSeat): boolean {
  return (event.addresses ?? []).some(address => folded(address) === folded(seat.agent) || folded(address) === folded(seat.name))
}

export function boardNamesSeat(event: RoutedEvent, seat: BoardSeat): boolean {
  if (!boardWakeEligible(event, seat.agent)) return false
  if (event.authorRole === 'owner') return event.mentions.includes(seat.agent)
  const recipient = event.recipients?.find(recipient => recipient.agent === seat.agent)
  return recipient !== undefined && boardAddressesSeat(event, recipient)
}

export function matchesBoardWait(event: RoutedEvent, wait: BoardWait, agent: string): boolean {
  if (event.seq <= wait.seq || !boardWakeEligible(event, agent) || boardBroadcast(event)) return false
  const predicate = wait.predicate
  if (predicate.kind === 'seat') return event.author.agentId === predicate.agent
  if (predicate.kind === 'kind') return event.kind === predicate.value
  if (predicate.kind === 'about') return (event.about ?? '').toLowerCase().includes(predicate.subject.toLowerCase()) || event.files.some(file => fileWord(file) === fileWord(predicate.subject))
  const label = boardLabelKey(predicate.team)
  return boardLabelKey(event.team ?? '') === label || (event.addresses ?? []).some(address => boardLabelKey(address.replace(/^@/, '')) === label) || (event.recipients ?? []).some(recipient => boardLabelKey(recipient.team ?? '') === label)
}

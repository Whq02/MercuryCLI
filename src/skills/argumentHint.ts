import type { Command } from '../types/command.js'
import { getCommandName } from '../types/command.js'

export type BareSendKind = 'local' | 'local-jsx' | 'usage' | 'turn'

export const BARE_USAGE_ROW_COLUMNS = 178
export const BARE_USAGE_DESCRIPTION_FLOOR = 40

export function argumentHintOf(command: Pick<Command, 'argumentHint'>): string | undefined {
  const hint = command.argumentHint
  if (typeof hint !== 'string') return undefined
  const trimmed = hint.trim()
  return trimmed === '' ? undefined : trimmed
}

export function requiresArgument(command: Pick<Command, 'type' | 'argumentHint'>): boolean {
  if (command.type !== 'prompt') return false
  const hint = argumentHintOf(command)
  return hint !== undefined && hint.startsWith('<')
}

export function bareSendKindOf(command: Pick<Command, 'type' | 'argumentHint'>): BareSendKind {
  if (command.type === 'local') return 'local'
  if (command.type === 'local-jsx') return 'local-jsx'
  return requiresArgument(command) ? 'usage' : 'turn'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cutWithEllipsis(text: string, budget: number): string {
  if (text.length <= budget) return text
  const room = Math.max(1, budget - 1)
  const head = text.slice(0, room)
  const atWord = head.lastIndexOf(' ')
  const kept = atWord >= Math.floor(room / 2) ? head.slice(0, atWord) : head
  return `${kept.replace(/[\s,;:—-]+$/, '')}…`
}

export function bareUsageLine(
  command: Pick<Command, 'type' | 'name' | 'description' | 'menuDescription' | 'argumentHint' | 'userFacingName'>,
  columns: number = BARE_USAGE_ROW_COLUMNS,
): string {
  const name = getCommandName(command as Command)
  const hint = argumentHintOf(command) ?? ''
  const head = `/${name} — `
  const tail = ` · usage: /${name}${hint === '' ? '' : ` ${hint}`}`
  const description = oneLine(command.menuDescription ?? command.description)
  const budget = Math.max(BARE_USAGE_DESCRIPTION_FLOOR, columns - head.length - tail.length)
  return `${head}${cutWithEllipsis(description, budget)}${tail}`
}

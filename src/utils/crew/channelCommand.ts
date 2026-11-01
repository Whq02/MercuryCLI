import { randomUUID } from 'node:crypto'
import type { LocalCommandResult } from '../../types/command.js'
import type { BoardPostReceiptV1, BoardPostRequestV1 } from '../../services/engine-connector/types.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'

export type ChannelKind = BoardPostRequestV1['channel']

export const CHANNEL_USAGE: Record<ChannelKind, string> = {
  general: '/general <text>',
  team: '/team <name> <text>',
  whisper: '/whisper <name> <text>',
}

const TARGET = /^@?(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+([\s\S]*))?$/

export function parseChannelArgs(channel: ChannelKind, args: string): { target?: string; text: string } | null {
  if (channel === 'general') return args.trim() === '' ? null : { text: args }
  const match = TARGET.exec(args.replace(/^\s+/, ''))
  if (!match) return null
  const target = (match[1] ?? match[2] ?? match[3] ?? '').trim()
  const text = match[4] ?? ''
  if (target === '' || text.trim() === '') return null
  return { target, text }
}

export function channelRefusal(receipt: Extract<BoardPostReceiptV1, { ok: false }>): string {
  return receipt.candidates?.length ? `${receipt.reason} ${receipt.candidates.join(' · ')}` : receipt.reason
}

export async function postOwnerChannel(post: BoardPostRequestV1): Promise<BoardPostReceiptV1> {
  if (hasFocusedSession()) return getFocusedSessionConnector().postBoard(post)
  const { swarmOwnerPost } = await import('../../services/crewBoard/seam.js')
  const receipt = swarmOwnerPost(post)
  if (!receipt.ok) return receipt
  return { ok: true, eventId: receipt.eventId, seq: receipt.seq, replay: receipt.replay, address: receipt.channel.kind === 'general' ? 'all' : receipt.channel.target, recipients: receipt.recipients }
}

export async function runChannelCommand(channel: ChannelKind, args: string): Promise<LocalCommandResult> {
  const parsed = parseChannelArgs(channel, args)
  if (parsed === null) return { type: 'text', value: CHANNEL_USAGE[channel] }
  const receipt = await postOwnerChannel({ clientOpId: `owner:${randomUUID()}`, channel, ...(parsed.target === undefined ? {} : { target: parsed.target }), text: parsed.text })
  if (receipt.ok) return { type: 'skip' }
  return { type: 'text', value: channelRefusal(receipt) }
}

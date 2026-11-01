import type { UUID } from 'crypto'
import type { BoardEvent, BoardSeat } from './contracts.js'
import type { CrewChatChannel, CrewChatKind, CrewChatLifecycle, CrewChatRole, SystemCrewChatMessage } from '../../types/message.js'

export type BoardChatFilter = { kind: 'all' } | { kind: 'main' } | { kind: 'team'; team: string }
export type BoardChat = { on: boolean; filter: BoardChatFilter }
export const CHAT_OFF: BoardChat = Object.freeze({ on: false, filter: { kind: 'all' as const } })

export type ScreenEvent = BoardEvent & Partial<{ authorRole: CrewChatRole; channel: CrewChatChannel; addresses: string[]; captain: true; recipients: BoardSeat[]; lifecycle: CrewChatLifecycle }>
export type ScreenStore = { chat(): BoardChat; screenEvents(since: number): BoardEvent[]; screenCursor(): number; markScreenCursor(seq: number): void }

const PUBLIC_KINDS: ReadonlySet<string> = new Set(['ask', 'answer', 'blocker', 'result', 'correction'])
const lower = (names: readonly string[] | undefined): Set<string> => new Set((names ?? []).map(name => name.toLowerCase()))

export function partyAdmits(event: ScreenEvent, filter: BoardChatFilter): boolean {
  const lifecycle = event.lifecycle !== undefined
  if (!lifecycle && !PUBLIC_KINDS.has(event.kind)) return false
  if (filter.kind === 'all') return true
  const addresses = lower(event.addresses)
  if (filter.kind === 'main') return !lifecycle && (event.authorRole === 'owner' || addresses.has('main'))
  const team = filter.team.toLowerCase()
  if (event.team?.toLowerCase() === team) return true
  if (lifecycle) return false
  return addresses.has('all') || addresses.has(team) || (event.recipients ?? []).some(seat => seat.team?.toLowerCase() === team && (addresses.has(seat.name.toLowerCase()) || addresses.has(seat.agent.toLowerCase())))
}

export function lifecycleWords(lifecycle: CrewChatLifecycle): string {
  if (lifecycle.kind === 'parked') return `parked · waiting on ${lifecycle.event}`
  return lifecycle.kind === 'launched' ? 'Swarm launched' : lifecycle.kind === 'joined' ? 'Joined' : 'Done'
}

export function partyRow(event: ScreenEvent, turnId?: string): SystemCrewChatMessage {
  const authorRole: CrewChatRole = event.lifecycle ? 'system' : event.authorRole ?? 'peer'
  const label = event.channel === undefined ? undefined : event.channel.kind === 'general' ? 'all' : event.channel.target
  const kind: CrewChatKind = PUBLIC_KINDS.has(event.kind) ? (event.kind as CrewChatKind) : 'notice'
  return {
    type: 'system',
    subtype: 'crew_chat',
    level: 'info',
    isMeta: false,
    uuid: event.eventId as UUID,
    timestamp: event.createdAt,
    content: event.lifecycle !== undefined ? lifecycleWords(event.lifecycle) : authorRole === 'owner' && label !== undefined ? `@${label} ${event.text}` : event.text,
    seq: event.seq,
    name: event.authorName ?? event.author.agentId,
    ...(event.team === undefined ? {} : { team: event.team }),
    ...(event.captain ? { captain: true } : {}),
    authorRole,
    kind,
    mentions: event.mentions,
    addresses: event.addresses ?? [],
    ...(event.channel === undefined ? {} : { channel: event.channel }),
    ...(event.lifecycle === undefined ? {} : { lifecycle: event.lifecycle }),
    ...(turnId === undefined ? {} : { turnId }),
  }
}

export type PartyHost = {
  store: () => ScreenStore | null
  on: () => boolean
  anchor: () => string | undefined
  record: (row: SystemCrewChatMessage) => Promise<void>
}

export type PartyFeed = { check(): void; active(): boolean; blockOpen(): void; landed(): void; turnEnd(): void }

export function partyFeed(host: PartyHost): PartyFeed {
  let active = false
  let scanned = 0
  let open = false
  const held: SystemCrewChatMessage[] = []
  const pending = new Set<number>()
  const advance = (): void => {
    const store = host.store()
    if (!store) return
    const frontier = pending.size ? Math.min(...pending) - 1 : scanned
    if (frontier > store.screenCursor()) store.markScreenCursor(frontier)
  }
  const commit = (row: SystemCrewChatMessage): void => {
    pending.add(row.seq)
    host.record(row).then(() => { pending.delete(row.seq); advance() }, () => {})
  }
  const flush = (): void => { for (const row of held.splice(0)) commit(row) }
  const check = (): void => {
    const store = host.store()
    if (!store || !host.on()) { active = false; return }
    if (!active) { active = true; scanned = store.screenCursor() }
    for (let page = store.screenEvents(scanned); page.length > 0; page = store.screenEvents(scanned)) {
      for (const event of page) {
        scanned = event.seq
        if (!partyAdmits(event, store.chat().filter)) continue
        const row = partyRow(event, host.anchor())
        pending.add(row.seq)
        if (open) held.push(row)
        else commit(row)
      }
    }
    advance()
  }
  return {
    check,
    active: () => host.store() !== null && host.on(),
    blockOpen() { open = true },
    landed() { open = false; flush() },
    turnEnd() { check(); open = false; flush() },
  }
}

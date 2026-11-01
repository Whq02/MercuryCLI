import type { UUID } from 'crypto'
import type { BoardEvent, BoardSeat } from './contracts.js'
import type { CrewChatChannel, CrewChatKind, CrewChatLifecycle, CrewChatRole, SystemCrewChatMessage } from '../../types/message.js'

type BoardChatFilter = { kind: 'all' } | { kind: 'main' } | { kind: 'team'; team: string }
export type BoardChat = { on: boolean; filter: BoardChatFilter }
export const CHAT_OFF: BoardChat = Object.freeze({ on: false, filter: { kind: 'all' as const } })

type ScreenEvent = BoardEvent & Partial<{ authorRole: CrewChatRole; channel: CrewChatChannel; addresses: string[]; captain: true; recipients: BoardSeat[]; lifecycle: CrewChatLifecycle }>
type ScreenStore = { chat(): BoardChat; screenEvents(since: number): BoardEvent[]; screenCursor(): number; markScreenCursor(seq: number): void; screenIntroduction(): BoardEvent | null; markScreenIntroduced(): void }

const PUBLIC_KINDS: ReadonlySet<string> = new Set(['ask', 'answer', 'blocker', 'result', 'correction'])
const lower = (names: readonly string[] | undefined): Set<string> => new Set((names ?? []).map(name => name.toLowerCase()))

function partyAdmits(event: ScreenEvent, filter: BoardChatFilter): boolean {
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

function lifecycleWords(lifecycle: CrewChatLifecycle): string {
  if (lifecycle.kind === 'parked') return `parked · waiting on ${lifecycle.event}`
  return lifecycle.kind === 'launched' ? 'Swarm launched' : lifecycle.kind === 'joined' ? 'Joined' : 'Done'
}

function partyRow(event: ScreenEvent, turnId?: string): SystemCrewChatMessage {
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

function partyPaints(event: ScreenEvent, chat: BoardChat): boolean {
  return event.authorRole === 'owner' || (chat.on && partyAdmits(event, chat.filter))
}

type PartyHost = {
  store: () => ScreenStore | null
  anchor: () => string | undefined
  record: (row: SystemCrewChatMessage) => Promise<void>
}

type PartyFeed = { check(): void; paints(event: ScreenEvent): boolean; blockOpen(): void; landed(): void; turnEnd(): void }

export function partyFeed(host: PartyHost): PartyFeed {
  let active = false
  let scanned = 0
  let open = false
  let introduction = 0
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
    host.record(row).then(() => {
      if (row.seq === introduction) { host.store()?.markScreenIntroduced(); introduction = 0 }
      pending.delete(row.seq)
      advance()
    }, () => {})
  }
  const flush = (): void => { for (const row of held.splice(0)) commit(row) }
  const admit = (event: ScreenEvent): void => {
    const row = partyRow(event, host.anchor())
    pending.add(row.seq)
    if (open) held.push(row)
    else commit(row)
  }
  const check = (): void => {
    const store = host.store()
    if (!store) { active = false; return }
    scanned = active ? Math.max(scanned, store.screenCursor()) : store.screenCursor()
    active = true
    const chat = store.chat()
    const intro = store.screenIntroduction()
    if (intro !== null && !pending.has(intro.seq)) {
      if (partyPaints(intro, chat)) { introduction = intro.seq; admit(intro) }
      else store.markScreenIntroduced()
    }
    for (let page = store.screenEvents(scanned); page.length > 0; page = store.screenEvents(scanned)) {
      for (const event of page) {
        scanned = event.seq
        if (partyPaints(event, chat)) admit(event)
      }
    }
    advance()
  }
  return {
    check,
    paints(event) {
      const store = host.store()
      return store !== null && (event.authorRole === 'owner' || store.chat().on)
    },
    blockOpen() { open = true },
    landed() { open = false; flush() },
    turnEnd() { check(); open = false; flush() },
  }
}

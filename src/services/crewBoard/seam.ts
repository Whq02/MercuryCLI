import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { buildTool, type Tool, type ToolUseContext } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { swarmSwitchOfSession } from '../../utils/sessionStorage/writer.js'
import { getTranscriptPath, readAgentMetadata } from '../../utils/sessionStorage/paths.js'
import { operatorPauseGate } from '../../run-core/pauseGate.js'
import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { DEFAULT_BOARD_LIMITS, boardSeatName, type BoardEvent, type BoardLimits, type BoardModule, type BoardPrincipal, type BoardReceipt, type BoardSeat, type BoardStore, type BoardViewSnapshot, type OwnerPostInput, type OwnerPostReceipt } from './contracts.js'

const requireOptional = createRequire(import.meta.url)
let implementation: BoardModule | undefined
const sessions = new Map<string, { store: BoardStore; execution: string; tool?: Tool }>()
const roads = new Map<string, { on: boolean; execution: string; name: string; active: boolean }>()
const leadChecks = new Set<() => void>()
const pendingLaunches = new Set<string>()
const key = (agent: string): string => `${getSessionId()}:${agent}`
const EMPTY: BoardViewSnapshot = { on: false, events: [], snapshot: 0, omitted: 0, admitted: 0, peerTurns: 0 }

export function swarmMasterEnabled(): boolean {
  return getSettingsForSource('userSettings')?.swarm?.enabled === true
}

export function swarmLimits(): BoardLimits {
  const settings = getSettingsForSource('userSettings')?.swarm
  const seatAllowance = settings?.seatAllowance ?? DEFAULT_BOARD_LIMITS.seatAllowance
  const waveAllowance = settings?.waveAllowance ?? DEFAULT_BOARD_LIMITS.waveAllowance
  return {
    seatAllowance,
    waveAllowance: waveAllowance === 0 ? 0 : Math.max(seatAllowance, waveAllowance),
    postsPerMinute: settings?.postsPerMinute ?? DEFAULT_BOARD_LIMITS.postsPerMinute,
    postsPerSeat: settings?.postsPerSeat ?? DEFAULT_BOARD_LIMITS.postsPerSeat,
    postChars: settings?.postChars ?? DEFAULT_BOARD_LIMITS.postChars,
  }
}

export function swarmUncapped(): boolean {
  return sessions.get(String(getSessionId()))?.store.uncapped === true
}

export function setSwarmUncapped(value: boolean): void {
  const store = swarmStore()
  const state = sessions.get(String(getSessionId()))
  if (!store || !state) throw new Error('No live wave; /swarm on opens it.')
  store.setUncapped({ author: { sessionId: String(getSessionId()), agentId: 'main', executionId: state.execution }, name: 'main' }, value)
}

export function swarmSessionEnabled(): boolean {
  return swarmMasterEnabled() && swarmSwitchOfSession()
}

export function swarmModuleLoaded(): boolean {
  return implementation !== undefined
}

const IMPLEMENTATION_SPECIFIER = import.meta.url.endsWith('.ts') ? './implementation.ts' : './crew-board.mjs'

export function loadSwarm(): BoardModule {
  if (!swarmMasterEnabled()) throw new Error('Swarm is off — enable swarm.enabled in your user settings.json (/config → Swarm).')
  implementation ??= requireOptional(IMPLEMENTATION_SPECIFIER) as BoardModule
  return implementation
}

export function swarmCensusTool(): Tool {
  const module = requireOptional(IMPLEMENTATION_SPECIFIER) as BoardModule
  return module.tool({ buildTool, principal: () => null, paused: () => false, sessionOn: () => false }, () => null)
}

export function swarmStore(): BoardStore | null {
  if (!swarmMasterEnabled()) return null
  const sessionId = String(getSessionId())
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.store.setLimits(swarmLimits())
    return existing.store
  }
  if (!swarmSessionEnabled() && ![...roads].some(([id, road]) => id.startsWith(`${sessionId}:`) && road.on)) return null
  const module = loadSwarm()
  const store = module.open(join(dirname(getTranscriptPath()), sessionId, 'boards', 'wave', 'board.sqlite'), sessionId, swarmLimits())
  const execution = randomUUID()
  sessions.set(sessionId, { store, execution })
  store.enroll({ author: { sessionId, agentId: 'main', executionId: execution }, name: 'main' })
  store.subscribe(() => { for (const check of leadChecks) check() })
  return store
}

export function watchSwarmLead(idle: () => boolean, wake: () => void, paint: (event: BoardEvent) => void): { check: () => void; stop: () => void } {
  const notified = new Map<string, string>()
  const painted = new Map<string, number>()
  const leadContext = AsyncLocalStorage.snapshot()
  const check = (): void => leadContext(() => {
    if (!swarmSessionEnabled()) return
    const session = String(getSessionId())
    const store = sessions.get(session)?.store ?? swarmStore()
    if (!store) return
    for (const event of store.leadPosts(painted.get(session) ?? store.leadPainted())) {
      painted.set(session, event.seq)
      store.markLeadPainted(event.seq)
      paint(event)
    }
    if (operatorPauseGate.holds('main') || !idle()) return
    const event = store.leadMention()
    if (!event || notified.get(session) === event.eventId) return
    notified.set(session, event.eventId)
    wake()
  })
  leadChecks.add(check)
  const resume = operatorPauseGate.subscribe(check)
  check()
  return { check, stop: () => { leadChecks.delete(check); resume() } }
}

export function watchSwarmBoard(check: () => void): () => void {
  leadChecks.add(check)
  return () => { leadChecks.delete(check) }
}

export function swarmRoad(agentId = 'main'): boolean {
  return agentId === 'main' ? swarmSwitchOfSession() : roads.get(key(agentId))?.on === true
}

export function reserveSwarmLaunch(agentId: string, input: { name?: string; description: string; team?: string; captain?: boolean }, sender = 'main'): () => void {
  if (input.captain && (!input.name?.trim() || !input.team)) throw new Error('A captain launch needs name and team.')
  if (input.captain && sender !== 'main') throw new Error('Only the lead appoints a captain.')
  if (!swarmSessionEnabled()) {
    if (input.captain) throw new Error('A captain launch needs swarm enrollment; use /swarm on first.')
    return () => {}
  }
  const store = swarmStore()!
  const principal = swarmPrincipal(sender)
  if (!principal) throw new Error('This seat is not on the live crew board.')
  store.reserveEnrollment(principal, { agent: agentId, name: input.name ?? input.description, team: input.team, captain: input.captain })
  const id = key(agentId)
  pendingLaunches.add(id)
  return () => {
    if (!pendingLaunches.delete(id)) return
    store.cancelEnrollment(principal, agentId)
    closeIdleSwarm()
  }
}

export function swarmOwnerPost(input: OwnerPostInput): OwnerPostReceipt {
  if (!swarmSessionEnabled()) return { ok: false, reason: 'No live wave; /swarm on opens it.' }
  const store = swarmStore(), principal = swarmPrincipal()
  return store && principal ? store.postOwner(principal, input) : { ok: false, reason: 'No live wave; /swarm on opens it.' }
}
export async function latchSwarmAgent(agentId: string, name: string, workflow = false, resumed = false, team?: string): Promise<boolean> {
  if (!roads.has(key(agentId))) {
    const saved = await readAgentMetadata(agentId as AgentId)
    const on = !workflow && (saved === null ? pendingLaunches.has(key(agentId)) || !resumed && swarmSessionEnabled() : saved.swarm === true)
    roads.set(key(agentId), { on, execution: randomUUID(), name, active: true })
  }
  const road = roads.get(key(agentId))!
  if (!road.active) road.execution = randomUUID()
  road.active = true
  if (road.on && swarmMasterEnabled()) swarmStore()?.enroll({ author: { sessionId: String(getSessionId()), agentId, executionId: road.execution }, name, team })
  return road.on
}

function swarmBriefWords(own: BoardSeat, peers: readonly BoardSeat[], captain: BoardSeat | undefined): string {
  const { team } = own
  const label = (seat: BoardSeat): string => seat.captain ? `[${boardSeatName(seat)}]` : seat.name
  const others = peers.map(peer => peer.team ? `${label(peer)} (${peer.team})` : label(peer))
  return [
    `You are ${label(own)}${team ? `, team ${team},` : ''} on this session's live crew board, with the lead (main)${others.length ? ` and ${others.join(', ')}` : ''}; a seat that joins later appears in a board read.`,
    "CrewBoard is how the crew works as one: post a blocker when you are stuck and an ask when another seat's answer or work would move yours; answer an ask you can settle; post a result with its path when a piece lands; read the board at a boundary when another seat's work touches yours, and before you take a file another seat may hold.",
    '@name reaches a seat, @team a team, @main the lead; what you post is read by the whole crew. The board never replaces your final report to the lead.',
    'You may park with a declared wait; the board wakes you on it, and the lead can always wake you.',
    'Before parking, post @main wake me when <event> using the wait grammar below. Do work that does not need that event first. A named post or matching wait can resume you; @all never resumes a parked seat.',
    'Wait grammar: seat <name-or-id> posts; about <file-or-subject>; kind <ask|answer|blocker|result|correction>; team <own-team> posts.',
    own.captain
      ? `You are captain of ${team}, with a standing wait on its traffic. Fold your team's work and send one result to @main. You remain a crewmate; main is the lead. The owner's board posts outrank the lead's.`
      : captain
        ? `${captain.name} is your team's captain. Take your team's asks, blockers and results to @${captain.name}; the captain reports the team's result to @main. The owner's board posts outrank the lead's.`
        : "The owner's board posts outrank the lead's.",
  ].join(' ')
}

export function swarmBrief(agentId: string): string | null {
  const road = roads.get(key(agentId))
  if (!road?.on || !swarmMasterEnabled()) return null
  const store = swarmStore()
  if (!store) return null
  const seats = store.seats()
  const own = seats.find(seat => seat.agent === agentId) ?? { agent: agentId, name: road.name }
  return swarmBriefWords(own, seats.filter(seat => seat.agent !== agentId && seat.agent !== 'main'), own.team ? store.captain(own.team) : undefined)
}

export function swarmPrincipal(agentId = 'main'): BoardPrincipal | null {
  if (!swarmRoad(agentId)) return null
  const store = swarmStore()
  if (!store) return null
  const road = roads.get(key(agentId))
  const execution = agentId === 'main' ? sessions.get(String(getSessionId()))?.execution : road?.execution
  if (!execution) return null
  return { author: { sessionId: String(getSessionId()), agentId, executionId: execution }, name: road?.name ?? 'main' }
}

export function swarmTools(agentId = 'main'): Tool[] {
  if (!swarmRoad(agentId) || !swarmStore()) return []
  const state = sessions.get(String(getSessionId()))!
  state.tool ??= loadSwarm().tool({ buildTool, principal: context => context.agentKind === 'workflow' ? null : swarmPrincipal(context.agentId), paused: id => operatorPauseGate.holds(id), sessionOn: swarmSessionEnabled }, swarmStore)
  return [state.tool]
}

export function swarmView(): BoardViewSnapshot {
  if (!swarmSessionEnabled()) return EMPTY
  try { return swarmStore()?.view() ?? EMPTY } catch (error) { return { ...EMPTY, on: true, error: error instanceof Error ? error.message : String(error) } }
}

const directWords = (text: string): string => `${Array.from(text).slice(0, 400).join('')}… (sent directly)`

export function swarmPeerMessage(context: ToolUseContext, recipient: string, text: string, resume = false, interrupt = false): { handled: boolean; result?: { success: boolean; message: string } } {
  const sender = context.agentId ?? 'main'
  if (sender === 'main' || recipient === 'main') {
    try {
      const board = swarmStore()
      const principal = swarmPrincipal(sender) ?? { author: { sessionId: String(getSessionId()), agentId: sender, executionId: context.toolUseId ?? sender }, name: sender }
      board?.post(principal, { clientOpId: `${resume ? 'resume' : 'message'}:${context.toolUseId ?? randomUUID()}`, kind: 'message', text: directWords(text), taskId: recipient, refs: [{ uri: `mercury://agent/${recipient}`, digest: createHash('sha256').update(text).digest('hex') }] }, 'mirror')
    } catch {}
    return { handled: false }
  }
  if (!swarmRoad(sender) && !swarmRoad(recipient)) return { handled: false }
  if (interrupt && sender !== 'main') return { handled: true, result: { success: false, message: 'Only the lead can interrupt a crewmate.' } }
  if (interrupt) return { handled: false }
  const board = swarmStore()
  if (board === null) return { handled: true, result: { success: false, message: 'The board is unavailable; nothing was sent.' } }
  const principal = swarmPrincipal(sender) ?? { author: { sessionId: String(getSessionId()), agentId: sender, executionId: context.toolUseId ?? sender }, name: sender }
  const onBoard = recipient === 'main' || swarmRoad(recipient)
  const op = context.toolUseId ?? randomUUID()
  const result = board.post(principal, { clientOpId: `message:${op}`, kind: 'message', text, taskId: recipient, mentions: onBoard ? [recipient] : [] }, onBoard ? 'body' : 'mirror')
  if (!result.ok) return { handled: true, result: { success: false, message: result.reason } }
  if (!onBoard) return { handled: false }
  return { handled: true, result: { success: true, message: `Posted for ${recipient}; it reads the message at its next active boundary. No turn was started.` } }
}

export function swarmBoundary(agentId: string | undefined, seen: ReadonlySet<string>): { text: string; eventIds: string[] }[] {
  if (!swarmRoad(agentId) || operatorPauseGate.holds(agentId ?? 'main')) return []
  const principal = swarmPrincipal(agentId)
  if (!principal) return []
  const packet = swarmStore()?.boundary(principal, seen)
  return packet ? [packet] : []
}

function readPackets(messages: readonly Message[]): { packetId: string; eventIds: string[] }[] {
  const calls = new Set(messages.flatMap(message => message.type === 'assistant' && Array.isArray(message.message.content) ? message.message.content.flatMap(block => block.type === 'tool_use' && block.name === 'CrewBoard' ? [block.id] : []) : []))
  const packets: { packetId: string; eventIds: string[] }[] = []
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue
      try {
        const text = typeof block.content === 'string' ? block.content : (block.content ?? []).flatMap(part => part.type === 'text' ? [part.text] : []).join('')
        const data: unknown = JSON.parse(text)
        if (data && typeof data === 'object' && 'packetId' in data && typeof data.packetId === 'string' && 'events' in data && Array.isArray(data.events)) packets.push({ packetId: data.packetId, eventIds: data.events.flatMap(event => event && typeof event === 'object' && typeof event.eventId === 'string' && event.truncated !== true ? [event.eventId] : []) })
      } catch {}
    }
  }
  return packets
}

export function swarmEventIds(messages: readonly Message[]): Set<string> {
  return new Set([
    ...messages.flatMap(message => message.type === 'attachment' && message.attachment.type === 'queued_command' ? message.attachment.boardEventIds ?? [] : []),
    ...readPackets(messages).flatMap(packet => packet.eventIds),
  ])
}

export function swarmPresented(agentId: string | undefined, messages: readonly Message[], requestId: string): void {
  if (!swarmRoad(agentId)) return
  const ids = [...swarmEventIds(messages)]
  const packets = readPackets(messages).map(packet => packet.packetId)
  const principal = swarmPrincipal(agentId)
  if (principal && (ids.length || packets.length)) swarmStore()?.presented(principal, ids, requestId, packets)
}

export function mirrorSwarmNotice(agentId: string, text: string, summary: string): BoardReceipt | null {
  if (!swarmRoad(agentId)) return null
  try {
    const principal = swarmPrincipal(agentId)
    if (!principal) return null
    const hash = createHash('sha256').update(text).digest('hex')
    return swarmStore()?.post(principal, { clientOpId: `notice:${hash}`, kind: 'notice', text: summary, taskId: agentId, refs: [{ uri: `mercury://agent/${agentId}`, digest: hash }] }, 'mirror') ?? null
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally { closeIdleSwarm() }
}

export function closeIdleSwarm(): void {
  const sessionId = String(getSessionId())
  if (swarmSessionEnabled() || [...pendingLaunches].some(id => id.startsWith(`${sessionId}:`)) || [...roads].some(([id, road]) => id.startsWith(`${sessionId}:`) && road.on && road.active)) return
  sessions.get(sessionId)?.store.close()
  sessions.delete(sessionId)
}

export function settleSwarmAgent(agentId: string): void {
  const road = roads.get(key(agentId))
  if (road) {
    const state = sessions.get(String(getSessionId()))
    if (road.on && state) state.store.settle({ author: { sessionId: String(getSessionId()), agentId, executionId: road.execution }, name: road.name })
    road.active = false
  }
  closeIdleSwarm()
}

export function mirrorSwarmResume(context: ToolUseContext, recipient: string, text: string): BoardReceipt | null {
  if (!swarmRoad(recipient)) return null
  try {
    const store = swarmStore()
    if (!store) return null
    const sender = context.agentId ?? 'main'
    const principal = swarmPrincipal(sender) ?? { author: { sessionId: String(getSessionId()), agentId: sender, executionId: context.toolUseId ?? sender }, name: sender }
    const hash = createHash('sha256').update(text).digest('hex')
    return store.post(principal, { clientOpId: `resume:${context.toolUseId ?? hash}`, kind: 'notice', text: directWords(text), taskId: recipient, refs: [{ uri: `mercury://agent/${recipient}`, digest: hash }] }, 'mirror')
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
}

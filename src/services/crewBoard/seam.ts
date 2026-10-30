import { createRequire } from 'node:module'
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
import type { BoardModule, BoardPrincipal, BoardReceipt, BoardStore, BoardViewSnapshot } from './contracts.js'

const requireOptional = createRequire(import.meta.url)
let implementation: BoardModule | undefined
const sessions = new Map<string, { store: BoardStore; execution: string; tool?: Tool }>()
const roads = new Map<string, { on: boolean; execution: string; name: string; active: boolean }>()
const key = (agent: string): string => `${getSessionId()}:${agent}`
const EMPTY: BoardViewSnapshot = { on: false, events: [], snapshot: 0, omitted: 0, admitted: 0, peerTurns: 0 }

export function swarmMasterEnabled(): boolean {
  return getSettingsForSource('userSettings')?.swarm?.enabled === true
}

export function swarmSessionEnabled(): boolean {
  return swarmMasterEnabled() && swarmSwitchOfSession()
}

export function swarmModuleLoaded(): boolean {
  return implementation !== undefined
}

export function loadSwarm(): BoardModule {
  if (!swarmMasterEnabled()) throw new Error('Swarm is off — enable swarm.enabled in your user settings.json (/config → Swarm).')
  implementation ??= requireOptional(import.meta.url.endsWith('.ts') ? './implementation.ts' : './crew-board.mjs') as BoardModule
  return implementation
}

export function swarmStore(): BoardStore | null {
  if (!swarmMasterEnabled()) return null
  const sessionId = String(getSessionId())
  const existing = sessions.get(sessionId)
  if (existing) return existing.store
  if (!swarmSessionEnabled() && ![...roads].some(([id, road]) => id.startsWith(`${sessionId}:`) && road.on)) return null
  const module = loadSwarm()
  const store = module.open(join(dirname(getTranscriptPath()), sessionId, 'boards', 'wave', 'board.sqlite'), sessionId)
  const execution = randomUUID()
  sessions.set(sessionId, { store, execution })
  store.enroll({ author: { sessionId, agentId: 'main', executionId: execution }, name: 'main' })
  return store
}

export function swarmRoad(agentId = 'main'): boolean {
  return agentId === 'main' ? swarmSwitchOfSession() : roads.get(key(agentId))?.on === true
}

export async function latchSwarmAgent(agentId: string, name: string, workflow = false, resumed = false): Promise<boolean> {
  if (!roads.has(key(agentId))) {
    const saved = await readAgentMetadata(agentId as AgentId)
    const on = !workflow && (saved === null ? !resumed && swarmSessionEnabled() : saved.swarm === true)
    roads.set(key(agentId), { on, execution: randomUUID(), name, active: true })
  }
  const road = roads.get(key(agentId))!
  if (!road.active) road.execution = randomUUID()
  road.active = true
  if (road.on && swarmMasterEnabled()) swarmStore()?.enroll({ author: { sessionId: String(getSessionId()), agentId, executionId: road.execution }, name })
  return road.on
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

export function swarmPeerMessage(context: ToolUseContext, recipient: string, text: string, resume = false, interrupt = false): { handled: boolean; result?: { success: boolean; message: string } } {
  const sender = context.agentId ?? 'main'
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
        if (data && typeof data === 'object' && 'packetId' in data && typeof data.packetId === 'string' && 'events' in data && Array.isArray(data.events)) packets.push({ packetId: data.packetId, eventIds: data.events.flatMap(event => event && typeof event === 'object' && typeof event.eventId === 'string' ? [event.eventId] : []) })
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
  if (swarmSessionEnabled() || [...roads].some(([id, road]) => id.startsWith(`${sessionId}:`) && road.on && road.active)) return
  sessions.get(sessionId)?.store.close()
  sessions.delete(sessionId)
}

export function settleSwarmAgent(agentId: string): void {
  const road = roads.get(key(agentId))
  if (road) road.active = false
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
    return store.post(principal, { clientOpId: `resume:${context.toolUseId ?? hash}`, kind: 'notice', text: Array.from(text).length <= 1200 ? text : 'More work', taskId: recipient, refs: [{ uri: `mercury://agent/${recipient}`, digest: hash }] }, 'mirror')
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
}

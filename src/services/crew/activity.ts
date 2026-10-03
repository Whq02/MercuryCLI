
import type { SeatEvent } from './seatBridge.js'
import type { CrewAgentId } from './identity.js'

export const ACTIVITY_CLASSES = [
  'message',
  'file-change',
  'command',
  'check',
  'tool',
  'plan',
  'question',
  'work-item',
  'session-lifecycle',
  'artifact',
  'handoff',
  'unknown',
] as const
export type ActivityClass = (typeof ACTIVITY_CLASSES)[number]

export const ACTIVITY_PHASES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number]

export interface AgentActivityV1 {
  activityId: string
  agentId: CrewAgentId
  sessionId: string
  conversationId?: string
  class: ActivityClass
  verb: string
  objectLabel: string
  phase: ActivityPhase
  outcomeLabel?: string
  startedAt: number
  updatedAt: number
  labelExtends?: boolean
  rawRefs: string[]
  evidenceRefs: string[]
}

export interface ActivityInput {
  event: SeatEvent
  agentId: CrewAgentId
  sessionId: string
  adapterKind: string
  conversationId?: string
}

export interface ActivityClassifier {
  name: string
  precedence: number
  matches(input: ActivityInput): boolean
  lift(input: ActivityInput): Omit<AgentActivityV1, 'agentId' | 'sessionId' | 'conversationId'>
}

const registry: ActivityClassifier[] = []

export function registerActivityClassifier(c: ActivityClassifier): void {
  registry.push(c)
  registry.sort((a, b) => a.precedence - b.precedence || (a.name < b.name ? -1 : 1))
}

export function activityClassifierOrder(): Array<{ name: string; precedence: number }> {
  return registry.map(c => ({ name: c.name, precedence: c.precedence }))
}

export function activityIdOf(input: ActivityInput): string {
  const scope = `${input.adapterKind}:${input.sessionId}`
  const p = input.event.payload as Record<string, unknown> | null
  const update = p?.update as Record<string, unknown> | undefined
  if (update?.sessionUpdate === 'agent_message_chunk') return `${scope}:msg-stream`
  const toolCallId = toolCallIdOf(p)
  if (toolCallId) return `${scope}:tool:${toolCallId}`
  return `${scope}:evt:${input.event.sourceEventId}`
}

function toolCallIdOf(p: Record<string, unknown> | null): string | null {
  if (!p) return null
  const update = (p.update ?? p) as Record<string, unknown>
  if (typeof update.toolCallId === 'string') return update.toolCallId
  return null
}

export function classifyActivity(input: ActivityInput): AgentActivityV1 {
  for (const c of registry) {
    let matched = false
    try {
      matched = c.matches(input)
    } catch {
      continue
    }
    if (!matched) continue
    try {
      const lifted = c.lift(input)
      return {
        ...lifted,
        agentId: input.agentId,
        sessionId: input.sessionId,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      }
    } catch {
      continue
    }
  }
  throw new Error('crew/activity: the unknown fallback classifier is not registered')
}


export interface ActivityFeedState {
  rows: ReadonlyMap<string, AgentActivityV1>
  order: readonly string[]
}

export function emptyActivityFeed(): ActivityFeedState {
  return { rows: new Map(), order: [] }
}

export const ACTIVITY_FEED_CAP = 500

export function foldActivity(state: ActivityFeedState, row: AgentActivityV1): ActivityFeedState {
  const rows = new Map(state.rows)
  const existing = rows.get(row.activityId)
  if (existing) {
    rows.set(row.activityId, {
      ...existing,
      phase: row.phase,
      ...(existing.labelExtends === true && row.labelExtends === true
        ? { objectLabel: `${existing.objectLabel}${row.objectLabel}`.slice(0, 60) }
        : {}),
      ...(row.outcomeLabel !== undefined ? { outcomeLabel: row.outcomeLabel } : {}),
      updatedAt: row.updatedAt,
      rawRefs: [...existing.rawRefs, ...row.rawRefs.filter(r => !existing.rawRefs.includes(r))],
      evidenceRefs: [
        ...existing.evidenceRefs,
        ...row.evidenceRefs.filter(r => !existing.evidenceRefs.includes(r)),
      ],
    })
    return { rows, order: state.order }
  }
  rows.set(row.activityId, row)
  let order = [...state.order, row.activityId]
  if (order.length > ACTIVITY_FEED_CAP) {
    const terminal = new Set<ActivityPhase>(['succeeded', 'failed', 'cancelled'])
    const dropIx = order.findIndex(id => terminal.has(rows.get(id)?.phase ?? 'succeeded'))
    if (dropIx >= 0) {
      rows.delete(order[dropIx]!)
      order = [...order.slice(0, dropIx), ...order.slice(dropIx + 1)]
    }
  }
  return { rows, order }
}

export function activityRows(state: ActivityFeedState): AgentActivityV1[] {
  return state.order.map(id => state.rows.get(id)!).filter(Boolean)
}


function acpToolCall(input: ActivityInput): Record<string, unknown> | null {
  const p = input.event.payload as Record<string, unknown> | null
  const update = p?.update as Record<string, unknown> | undefined
  if (update && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
    return update
  }
  return null
}

function base(input: ActivityInput): Pick<AgentActivityV1, 'startedAt' | 'updatedAt' | 'rawRefs' | 'evidenceRefs' | 'activityId'> {
  return {
    activityId: activityIdOf(input),
    startedAt: input.event.atMs,
    updatedAt: input.event.atMs,
    rawRefs: [`seat-event:${input.adapterKind}:${input.event.sourceEventId}`],
    evidenceRefs: [],
  }
}

const ACP_KIND_CLASS: Partial<Record<string, { cls: ActivityClass; verb: string }>> = {
  read: { cls: 'tool', verb: 'read' },
  edit: { cls: 'file-change', verb: 'edited' },
  delete: { cls: 'file-change', verb: 'deleted' },
  move: { cls: 'file-change', verb: 'moved' },
  execute: { cls: 'command', verb: 'ran' },
  search: { cls: 'tool', verb: 'searched' },
  fetch: { cls: 'tool', verb: 'fetched' },
  think: { cls: 'tool', verb: 'thought about' },
}

registerActivityClassifier({
  name: 'acp-tool-call',
  precedence: 120,
  matches: input => acpToolCall(input) !== null,
  lift: input => {
    const call = acpToolCall(input)!
    const mapped = ACP_KIND_CLASS[String(call.kind ?? '')] ?? { cls: 'tool' as ActivityClass, verb: 'used' }
    const status = String(call.status ?? 'in_progress')
    const phase: ActivityPhase =
      status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'pending' ? 'queued' : 'running'
    return {
      ...base(input),
      class: mapped.cls,
      verb: mapped.verb,
      objectLabel: String(call.title ?? 'a tool call').slice(0, 60),
      phase,
      ...(status === 'completed' || status === 'failed' ? { outcomeLabel: status } : {}),
    }
  },
})

registerActivityClassifier({
  name: 'acp-message-chunk',
  precedence: 320,
  matches: input => {
    const p = input.event.payload as Record<string, unknown> | null
    const update = p?.update as Record<string, unknown> | undefined
    return update?.sessionUpdate === 'agent_message_chunk'
  },
  lift: input => {
    const p = input.event.payload as Record<string, unknown> | null
    const update = p?.update as { content?: { text?: string } } | undefined
    return {
      ...base(input),
      class: 'message',
      verb: 'said',
      objectLabel: String(update?.content?.text ?? '').slice(0, 60) || 'a message',
      phase: 'succeeded',
      labelExtends: true,
    }
  },
})

registerActivityClassifier({
  name: 'acp-plan',
  precedence: 130,
  matches: input => {
    const p = input.event.payload as Record<string, unknown> | null
    const update = p?.update as Record<string, unknown> | undefined
    return update?.sessionUpdate === 'plan'
  },
  lift: input => ({
    ...base(input),
    class: 'plan',
    verb: 'updated',
    objectLabel: 'the plan',
    phase: 'running',
  }),
})

registerActivityClassifier({
  name: 'mercury-review-artifact',
  precedence: 330,
  matches: input => input.event.kind === 'mercury.review',
  lift: input => {
    const p = input.event.payload as { title?: string; status?: string } | null
    const status = String(p?.status ?? 'draft')
    const phase: ActivityPhase =
      status === 'ready-for-review'
        ? 'waiting'
        : status === 'accepted' || status === 'reviewed'
          ? 'succeeded'
          : status === 'revision-requested'
            ? 'running'
            : 'queued'
    return {
      ...base(input),
      class: 'artifact',
      verb: status === 'ready-for-review' ? 'published' : 'settled',
      objectLabel: String(p?.title ?? 'a review artifact').slice(0, 60),
      phase,
      outcomeLabel: status,
    }
  },
})

registerActivityClassifier({
  name: 'unknown-raw',
  precedence: Number.MAX_SAFE_INTEGER,
  matches: () => true,
  lift: input => ({
    ...base(input),
    class: 'unknown',
    verb: 'emitted',
    objectLabel: input.event.kind,
    phase: 'succeeded',
    outcomeLabel: 'unclassified — raw event behind disclosure',
  }),
})


let liveFeed = emptyActivityFeed()
const feedListeners = new Set<() => void>()

export function cachedActivityFeed(): ActivityFeedState {
  return liveFeed
}

export function subscribeActivityFeed(cb: () => void): () => void {
  feedListeners.add(cb)
  return () => {
    feedListeners.delete(cb)
  }
}

export function ingestActivity(input: ActivityInput): AgentActivityV1[] {
  const row = classifyActivity(input)
  const rows: AgentActivityV1[] = [row]
  const next = foldActivity(liveFeed, row)
  if (next !== liveFeed) {
    liveFeed = next
    for (const l of [...feedListeners]) {
      try {
        l()
      } catch {
      }
    }
  }
  return rows
}

export function activityLineOf(row: AgentActivityV1, agentLabel?: string): string {
  const outcome = row.outcomeLabel ?? row.phase
  const who = agentLabel ? `${agentLabel} · ` : ''
  return `${who}${row.verb} → ${row.objectLabel} → ${outcome}`
}

export function _resetActivityFeedForTesting(): void {
  liveFeed = emptyActivityFeed()
  feedListeners.clear()
}

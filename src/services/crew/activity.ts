
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
  model?: string
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
  const messageId = messageIdOf(p)
  if (messageId) return `${scope}:msg:${messageId}`
  return `${scope}:evt:${input.event.sourceEventId}`
}

function toolCallIdOf(p: Record<string, unknown> | null): string | null {
  if (!p) return null
  const msg = p.message as { content?: unknown } | undefined
  const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : null
  const block = content?.find(b => b.type === 'tool_use' || b.type === 'tool_result')
  if (block) return String(block.id ?? block.tool_use_id ?? '') || null
  const update = (p.update ?? p) as Record<string, unknown>
  if (typeof update.toolCallId === 'string') return update.toolCallId
  return null
}

function messageIdOf(p: Record<string, unknown> | null): string | null {
  if (!p) return null
  const msg = p.message as { id?: string } | undefined
  return typeof msg?.id === 'string' ? msg.id : null
}

function modelOf(input: ActivityInput): string | null {
  const p = input.event.payload as Record<string, unknown> | null
  if (!p) return null
  const msg = p.message as { model?: unknown } | undefined
  if (typeof msg?.model === 'string' && msg.model) return msg.model
  if (typeof p.model === 'string' && p.model) return p.model
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
      const model = modelOf(input)
      return {
        ...lifted,
        agentId: input.agentId,
        sessionId: input.sessionId,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(model !== null ? { model } : {}),
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


const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMAND_TOOLS = new Set(['Bash', 'Shell'])
const CHECK_HINTS = /\b(test|typecheck|lint|check|verify|prove)\b/i
const QUESTION_TOOLS = new Set(['AskUserQuestion'])
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TodoWrite'])
const WORK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'Task'])

interface ToolUseShape {
  id?: string
  name?: string
  input?: Record<string, unknown>
}

function streamToolUse(input: ActivityInput): ToolUseShape | null {
  const p = input.event.payload as Record<string, unknown> | null
  const msg = p?.message as { content?: unknown } | undefined
  const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : null
  const block = content?.find(b => b.type === 'tool_use')
  return block ? (block as ToolUseShape) : null
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

registerActivityClassifier({
  name: 'stream-file-change',
  precedence: 100,
  matches: input => {
    const tool = streamToolUse(input)
    return tool !== null && FILE_TOOLS.has(tool.name ?? '')
  },
  lift: input => {
    const tool = streamToolUse(input)!
    const path = String(tool.input?.file_path ?? tool.input?.path ?? 'a file')
    return {
      ...base(input),
      class: 'file-change',
      verb: 'edited',
      objectLabel: path,
      phase: 'running',
    }
  },
})

registerActivityClassifier({
  name: 'stream-command',
  precedence: 110,
  matches: input => {
    const tool = streamToolUse(input)
    return tool !== null && COMMAND_TOOLS.has(tool.name ?? '') && !CHECK_HINTS.test(String(tool.input?.command ?? ''))
  },
  lift: input => {
    const tool = streamToolUse(input)!
    const cmd = String(tool.input?.command ?? '').slice(0, 60)
    return {
      ...base(input),
      class: 'command',
      verb: 'ran',
      objectLabel: cmd || 'a command',
      phase: 'running',
    }
  },
})

registerActivityClassifier({
  name: 'stream-check',
  precedence: 105,
  matches: input => {
    const tool = streamToolUse(input)
    return tool !== null && COMMAND_TOOLS.has(tool.name ?? '') && CHECK_HINTS.test(String(tool.input?.command ?? ''))
  },
  lift: input => {
    const tool = streamToolUse(input)!
    const cmd = String(tool.input?.command ?? '').slice(0, 60)
    return {
      ...base(input),
      class: 'check',
      verb: 'ran',
      objectLabel: cmd,
      phase: 'running',
    }
  },
})

registerActivityClassifier({
  name: 'stream-question',
  precedence: 90,
  matches: input => {
    const tool = streamToolUse(input)
    return tool !== null && QUESTION_TOOLS.has(tool.name ?? '')
  },
  lift: input => ({
    ...base(input),
    class: 'question',
    verb: 'asked',
    objectLabel: 'you',
    phase: 'waiting',
  }),
})

registerActivityClassifier({
  name: 'stream-plan',
  precedence: 95,
  matches: input => {
    const tool = streamToolUse(input)
    return tool !== null && PLAN_TOOLS.has(tool.name ?? '')
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
  name: 'stream-work-item',
  precedence: 96,
  matches: input => {
    const tool = streamToolUse(input)
    return tool !== null && WORK_TOOLS.has(tool.name ?? '')
  },
  lift: input => ({
    ...base(input),
    class: 'work-item',
    verb: 'updated',
    objectLabel: 'a work item',
    phase: 'running',
  }),
})

registerActivityClassifier({
  name: 'stream-generic-tool',
  precedence: 200,
  matches: input => streamToolUse(input) !== null,
  lift: input => {
    const tool = streamToolUse(input)!
    return {
      ...base(input),
      class: 'tool',
      verb: 'used',
      objectLabel: tool.name ?? 'a tool',
      phase: 'running',
    }
  },
})

registerActivityClassifier({
  name: 'stream-tool-result',
  precedence: 210,
  matches: input => {
    const p = input.event.payload as Record<string, unknown> | null
    const msg = p?.message as { content?: unknown } | undefined
    return (
      Array.isArray(msg?.content) &&
      (msg.content as Array<Record<string, unknown>>).some(b => b.type === 'tool_result')
    )
  },
  lift: input => {
    const p = input.event.payload as Record<string, unknown> | null
    const msg = p?.message as { content?: Array<Record<string, unknown>> } | undefined
    const block = msg?.content?.find(b => b.type === 'tool_result') as
      | { is_error?: boolean }
      | undefined
    const failed = block?.is_error === true
    return {
      ...base(input),
      class: 'tool',
      verb: 'finished',
      objectLabel: 'a tool call',
      phase: failed ? 'failed' : 'succeeded',
      outcomeLabel: failed ? 'errored' : 'completed',
    }
  },
})


function systemSubtypeOf(input: ActivityInput): string | null {
  const p = input.event.payload as Record<string, unknown> | null
  if (!p) return null
  if (p.type !== 'system' && !input.event.kind.startsWith('system')) return null
  return typeof p.subtype === 'string' ? p.subtype : null
}

registerActivityClassifier({
  name: 'model-transition',
  precedence: 240,
  matches: input => systemSubtypeOf(input) === 'model_transition',
  lift: input => {
    const p = input.event.payload as Record<string, unknown>
    const t = (p.transition ?? {}) as {
      previous?: string | null
      requested?: string | null
      applied?: string | null
      resolution?: string
      cross_provider?: boolean
    }
    const applied = t.applied ?? t.requested ?? '?'
    return {
      ...base(input),
      class: 'handoff',
      verb: 'switched model',
      objectLabel: `${t.previous ?? 'default'} → ${applied}${t.cross_provider ? ' · cross-provider' : ''}`.slice(0, 60),
      phase: t.resolution === 'applied' ? 'succeeded' : 'cancelled',
      outcomeLabel: t.resolution ?? 'applied',
    }
  },
})

registerActivityClassifier({
  name: 'branch-boundary',
  precedence: 241,
  matches: input => {
    const s = systemSubtypeOf(input)
    return s === 'fork_boundary' || s === 'rewind_boundary'
  },
  lift: input => {
    const p = input.event.payload as Record<string, unknown>
    const parent = typeof p.parentSessionId === 'string' ? p.parentSessionId.slice(0, 8) : 'parent'
    const ordinal = typeof p.forkOrdinal === 'number' ? p.forkOrdinal : '?'
    return {
      ...base(input),
      class: 'session-lifecycle',
      verb: systemSubtypeOf(input) === 'fork_boundary' ? 'branched' : 'rewound',
      objectLabel: `from ${parent} @ ordinal ${ordinal}`,
      phase: 'succeeded',
    }
  },
})

registerActivityClassifier({
  name: 'context-plan',
  precedence: 242,
  matches: input => {
    const s = systemSubtypeOf(input)
    return s === 'compact_boundary' || s === 'microcompact'
  },
  lift: input => {
    const p = input.event.payload as Record<string, unknown>
    const meta = (p.compact_metadata ?? {}) as { trigger?: string }
    return {
      ...base(input),
      class: 'plan',
      verb: 'compacted',
      objectLabel: 'the context',
      phase: 'succeeded',
      ...(typeof meta.trigger === 'string' ? { outcomeLabel: meta.trigger } : {}),
    }
  },
})

const INTERNAL_ENVELOPE_HEADS = [
  '<command-name>',
  '<command-message>',
  '<local-command-caveat>',
  '<local-command-stdout',
  '<local-command-stderr',
  '<bash-stdout',
  '<bash-stderr',
] as const

function envelopeTextOf(input: ActivityInput): string | null {
  if (input.event.kind !== 'user' && input.event.kind !== 'assistant') return null
  const p = input.event.payload as Record<string, unknown> | null
  const content = (p?.message as { content?: unknown } | undefined)?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? ((content as Array<{ type?: string; text?: string }>).find(b => b?.type === 'text')?.text ?? '')
        : ''
  const head = text.trimStart()
  return INTERNAL_ENVELOPE_HEADS.some(h => head.startsWith(h)) ? text : null
}

registerActivityClassifier({
  name: 'internal-envelope',
  precedence: 239,
  matches: input => envelopeTextOf(input) !== null,
  lift: input => {
    const text = envelopeTextOf(input)!
    const cmd = /<command-message>([^<]*)<\/command-message>/.exec(text)?.[1]
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]
    if (cmd) {
      return {
        ...base(input),
        class: 'command',
        verb: 'invoked',
        objectLabel: `/${cmd}${args ? ` ${args}` : ''}`.slice(0, 60),
        phase: 'succeeded',
      }
    }
    const head = text.trimStart()
    const label = head.startsWith('<local-command-caveat>')
      ? '(local-command plumbing)'
      : head.startsWith('<bash-')
        ? '(bash output)'
        : head.startsWith('<command-name>')
          ? '(command breadcrumb)'
          : '(command output)'
    return {
      ...base(input),
      class: 'message',
      verb: 'carried',
      objectLabel: label,
      phase: 'succeeded',
    }
  },
})

registerActivityClassifier({
  name: 'session-connect',
  precedence: 243,
  matches: input => systemSubtypeOf(input) === 'init',
  lift: input => ({
    ...base(input),
    class: 'session-lifecycle',
    verb: 'connected',
    objectLabel: 'the session',
    phase: 'succeeded',
  }),
})

registerActivityClassifier({
  name: 'stream-message',
  precedence: 300,
  matches: input => {
    const p = input.event.payload as Record<string, unknown> | null
    if (input.event.kind !== 'assistant' && input.event.kind !== 'user') return false
    const msg = p?.message as { content?: unknown } | undefined
    if (typeof msg?.content === 'string') return msg.content.length > 0
    return (
      Array.isArray(msg?.content) &&
      (msg.content as Array<Record<string, unknown>>).some(b => b.type === 'text')
    )
  },
  lift: input => {
    const p = input.event.payload as Record<string, unknown> | null
    const msg = p?.message as { content?: string | Array<{ type?: string; text?: string }> } | undefined
    const text =
      typeof msg?.content === 'string'
        ? msg.content
        : (msg?.content?.find(b => b.type === 'text')?.text ?? '')
    return {
      ...base(input),
      class: 'message',
      verb: input.event.kind === 'assistant' ? 'said' : 'received',
      objectLabel: text.slice(0, 60) || 'a message',
      phase: 'succeeded',
    }
  },
})

registerActivityClassifier({
  name: 'stream-session-lifecycle',
  precedence: 310,
  matches: input => input.event.kind === 'result' || input.event.kind.startsWith('system.'),
  lift: input => {
    const p = input.event.payload as Record<string, unknown> | null
    const isResult = input.event.kind === 'result'
    const failed = isResult && p?.subtype !== 'success'
    const status = !isResult && typeof p?.status === 'string' ? p.status : null
    const announcePhase: ActivityPhase =
      status === 'failed' ? 'failed' : status === 'stopped' || status === 'cancelled' ? 'cancelled' : 'succeeded'
    return {
      ...base(input),
      class: 'session-lifecycle',
      verb: isResult ? 'settled' : 'announced',
      objectLabel: isResult ? 'the turn' : input.event.kind,
      phase: isResult ? (failed ? 'failed' : 'succeeded') : announcePhase,
      ...(isResult ? { outcomeLabel: String(p?.subtype ?? 'done') } : status !== null ? { outcomeLabel: status } : {}),
    }
  },
})

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

export function explodeActivityInputs(input: ActivityInput): ActivityInput[] {
  const p = input.event.payload as Record<string, unknown> | null
  const msg = p?.message as { content?: unknown } | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return [input]
  const actionable = (content as Array<Record<string, unknown>>).filter(
    b =>
      b !== null &&
      typeof b === 'object' &&
      (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'text'),
  )
  if (actionable.length <= 1) return [input]
  return actionable.map(block => ({
    ...input,
    event: {
      ...input.event,
      payload: { ...p, message: { ...(p!.message as Record<string, unknown>), content: [block] } },
    },
  }))
}

export function ingestActivity(input: ActivityInput): AgentActivityV1[] {
  const rows: AgentActivityV1[] = []
  let next = liveFeed
  for (const sub of explodeActivityInputs(input)) {
    const row = classifyActivity(sub)
    rows.push(row)
    next = foldActivity(next, row)
  }
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

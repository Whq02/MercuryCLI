// ============================================================================
//  crew/activity — the semantic activity classifier + projection
//
//
//  One deterministic registry lifts EXTERNAL adapter events to the same
//  semantic level as Mercury's native tool cards: `verb → object → outcome`.
//  Native activity keeps its purpose-built cards — this classifier exists
//  primarily for external seats, and native events pass through only where a
//  surface asks for the unified row form.
//
//  LAWS:
//    · ORDERED PRECEDENCE — classifiers run lowest precedence number first;
//      the first match wins; registration order can never change a verdict
//      (ties break by class name, deterministically);
//    · STABLE SOURCE IDS — rows key on the owner's own id (tool-call id,
//      message id, adapter event id), NEVER rendered text: a running row
//      updates into its terminal outcome in place;
//    · NO SECOND TRANSCRIPT — `rawRefs` point into canonical owners; the
//      projection ring is bounded and body-free;
//    · TRUTHFUL UNKNOWN — an unrecognized event gets exactly one generic
//      'unknown' row with its raw payload behind disclosure; it is never
//      guessed into a more specific class, and durable events are never
//      discarded (display bursts may group; facts may not).
// ============================================================================

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
  /** The stable row key — the owner's own event/tool/message id. */
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
  /** Streamed-fragment rows only (e.g. ACP message chunks): a later fragment
   *  folding into this row EXTENDS objectLabel instead of keeping the minting
   *  fragment — the one deliberate exception to frozen identity facts. */
  labelExtends?: boolean
  /** The MODEL identity behind this activity (field intake:
   *  a crewmate's model must be readable from the view and the transcript,
   *  never only from its raw records). Lifted once for every classifier
   *  from the frames that carry it (assistant messages · init frames);
   *  additive — projections version forward. */
  model?: string
  /** Ordered refs into the canonical owners — never duplicated bodies. */
  rawRefs: string[]
  evidenceRefs: string[]
}

/** The classification input — an adapter SeatEvent plus its seat context. */
export interface ActivityInput {
  event: SeatEvent
  agentId: CrewAgentId
  sessionId: string
  adapterKind: string
  conversationId?: string
}

export interface ActivityClassifier {
  /** Kebab-case classifier name (diagnostics + deterministic tie-break). */
  name: string
  /** Lower runs first. Built-ins occupy 100–1100; the unknown fallback is
   *  ALWAYS last (Number.MAX_SAFE_INTEGER) and cannot be outranked. */
  precedence: number
  matches(input: ActivityInput): boolean
  lift(input: ActivityInput): Omit<AgentActivityV1, 'agentId' | 'sessionId' | 'conversationId'>
}

const registry: ActivityClassifier[] = []

export function registerActivityClassifier(c: ActivityClassifier): void {
  registry.push(c)
  registry.sort((a, b) => a.precedence - b.precedence || (a.name < b.name ? -1 : 1))
}

/** The ordered registry (read-only view — diagnostics + the prover). */
export function activityClassifierOrder(): Array<{ name: string; precedence: number }> {
  return registry.map(c => ({ name: c.name, precedence: c.precedence }))
}

/** THE stable row key: the owner's own id under the SEAT's scope (adapter
 *  kind + session), never rendered text. Session scoping keeps two seats of
 *  one adapter kind — whose tool-call/event id spaces are only session-unique
 *  — from folding each other's rows. */
export function activityIdOf(input: ActivityInput): string {
  const scope = `${input.adapterKind}:${input.sessionId}`
  const p = input.event.payload as Record<string, unknown> | null
  // ACP message chunks carry no owner id at all — one streamed utterance is
  // ONE coalescing row per session stream, never a row per fragment.
  const update = p?.update as Record<string, unknown> | undefined
  if (update?.sessionUpdate === 'agent_message_chunk') return `${scope}:msg-stream`
  // Tool-call ids collapse start/update/terminal frames into ONE row.
  const toolCallId = toolCallIdOf(p)
  if (toolCallId) return `${scope}:tool:${toolCallId}`
  const messageId = messageIdOf(p)
  if (messageId) return `${scope}:msg:${messageId}`
  return `${scope}:evt:${input.event.sourceEventId}`
}

function toolCallIdOf(p: Record<string, unknown> | null): string | null {
  if (!p) return null
  // stream-json message frames: tool_use / tool_result blocks inside message
  // content (content may legally be a plain string — never assume the array
  // shape).
  const msg = p.message as { content?: unknown } | undefined
  const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : null
  const block = content?.find(b => b.type === 'tool_use' || b.type === 'tool_result')
  if (block) return String(block.id ?? block.tool_use_id ?? '') || null
  // ACP session/update tool_call frames.
  const update = (p.update ?? p) as Record<string, unknown>
  if (typeof update.toolCallId === 'string') return update.toolCallId
  return null
}

function messageIdOf(p: Record<string, unknown> | null): string | null {
  if (!p) return null
  const msg = p.message as { id?: string } | undefined
  return typeof msg?.id === 'string' ? msg.id : null
}

/** The model identity a frame carries, when it carries one: assistant
 *  messages (message.model) and init/system frames (payload.model). */
function modelOf(input: ActivityInput): string | null {
  const p = input.event.payload as Record<string, unknown> | null
  if (!p) return null
  const msg = p.message as { model?: unknown } | undefined
  if (typeof msg?.model === 'string' && msg.model) return msg.model
  if (typeof p.model === 'string' && p.model) return p.model
  return null
}

/** Classify one adapter event. Deterministic: ordered precedence, first
 *  match; the unknown fallback always matches last. A classifier that THROWS
 *  on a shape it did not expect never veils the event — the walk continues
 *  and the unknown fallback still lands the truthful generic row. */
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
        // Lifted ONCE for every classifier — model identity is a frame
        // fact, not a per-classifier concern.
        ...(model !== null ? { model } : {}),
      }
    } catch {
      continue
    }
  }
  // Unreachable: the unknown fallback matches everything and its lift is total.
  throw new Error('crew/activity: the unknown fallback classifier is not registered')
}

// ── the projection ring (bounded, in-place phase updates) ────────────────────

export interface ActivityFeedState {
  /** activityId → row. */
  rows: ReadonlyMap<string, AgentActivityV1>
  /** Insertion order of ids (oldest first) — the bounded window. */
  order: readonly string[]
}

export function emptyActivityFeed(): ActivityFeedState {
  return { rows: new Map(), order: [] }
}

export const ACTIVITY_FEED_CAP = 500

/**
 * Fold one classified row into the feed: a known activityId UPDATES its row
 * in place (the running→terminal collapse — startedAt survives, phase and
 * outcome move); a new id appends; the window stays bounded by dropping the
 * OLDEST terminal rows first (live rows are never dropped for a burst).
 */
export function foldActivity(state: ActivityFeedState, row: AgentActivityV1): ActivityFeedState {
  const rows = new Map(state.rows)
  const existing = rows.get(row.activityId)
  if (existing) {
    // In-place collapse: the row's IDENTITY facts (class, verb, object — what
    // the activity IS) come from the frame that minted it; a later frame for
    // the same source id only advances phase/outcome/time and appends refs.
    // The one exception: streamed-fragment rows EXTEND their label — the row
    // is the whole utterance, not its first fragment.
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
    // Live rows are NEVER dropped for a burst: with no terminal victim the
    // window temporarily exceeds the cap and shrinks as rows settle.
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

// ── built-in classifiers ─────────────────────────────────────────────────────

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

// ── activity kinds: transition · branch · context-plan · connect ────────
// The new continuity vocabulary, lifted through the SAME declared extension
// point (precedence 240–243 — ahead of the generic message/lifecycle rows,
// behind the tool classifiers).

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

// The render-boundary filter law at the projection (field intakes D +
// the WORK-tab <command-message> leak): internal envelope frames must never
// paint raw envelope bytes into a row label. Slash commands lift as CLEAN
// command rows; pure plumbing lifts a neutral label.
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
    // Connect and RECONNECT ride the same init frame — the row is the
    // session's (re)connection moment in the shared vocabulary.
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
    // The wire contract allows string content on user messages — a legal
    // frame, classified as the message it is.
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
    // Announcements carrying their OWN status (task_notification etc.) keep
    // it — a failed notification never renders as 'succeeded'.
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
      // Chunks share one session-stream row (activityIdOf) and each fragment
      // extends the label — one utterance is one row, never a row per chunk.
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

/** THE truthful fallback — always last, cannot be outranked. */
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

// ── the live feed (seat events → classified rows, in-place updates) ──────────

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

/** A stream message frame carries the WHOLE wire message — a parallel
 *  tool burst is several actionable blocks in ONE frame. Classification is
 *  per block: each tool_use/tool_result/text block becomes its own input
 *  (single-block payload, same source event), so the second tool call of a
 *  burst gets its own row instead of vanishing behind the first. */
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

/** Fold a classified event into the live feed and notify — one row per
 *  actionable block (explodeActivityInputs), one notification per event. */
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
        // display-only consumers
      }
    }
  }
  return rows
}

/** One human-readable feed line: `Agent · verb → object → outcome`. */
export function activityLineOf(row: AgentActivityV1, agentLabel?: string): string {
  const outcome = row.outcomeLabel ?? row.phase
  const who = agentLabel ? `${agentLabel} · ` : ''
  return `${who}${row.verb} → ${row.objectLabel} → ${outcome}`
}

/** Test seam (never product-read). */
export function _resetActivityFeedForTesting(): void {
  liveFeed = emptyActivityFeed()
  feedListeners.clear()
}

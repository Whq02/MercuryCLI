import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { ASSISTANT_MESSAGE_ERRORS, type AssistantMessageError } from '../types/message.js'
import type { Terminal } from '../query/transitions.js'
import type { TurnCutKind } from '../utils/messages/turnCut.js'
import type { NonNullableUsage } from '../services/api/emptyUsage.js'

export const ROWS_SCHEMA = 1

export const ROW_TYPES = [
  'session',
  'turn',
  'text',
  'reasoning',
  'tool_call',
  'tool_result',
  'tool_update',
  'step',
  'outcome',
  'wait',
  'heartbeat',
  'compaction',
  'mode',
  'rate_limit',
  'task',
  'notice',
  'command_output',
  'mission_updated',
  'samples_updated',
] as const
export type RowType = (typeof ROW_TYPES)[number]

export const PARTIAL_ROW_TYPES = ['block_start', 'text_delta', 'reasoning_delta', 'tool_input_delta', 'retracted'] as const
export type PartialRowType = (typeof PARTIAL_ROW_TYPES)[number]

export const INPUT_ROW_TYPES = ['prompt', 'shell', 'note'] as const
export type InputRowType = (typeof INPUT_ROW_TYPES)[number]

export const OUTCOME_STATUSES = ['completed', 'blocked', 'refused', 'interrupted', 'turn_limit', 'budget_limit', 'schema_unmet', 'loop_stopped', 'failed'] as const
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number]

export const STOP_WORDS = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal', 'pause', 'hook'] as const
export type StopWord = (typeof STOP_WORDS)[number]

export const ERROR_CLASSES = [
  'model',
  'auth',
  'billing',
  'rate_limit',
  'invalid_request',
  'server',
  'output_limit',
  'context_overflow',
  'context_limit',
  'image',
  'refill_breaker',
  'idle_timeout',
  'cut',
  'internal',
  'option',
  'command',
  'hook',
  'load',
  'interrupt',
  'turn_limit',
  'budget_limit',
  'schema_unmet',
  'loop_stopped',
  'blocked',
] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

export const HOOK_ENDING_CLASSES = ['closed_pipe', 'cancelled', 'timed_out', 'exit', 'spawn'] as const
export type HookEndingClass = (typeof HOOK_ENDING_CLASSES)[number]

export const HookEndingSchema = lazySchema(() =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), exit_code: z.literal(0) }),
    z.object({ status: z.literal('failed'), class: z.enum(HOOK_ENDING_CLASSES), exit_code: z.number().int(), detail: z.string().optional() }),
  ]),
)
export type HookEnding = z.infer<ReturnType<typeof HookEndingSchema>>

const HOOK_ENDING_WORDS: Record<HookEndingClass, (ending: Extract<HookEnding, { status: 'failed' }>, event: string) => string> = {
  closed_pipe: () => 'closed its input before Mercury finished writing it',
  cancelled: () => 'was cancelled',
  timed_out: (ending, event) => `timed out${ending.detail ? ` after ${ending.detail}` : ''} and was killed; the ${event} it guarded proceeded`,
  exit: ending => `failed with exit ${ending.exit_code}: ${ending.detail || 'no stderr output'}`,
  spawn: ending => `could not run${ending.detail ? `: ${ending.detail}` : ''}`,
}

export function hookEndingSentence(ending: HookEnding, hook: { name: string; event: string }): string {
  const who = `hook ${hook.name} (${hook.event})`
  if (ending.status === 'ok') return `${who} ended with exit 0`
  return `${who} ${HOOK_ENDING_WORDS[ending.class](ending, hook.event)}`
}

const envelopeFields = {
  seq: z.number().int().min(1),
  timestamp: z.string(),
  session_id: z.string(),
  turn: z.number().int().min(1).optional(),
  parent_call_id: z.string().optional(),
}

export const UsageSchema = lazySchema(() =>
  z.object({
    input_tokens: z.number().int().min(0),
    cached_input_tokens: z.number().int().min(0),
    cache_write_input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    reasoning_output_tokens: z.number().int().min(0).optional(),
  }),
)
export type Usage = z.infer<ReturnType<typeof UsageSchema>>

export const ModelUsageRowSchema = lazySchema(() =>
  UsageSchema().extend({
    cost_usd: z.number().min(0).optional(),
    web_searches: z.number().int().min(0),
  }),
)
export type ModelUsageRow = z.infer<ReturnType<typeof ModelUsageRowSchema>>

export const SessionRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('session'),
    ...envelopeFields,
    schema: z.literal(ROWS_SCHEMA),
    version: z.string(),
    build: z.string().optional(),
    resume_of: z.string().optional(),
    cwd: z.string(),
    model: z.string(),
    mode: z.string(),
    tools: z.array(z.string()),
    mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })),
    commands: z.array(z.string()),
    agents: z.array(z.string()),
    skills: z.array(z.string()),
    extensions: z.array(z.object({ name: z.string(), path: z.string(), id: z.string() })),
  }),
)
export type SessionRow = z.infer<ReturnType<typeof SessionRowSchema>>

export const TurnRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('turn'),
    ...envelopeFields,
    state: z.enum(['started', 'waiting']),
    turn_id: z.string(),
    message_ids: z.array(z.string()).optional(),
    model: z.string().optional(),
    agents: z.number().int().min(0).optional(),
  }),
)
export type TurnRow = z.infer<ReturnType<typeof TurnRowSchema>>

export const TextRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('text'),
    ...envelopeFields,
    message_id: z.string(),
    block: z.number().int().min(0),
    text: z.string(),
    phase: z.enum(['commentary', 'final_answer']).optional(),
  }),
)
export type TextRow = z.infer<ReturnType<typeof TextRowSchema>>

export const ReasoningRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('reasoning'),
    ...envelopeFields,
    message_id: z.string(),
    block: z.number().int().min(0),
    text: z.string(),
    redacted: z.literal(true).optional(),
  }),
)
export type ReasoningRow = z.infer<ReturnType<typeof ReasoningRowSchema>>

export const ToolCallRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('tool_call'),
    ...envelopeFields,
    call_id: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()),
    message_id: z.string(),
    block: z.number().int().min(0),
  }),
)
export type ToolCallRow = z.infer<ReturnType<typeof ToolCallRowSchema>>

export const ToolResultRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('tool_result'),
    ...envelopeFields,
    call_id: z.string(),
    status: z.enum(['ok', 'error', 'aborted', 'refused']),
    output: z.string(),
  }),
)
export type ToolResultRow = z.infer<ReturnType<typeof ToolResultRowSchema>>

export const ToolUpdateRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('tool_update'),
    ...envelopeFields,
    call_id: z.string(),
    tick: z.number().int().min(1),
    source: z.enum(['shell', 'powershell', 'mcp', 'eval']),
    line: z.string().optional(),
    elapsed_s: z.number().optional(),
    lines: z.number().int().optional(),
    bytes: z.number().int().optional(),
    budget_ms: z.number().optional(),
    progress: z.number().optional(),
    total: z.number().optional(),
  }),
)
export type ToolUpdateRow = z.infer<ReturnType<typeof ToolUpdateRowSchema>>

export const StepRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('step'),
    ...envelopeFields,
    message_id: z.string(),
    model: z.string(),
    stop: z.enum(STOP_WORDS).optional(),
    usage: UsageSchema(),
  }),
)
export type StepRow = z.infer<ReturnType<typeof StepRowSchema>>

export const OutcomeErrorSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    class: z.enum(ERROR_CLASSES),
    detail: z.array(z.string()).optional(),
  }),
)
export type OutcomeError = z.infer<ReturnType<typeof OutcomeErrorSchema>>

export const DenialSchema = lazySchema(() =>
  z.object({
    tool: z.string(),
    call_id: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
)
export type Denial = z.infer<ReturnType<typeof DenialSchema>>

export const OutcomeRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('outcome'),
    ...envelopeFields,
    schema: z.literal(ROWS_SCHEMA),
    turn: z.number().int().min(1),
    turn_id: z.string(),
    status: z.enum(OUTCOME_STATUSES),
    stop: z.enum(STOP_WORDS).optional(),
    answer: z.string().optional(),
    structured: z.unknown().optional(),
    error: OutcomeErrorSchema().optional(),
    steps: z.number().int().min(0),
    wall_ms: z.number().int().min(0),
    api_ms: z.number().int().min(0).optional(),
    cost_usd: z.number().min(0).optional(),
    usage: UsageSchema(),
    models: z.record(z.string(), ModelUsageRowSchema()),
    denials: z.array(DenialSchema()),
    notices: z.array(z.object({ level: z.enum(['warning', 'error']), text: z.string() })).optional(),
  }),
)
export type OutcomeRow = z.infer<ReturnType<typeof OutcomeRowSchema>>

export const WaitRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('wait'),
    ...envelopeFields,
    state: z.enum(['first_byte', 'retry', 'silence', 'loading', 'done']),
    cold: z.boolean().optional(),
    prompt_tokens_estimate: z.number().optional(),
    model: z.string().optional(),
    budget_ms: z.number().optional(),
    since_ms: z.number().optional(),
    attempt: z.number().optional(),
    of: z.number().optional(),
    reason: z.string().optional(),
    delay_ms: z.number().optional(),
    http_status: z.number().nullable().optional(),
    silent_ms: z.number().optional(),
    answered: z.boolean().optional(),
    ask_at_ms: z.number().optional(),
    promise: z.boolean().optional(),
    size_gb: z.number().optional(),
    checked_ms: z.number().optional(),
  }),
)
export type WaitRow = z.infer<ReturnType<typeof WaitRowSchema>>

export const HeartbeatRowSchema = lazySchema(() => z.object({ type: z.literal('heartbeat'), ...envelopeFields }))
export type HeartbeatRow = z.infer<ReturnType<typeof HeartbeatRowSchema>>

export const CompactionRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('compaction'),
    ...envelopeFields,
    state: z.enum(['started', 'progress', 'ended']),
    trigger: z.enum(['manual', 'auto', 'overflow']),
    stages: z.array(z.string()).optional(),
    stage: z.string().nullable().optional(),
    fill: z.number().nullable().optional(),
    summary_tokens: z.number().optional(),
    summary_cap_tokens: z.number().optional(),
    attempt: z.number().optional(),
    retry_why: z.enum(['refused']).optional(),
    exit: z.enum(['landed', 'cancelled', 'failed']).optional(),
    tokens_before: z.number().optional(),
  }),
)
export type CompactionRow = z.infer<ReturnType<typeof CompactionRowSchema>>

export const ModeRowSchema = lazySchema(() => z.object({ type: z.literal('mode'), ...envelopeFields, mode: z.string() }))
export type ModeRow = z.infer<ReturnType<typeof ModeRowSchema>>

export const RateLimitRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('rate_limit'),
    ...envelopeFields,
    status: z.enum(['allowed', 'warning', 'rejected']),
    window: z.string().optional(),
    resets_at: z.number().optional(),
    utilization: z.number().optional(),
    overage_status: z.enum(['allowed', 'warning', 'rejected']).optional(),
    overage_resets_at: z.number().optional(),
    overage_disabled_reason: z.string().optional(),
    using_overage: z.boolean().optional(),
    threshold_crossed: z.boolean().optional(),
  }),
)
export type RateLimitRow = z.infer<ReturnType<typeof RateLimitRowSchema>>

export const TaskRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('task'),
    ...envelopeFields,
    state: z.enum(['started', 'progress', 'ended']),
    task_id: z.string(),
    call_id: z.string().optional(),
    task_type: z.string().optional(),
    description: z.string().optional(),
    workflow: z.string().optional(),
    prompt: z.string().optional(),
    usage: z.object({ tokens: z.number(), tool_uses: z.number(), duration_ms: z.number() }).optional(),
    last_tool: z.string().optional(),
    summary: z.string().optional(),
    workflow_progress: z.unknown().optional(),
    status: z.enum(['completed', 'failed', 'stopped']).optional(),
    output_file: z.string().optional(),
  }),
)
export type TaskRow = z.infer<ReturnType<typeof TaskRowSchema>>

export const NoticeRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('notice'),
    ...envelopeFields,
    level: z.enum(['warning', 'error']),
    text: z.string(),
    code: z.string().optional(),
  }),
)
export type NoticeRow = z.infer<ReturnType<typeof NoticeRowSchema>>

export const CommandOutputRowSchema = lazySchema(() =>
  z.object({ type: z.literal('command_output'), ...envelopeFields, command: z.string().optional(), text: z.string() }),
)
export type CommandOutputRow = z.infer<ReturnType<typeof CommandOutputRowSchema>>

export const MissionUpdatedRowSchema = lazySchema(() => z.object({ type: z.literal('mission_updated'), ...envelopeFields }))
export type MissionUpdatedRow = z.infer<ReturnType<typeof MissionUpdatedRowSchema>>
export const SamplesUpdatedRowSchema = lazySchema(() => z.object({ type: z.literal('samples_updated'), ...envelopeFields }))
export type SamplesUpdatedRow = z.infer<ReturnType<typeof SamplesUpdatedRowSchema>>

export const BlockStartRowSchema = lazySchema(() =>
  z.object({
    type: z.literal('block_start'),
    ...envelopeFields,
    message_id: z.string(),
    block: z.number().int().min(0),
    of: z.enum(['text', 'reasoning', 'tool_call']),
    phase: z.enum(['commentary', 'final_answer']).optional(),
    call_id: z.string().optional(),
    tool: z.string().optional(),
  }),
)
export type BlockStartRow = z.infer<ReturnType<typeof BlockStartRowSchema>>
export const TextDeltaRowSchema = lazySchema(() =>
  z.object({ type: z.literal('text_delta'), ...envelopeFields, message_id: z.string(), block: z.number().int().min(0), text: z.string() }),
)
export type TextDeltaRow = z.infer<ReturnType<typeof TextDeltaRowSchema>>
export const ReasoningDeltaRowSchema = lazySchema(() =>
  z.object({ type: z.literal('reasoning_delta'), ...envelopeFields, message_id: z.string(), block: z.number().int().min(0), text: z.string() }),
)
export type ReasoningDeltaRow = z.infer<ReturnType<typeof ReasoningDeltaRowSchema>>
export const ToolInputDeltaRowSchema = lazySchema(() =>
  z.object({ type: z.literal('tool_input_delta'), ...envelopeFields, message_id: z.string(), block: z.number().int().min(0), json: z.string() }),
)
export type ToolInputDeltaRow = z.infer<ReturnType<typeof ToolInputDeltaRowSchema>>
export const RetractedRowSchema = lazySchema(() => z.object({ type: z.literal('retracted'), ...envelopeFields, message_id: z.string() }))
export type RetractedRow = z.infer<ReturnType<typeof RetractedRowSchema>>

export const RowSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    SessionRowSchema(),
    TurnRowSchema(),
    TextRowSchema(),
    ReasoningRowSchema(),
    ToolCallRowSchema(),
    ToolResultRowSchema(),
    ToolUpdateRowSchema(),
    StepRowSchema(),
    OutcomeRowSchema(),
    WaitRowSchema(),
    HeartbeatRowSchema(),
    CompactionRowSchema(),
    ModeRowSchema(),
    RateLimitRowSchema(),
    TaskRowSchema(),
    NoticeRowSchema(),
    CommandOutputRowSchema(),
    MissionUpdatedRowSchema(),
    SamplesUpdatedRowSchema(),
    BlockStartRowSchema(),
    TextDeltaRowSchema(),
    ReasoningDeltaRowSchema(),
    ToolInputDeltaRowSchema(),
    RetractedRowSchema(),
  ]),
)
export type Row = z.infer<ReturnType<typeof RowSchema>>

export const InputBlockSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), media_type: z.string(), data: z.string() }),
  ]),
)
export type InputBlock = z.infer<ReturnType<typeof InputBlockSchema>>

const inputStamp = {
  id: z.string().optional(),
  priority: z.enum(['now', 'next', 'later']).optional(),
  sent_at: z.string().optional(),
  origin: z.looseObject({ kind: z.string() }).optional(),
}

export const PromptRowSchema = lazySchema(() =>
  z.object({ type: z.literal('prompt'), content: z.union([z.string(), z.array(InputBlockSchema())]), ...inputStamp }),
)
export type PromptRow = z.infer<ReturnType<typeof PromptRowSchema>>
export const ShellRowSchema = lazySchema(() => z.object({ type: z.literal('shell'), command: z.string(), ...inputStamp }))
export type ShellRow = z.infer<ReturnType<typeof ShellRowSchema>>
export const NoteRowSchema = lazySchema(() => z.object({ type: z.literal('note'), to: z.string(), content: z.string(), id: z.string().optional() }))
export type NoteRow = z.infer<ReturnType<typeof NoteRowSchema>>
export const InputRowSchema = lazySchema(() => z.discriminatedUnion('type', [PromptRowSchema(), ShellRowSchema(), NoteRowSchema()]))
export type InputRow = z.infer<ReturnType<typeof InputRowSchema>>

export function usageOf(usage: Pick<NonNullableUsage, 'input_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'output_tokens'> & { output_tokens_details?: { thinking_tokens: number } | null }): Usage {
  const cached = Math.max(0, usage.cache_read_input_tokens)
  const written = Math.max(0, usage.cache_creation_input_tokens)
  const reasoning = usage.output_tokens_details?.thinking_tokens
  return {
    input_tokens: Math.max(0, usage.input_tokens) + cached + written,
    cached_input_tokens: cached,
    cache_write_input_tokens: written,
    output_tokens: Math.max(0, usage.output_tokens),
    ...(typeof reasoning === 'number' && reasoning > 0 ? { reasoning_output_tokens: reasoning } : {}),
  }
}

export function statusOfTerminal(terminal: Terminal, cut: TurnCutKind | null): { status: OutcomeStatus; errorClass?: ErrorClass } {
  switch (terminal.reason) {
    case 'completed':
    case 'stop_hook_prevented':
    case 'hook_stopped':
      return { status: 'completed' }
    case 'max_turns':
      return { status: 'turn_limit' }
    case 'loop_stopped':
      return { status: 'loop_stopped' }
    case 'aborted_streaming':
    case 'aborted_tools':
      if (cut === 'idle-timeout') return { status: 'failed', errorClass: 'idle_timeout' }
      if (cut === 'cut') return { status: 'failed', errorClass: 'cut' }
      return { status: 'interrupted' }
    case 'model_error':
      return { status: 'failed', errorClass: 'model' }
    case 'image_error':
      return { status: 'failed', errorClass: 'image' }
    case 'prompt_too_long':
      return { status: 'failed', errorClass: 'context_overflow' }
    case 'blocking_limit':
      return { status: 'failed', errorClass: 'context_limit' }
    case 'rapid_refill_breaker':
      return { status: 'failed', errorClass: 'refill_breaker' }
    case 'tool_calls_refused':
      return { status: 'failed', errorClass: 'model' }
  }
}

const ERROR_CLASS_OF_ASSISTANT_ERROR: Record<AssistantMessageError, ErrorClass> = {
  authentication_failed: 'auth',
  billing_error: 'billing',
  rate_limit: 'rate_limit',
  invalid_request: 'invalid_request',
  server_error: 'server',
  unknown: 'model',
  max_output_tokens: 'output_limit',
}

export function errorClassOf(error: AssistantMessageError | string | undefined): ErrorClass {
  if (error !== undefined && (ASSISTANT_MESSAGE_ERRORS as readonly string[]).includes(error)) {
    return ERROR_CLASS_OF_ASSISTANT_ERROR[error as AssistantMessageError]
  }
  return 'model'
}

export function stopWordOf(stopReason: string | null | undefined): StopWord | undefined {
  switch (stopReason) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'refusal':
    case 'pause':
    case 'hook':
      return stopReason
    case 'pause_turn':
      return 'pause'
    case 'stop_hook_prevented':
    case 'hook_stopped':
      return 'hook'
    default:
      return undefined
  }
}

export function exitCodeOf(status: OutcomeStatus): 0 | 1 {
  return status === 'completed' ? 0 : 1
}

export const TERMINAL_FAILURE_SENTENCES: Record<Terminal['reason'], string> = {
  completed: 'The turn ended',
  model_error: 'The model call failed',
  image_error: 'The turn failed: an image in the conversation could not be sent to the model (too large, or it could not be resized)',
  prompt_too_long: 'The turn failed: the conversation no longer fits the model\'s context window and compaction could not make it fit',
  blocking_limit: 'The turn failed: the next request would exceed the model\'s context window and nothing more could be pruned — /compact or a fresh session makes room',
  rapid_refill_breaker: 'The turn failed: the context refilled to its limit within a few turns of each compaction, so compaction was stopped — a fresh session makes room',
  max_turns: 'Reached the maximum number of turns',
  aborted_streaming: 'Interrupted',
  aborted_tools: 'Interrupted',
  stop_hook_prevented: 'The turn ended',
  hook_stopped: 'The turn ended',
  loop_stopped: 'The loop guard ended the turn',
  tool_calls_refused: 'The turn failed: every tool call the model made was refused before execution and it could not shape a valid call after being corrected',
}

export function toolCallsRefusedSentence(terminal: Extract<Terminal, { reason: 'tool_calls_refused' }>): string {
  return `The turn failed: every tool call the model made (${terminal.tools.join(', ')}) was refused before execution, and ${terminal.corrections} correction${terminal.corrections === 1 ? '' : 's'} did not produce a valid call`
}

export const OUTCOME_SENTENCES: Record<Exclude<OutcomeStatus, 'completed' | 'refused' | 'failed'>, (detail: { maxTurns?: number; maxBudgetUsd?: number; message?: string }) => string> = {
  blocked: d => d.message ?? 'Blocked on the operator',
  interrupted: () => 'Interrupted',
  turn_limit: d => `Reached the maximum number of turns (${d.maxTurns ?? 'configured limit'})`,
  budget_limit: d => `Reached the maximum budget of $${d.maxBudgetUsd ?? 'the configured amount'}`,
  schema_unmet: () => 'Valid structured output was not produced within the retry limit',
  loop_stopped: d => d.message ?? 'The loop guard ended the turn: a cycle of tool calls repeated with identical arguments and results',
}

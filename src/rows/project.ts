import stripAnsi from 'strip-ansi'
import { randomUUID, type UUID as CryptoUUID } from 'node:crypto'
import { BASH_STDERR_TAG, BASH_STDOUT_TAG, LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../constants/xml.js'
import { unescapeXml } from '../utils/xml.js'
import type { FoldStatusV1 } from '../services/compact/foldStatus.js'
import type { RequestWaitV1 } from '../services/providers/streamIdleBudget.js'
import type { NonNullableUsage } from '../services/api/emptyUsage.js'
import type { ModelUsage } from '../bootstrap/state.js'
import {
  ROWS_SCHEMA,
  stopWordOf,
  usageOf,
  type BlockStartRow,
  type CommandOutputRow,
  type CompactionRow,
  type Denial,
  type ErrorClass,
  type HeartbeatRow,
  type MissionUpdatedRow,
  type ModeRow,
  type ModelUsageRow,
  type NoticeRow,
  type OutcomeError,
  type OutcomeRow,
  type OutcomeStatus,
  type RateLimitRow,
  type ReasoningDeltaRow,
  type ReasoningRow,
  type RetractedRow,
  type Row,
  type SamplesUpdatedRow,
  type SessionRow,
  type StepRow,
  type TaskRow,
  type TextDeltaRow,
  type TextRow,
  type ToolCallRow,
  type ToolInputDeltaRow,
  type ToolResultRow,
  type ToolUpdateRow,
  type TurnRow,
  type WaitRow,
} from './vocabulary.js'

export type Unstamped<R extends Row> = Omit<R, 'seq' | 'timestamp'>
export type RowDraft = Unstamped<Row>

export interface MessageStamp {
  timestamp: string
  uuid: CryptoUUID
}

export interface RowStamper {
  stamp<R extends Row>(draft: Unstamped<R>): R
  mint(overrides?: { uuid?: CryptoUUID | string; timestamp?: string }): MessageStamp
  id(): CryptoUUID
  readonly seq: number
}

export function createRowStamper(clock: () => string = () => new Date().toISOString()): RowStamper {
  let seq = 0
  return {
    stamp<R extends Row>(draft: Unstamped<R>): R {
      seq += 1
      return { ...(draft as object), seq, timestamp: clock() } as R
    },
    mint(overrides = {}): MessageStamp {
      const uuid = (overrides.uuid as CryptoUUID | undefined) || this.id()
      const timestamp = overrides.timestamp ?? clock()
      return { timestamp, uuid }
    },
    id: randomUUID,
    get seq() {
      return seq
    },
  }
}

export const MESSAGE_STAMPER: RowStamper = createRowStamper()

export interface RowScope {
  session_id: string
  turn?: number
  parent_call_id?: string
}

function scoped<T extends object>(scope: RowScope, fields: T): T & RowScope {
  return {
    ...fields,
    session_id: scope.session_id,
    ...(scope.turn !== undefined ? { turn: scope.turn } : {}),
    ...(scope.parent_call_id !== undefined ? { parent_call_id: scope.parent_call_id } : {}),
  }
}

export interface SessionFacts {
  version: string
  build?: string
  resumeOf?: string
  cwd: string
  model: string
  mode: string
  tools: string[]
  mcpServers: Array<{ name: string; status: string }>
  commands: string[]
  agents: string[]
  skills: string[]
  extensions: Array<{ name: string; path: string; id: string }>
}

export function sessionRow(scope: RowScope, facts: SessionFacts): Unstamped<SessionRow> {
  return scoped(
    { session_id: scope.session_id },
    {
      type: 'session' as const,
      schema: ROWS_SCHEMA as 1,
      version: facts.version,
      ...(facts.build !== undefined ? { build: facts.build } : {}),
      ...(facts.resumeOf !== undefined ? { resume_of: facts.resumeOf } : {}),
      cwd: facts.cwd,
      model: facts.model,
      mode: facts.mode,
      tools: facts.tools,
      mcp_servers: facts.mcpServers,
      commands: facts.commands,
      agents: facts.agents,
      skills: facts.skills,
      extensions: facts.extensions,
    },
  )
}

export function turnStartedRow(scope: RowScope, facts: { turnId: string; messageIds: string[]; model: string }): Unstamped<TurnRow> {
  return scoped(scope, { type: 'turn' as const, state: 'started' as const, turn_id: facts.turnId, message_ids: facts.messageIds, model: facts.model })
}

export function turnWaitingRow(scope: RowScope, facts: { turnId: string; agents: number }): Unstamped<TurnRow> {
  return scoped(scope, { type: 'turn' as const, state: 'waiting' as const, turn_id: facts.turnId, agents: facts.agents })
}

type ContentBlock = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; phase?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

export type ItemRow = Unstamped<TextRow> | Unstamped<ReasoningRow> | Unstamped<ToolCallRow>

export function itemRowsOf(scope: RowScope, messageId: string, content: unknown, firstBlock = 0): ItemRow[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [scoped(scope, { type: 'text' as const, message_id: messageId, block: firstBlock, text: content })]
  }
  if (!Array.isArray(content)) return []
  const rows: ItemRow[] = []
  ;(content as ContentBlock[]).forEach((block, offset) => {
    const index = firstBlock + offset
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') {
          rows.push(
            scoped(scope, {
              type: 'text' as const,
              message_id: messageId,
              block: index,
              text: block.text,
              ...(block.phase === 'commentary' || block.phase === 'final_answer' ? { phase: block.phase } : {}),
            }),
          )
        }
        break
      case 'thinking':
        rows.push(scoped(scope, { type: 'reasoning' as const, message_id: messageId, block: index, text: typeof block.thinking === 'string' ? block.thinking : '' }))
        break
      case 'redacted_thinking':
        rows.push(scoped(scope, { type: 'reasoning' as const, message_id: messageId, block: index, text: '', redacted: true as const }))
        break
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use':
        rows.push(
          scoped(scope, {
            type: 'tool_call' as const,
            message_id: messageId,
            block: index,
            call_id: typeof block.id === 'string' ? block.id : `${messageId}.${index}`,
            tool: typeof block.name === 'string' ? block.name : '',
            input: block.input !== null && typeof block.input === 'object' && !Array.isArray(block.input) ? (block.input as Record<string, unknown>) : {},
          }),
        )
        break
      default:
        break
    }
  })
  return rows
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  const texts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image') texts.push('[image]')
    else if (block.type === 'tool_reference' && typeof (block as { tool_name?: unknown }).tool_name === 'string') texts.push(`[tool_reference: ${(block as { tool_name: string }).tool_name}]`)
  }
  return texts.join('\n')
}

export function toolResultRowsOf(scope: RowScope, content: unknown, statusOf: (callId: string, isError: boolean) => ToolResultRow['status'] = (_, isError) => (isError ? 'error' : 'ok')): Array<Unstamped<ToolResultRow>> {
  if (!Array.isArray(content)) return []
  const rows: Array<Unstamped<ToolResultRow>> = []
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    rows.push(scoped(scope, { type: 'tool_result' as const, call_id: block.tool_use_id, status: statusOf(block.tool_use_id, block.is_error === true), output: toolResultText(block.content) }))
  }
  return rows
}

export function toolUpdateRow(
  scope: RowScope,
  facts: { callId: string; tick: number; source: ToolUpdateRow['source']; line?: string; elapsedS?: number; lines?: number; bytes?: number; budgetMs?: number; progress?: number; total?: number },
): Unstamped<ToolUpdateRow> {
  return scoped(scope, {
    type: 'tool_update' as const,
    call_id: facts.callId,
    tick: facts.tick,
    source: facts.source,
    ...(facts.line !== undefined ? { line: facts.line } : {}),
    ...(facts.elapsedS !== undefined ? { elapsed_s: facts.elapsedS } : {}),
    ...(facts.lines !== undefined ? { lines: facts.lines } : {}),
    ...(facts.bytes !== undefined ? { bytes: facts.bytes } : {}),
    ...(facts.budgetMs !== undefined ? { budget_ms: facts.budgetMs } : {}),
    ...(facts.progress !== undefined ? { progress: facts.progress } : {}),
    ...(facts.total !== undefined ? { total: facts.total } : {}),
  })
}

export function stepRow(scope: RowScope, facts: { messageId: string; model: string; stopReason: string | null | undefined; usage: NonNullableUsage }): Unstamped<StepRow> {
  const stop = stopWordOf(facts.stopReason)
  return scoped(scope, { type: 'step' as const, message_id: facts.messageId, model: facts.model, ...(stop !== undefined ? { stop } : {}), usage: usageOf(facts.usage) })
}

export function modelUsageRows(usage: Record<string, ModelUsage> | undefined, hasUnknownCost: (model: string) => boolean = () => false): Record<string, ModelUsageRow> {
  const out: Record<string, ModelUsageRow> = {}
  for (const [model, row] of Object.entries(usage ?? {})) {
    out[model] = {
      input_tokens: Math.max(0, row.inputTokens) + Math.max(0, row.cacheReadInputTokens) + Math.max(0, row.cacheCreationInputTokens),
      cached_input_tokens: Math.max(0, row.cacheReadInputTokens),
      cache_write_input_tokens: Math.max(0, row.cacheCreationInputTokens),
      output_tokens: Math.max(0, row.outputTokens),
      ...(hasUnknownCost(model) ? {} : { cost_usd: Math.max(0, row.costUSD) }),
      web_searches: Math.max(0, row.webSearchRequests),
    }
  }
  return out
}

export interface OutcomeFacts {
  turnId: string
  status: OutcomeStatus
  stopReason?: string | null
  answer?: string
  structured?: unknown
  error?: { message: string; class: ErrorClass; detail?: string[] }
  steps: number
  wallMs: number
  apiMs?: number
  costUsd?: number
  usage: NonNullableUsage
  models: Record<string, ModelUsageRow>
  denials: Denial[]
  notices?: Array<{ level: 'warning' | 'error'; text: string }>
}

export function outcomeRow(scope: RowScope & { turn: number }, facts: OutcomeFacts): Unstamped<OutcomeRow> {
  const stop = stopWordOf(facts.stopReason)
  const error: OutcomeError | undefined = facts.error
  return scoped(scope, {
    type: 'outcome' as const,
    schema: ROWS_SCHEMA as 1,
    turn: scope.turn,
    turn_id: facts.turnId,
    status: facts.status,
    ...(stop !== undefined ? { stop } : {}),
    ...((facts.status === 'completed' || facts.status === 'blocked') && facts.answer !== undefined ? { answer: facts.answer } : {}),
    ...(facts.structured !== undefined ? { structured: facts.structured } : {}),
    ...(error !== undefined ? { error } : {}),
    steps: facts.steps,
    wall_ms: facts.wallMs,
    ...(facts.apiMs !== undefined ? { api_ms: facts.apiMs } : {}),
    ...(facts.costUsd !== undefined ? { cost_usd: facts.costUsd } : {}),
    usage: usageOf(facts.usage),
    models: facts.models,
    denials: facts.denials,
    ...(facts.notices !== undefined && facts.notices.length > 0 ? { notices: facts.notices } : {}),
  })
}

export function waitRow(scope: RowScope, wait: RequestWaitV1 | null): Unstamped<WaitRow> {
  if (wait === null) return scoped(scope, { type: 'wait' as const, state: 'done' as const })
  switch (wait.kind) {
    case 'first-byte':
      return scoped(scope, {
        type: 'wait' as const,
        state: wait.phase === 'loading' ? ('loading' as const) : ('first_byte' as const),
        cold: wait.cold,
        prompt_tokens_estimate: wait.promptTokens,
        model: wait.model,
        budget_ms: wait.budgetMs,
        since_ms: wait.sinceMs,
        attempt: wait.attempt,
        ...(wait.promise !== undefined ? { promise: wait.promise } : {}),
        ...(wait.sizeGb !== undefined ? { size_gb: wait.sizeGb } : {}),
        ...(wait.checkedMs !== undefined ? { checked_ms: wait.checkedMs } : {}),
      })
    case 'retry':
      return scoped(scope, { type: 'wait' as const, state: 'retry' as const, attempt: wait.attempt, of: wait.of, reason: wait.reason, delay_ms: wait.delayMs, since_ms: wait.sinceMs })
    case 'silence':
      return scoped(scope, {
        type: 'wait' as const,
        state: 'silence' as const,
        model: wait.model,
        silent_ms: wait.silentMs,
        since_ms: wait.sinceMs,
        answered: wait.answered,
        ...(wait.askAtMs !== undefined ? { ask_at_ms: wait.askAtMs } : {}),
      })
  }
}

export function retryWaitRow(scope: RowScope, facts: { attempt?: number; of?: number; reason: string; delayMs?: number; httpStatus?: number | null; sinceMs: number }): Unstamped<WaitRow> {
  return scoped(scope, {
    type: 'wait' as const,
    state: 'retry' as const,
    ...(facts.attempt !== undefined ? { attempt: facts.attempt } : {}),
    ...(facts.of !== undefined ? { of: facts.of } : {}),
    reason: facts.reason,
    ...(facts.delayMs !== undefined ? { delay_ms: facts.delayMs } : {}),
    ...(facts.httpStatus !== undefined ? { http_status: facts.httpStatus } : {}),
    since_ms: facts.sinceMs,
  })
}

export function heartbeatRow(scope: RowScope): Unstamped<HeartbeatRow> {
  return scoped(scope, { type: 'heartbeat' as const })
}

export function compactionRow(scope: RowScope, fold: FoldStatusV1 | null, trigger?: CompactionRow['trigger']): Unstamped<CompactionRow> {
  if (fold === null) return scoped(scope, { type: 'compaction' as const, state: 'started' as const, trigger: trigger ?? 'auto' })
  const state: CompactionRow['state'] = fold.exit !== undefined ? 'ended' : fold.stage === null ? 'started' : 'progress'
  return scoped(scope, {
    type: 'compaction' as const,
    state,
    trigger: fold.trigger,
    stages: [...fold.stages],
    stage: fold.stage,
    fill: fold.fill,
    summary_tokens: fold.summaryTokens,
    summary_cap_tokens: fold.summaryCapTokens,
    attempt: fold.attempt,
    ...(fold.retryWhy !== undefined ? { retry_why: fold.retryWhy } : {}),
    ...(fold.exit !== undefined ? { exit: fold.exit } : {}),
  })
}

export function compactionEndedRow(scope: RowScope, facts: { trigger: CompactionRow['trigger']; tokensBefore?: number }): Unstamped<CompactionRow> {
  return scoped(scope, { type: 'compaction' as const, state: 'ended' as const, trigger: facts.trigger, exit: 'landed' as const, ...(facts.tokensBefore !== undefined ? { tokens_before: facts.tokensBefore } : {}) })
}

export function compactionClearedRow(scope: RowScope, trigger: CompactionRow['trigger']): Unstamped<CompactionRow> {
  return scoped(scope, { type: 'compaction' as const, state: 'ended' as const, trigger })
}

export function modeRow(scope: RowScope, mode: string): Unstamped<ModeRow> {
  return scoped(scope, { type: 'mode' as const, mode })
}

export interface RateLimitFacts {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: string | undefined
  resetsAt?: number | undefined
  utilization?: number | undefined
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected' | undefined
  overageResetsAt?: number | undefined
  overageDisabledReason?: string | undefined
  isUsingOverage: boolean
  surpassedThreshold?: number | undefined
}

const RATE_STATUS: Record<RateLimitFacts['status'], RateLimitRow['status']> = { allowed: 'allowed', allowed_warning: 'warning', rejected: 'rejected' }

export function rateLimitRow(scope: RowScope, limits: RateLimitFacts): Unstamped<RateLimitRow> {
  return scoped(scope, {
    type: 'rate_limit' as const,
    status: RATE_STATUS[limits.status],
    ...(limits.rateLimitType !== undefined ? { window: String(limits.rateLimitType) } : {}),
    ...(limits.resetsAt !== undefined ? { resets_at: limits.resetsAt } : {}),
    ...(limits.utilization !== undefined ? { utilization: limits.utilization } : {}),
    ...(limits.overageStatus !== undefined ? { overage_status: RATE_STATUS[limits.overageStatus] } : {}),
    ...(limits.overageResetsAt !== undefined ? { overage_resets_at: limits.overageResetsAt } : {}),
    ...(limits.overageDisabledReason !== undefined ? { overage_disabled_reason: String(limits.overageDisabledReason) } : {}),
    using_overage: limits.isUsingOverage,
    ...(limits.surpassedThreshold !== undefined ? { threshold_crossed: limits.surpassedThreshold > 0 } : {}),
  })
}

export function taskRow(
  scope: RowScope,
  facts: {
    state: TaskRow['state']
    taskId: string
    callId?: string
    taskType?: string
    description?: string
    workflow?: string
    prompt?: string
    usage?: { tokens: number; toolUses: number; durationMs: number }
    lastTool?: string
    summary?: string
    workflowProgress?: unknown
    status?: TaskRow['status']
    outputFile?: string
  },
): Unstamped<TaskRow> {
  return scoped(scope, {
    type: 'task' as const,
    state: facts.state,
    task_id: facts.taskId,
    ...(facts.callId !== undefined ? { call_id: facts.callId } : {}),
    ...(facts.taskType !== undefined ? { task_type: facts.taskType } : {}),
    ...(facts.description !== undefined ? { description: facts.description } : {}),
    ...(facts.workflow !== undefined ? { workflow: facts.workflow } : {}),
    ...(facts.prompt !== undefined ? { prompt: facts.prompt } : {}),
    ...(facts.usage !== undefined ? { usage: { tokens: facts.usage.tokens, tool_uses: facts.usage.toolUses, duration_ms: facts.usage.durationMs } } : {}),
    ...(facts.lastTool !== undefined ? { last_tool: facts.lastTool } : {}),
    ...(facts.summary !== undefined ? { summary: facts.summary } : {}),
    ...(facts.workflowProgress !== undefined ? { workflow_progress: facts.workflowProgress } : {}),
    ...(facts.status !== undefined ? { status: facts.status } : {}),
    ...(facts.outputFile !== undefined ? { output_file: facts.outputFile } : {}),
  })
}

export function noticeRow(scope: RowScope, level: NoticeRow['level'], text: string, code?: string): Unstamped<NoticeRow> {
  return scoped(scope, { type: 'notice' as const, level, text, ...(code !== undefined ? { code } : {}) })
}

export function commandOutputTextOf(text: string): string {
  return stripAnsi(text)
    .replace(new RegExp(`<${LOCAL_COMMAND_STDOUT_TAG}>([\\s\\S]*?)</${LOCAL_COMMAND_STDOUT_TAG}>`), '$1')
    .replace(new RegExp(`<${LOCAL_COMMAND_STDERR_TAG}>([\\s\\S]*?)</${LOCAL_COMMAND_STDERR_TAG}>`), '$1')
    .trim()
}

export function shellOutputTextOf(text: string): string | null {
  const stdout = new RegExp(`<${BASH_STDOUT_TAG}>([\\s\\S]*)</${BASH_STDOUT_TAG}>`).exec(text)?.[1]
  const stderr = new RegExp(`<${BASH_STDERR_TAG}>([\\s\\S]*?)</${BASH_STDERR_TAG}>`).exec(text)?.[1]
  if (stdout === undefined && stderr === undefined) return null
  return stripAnsi([stdout ?? '', unescapeXml(stderr ?? '')].filter(part => part !== '').join('\n')).trim()
}

export function commandOutputRow(scope: RowScope, text: string, command?: string): Unstamped<CommandOutputRow> {
  return scoped(scope, { type: 'command_output' as const, ...(command !== undefined ? { command } : {}), text })
}

export function missionUpdatedRow(scope: RowScope): Unstamped<MissionUpdatedRow> {
  return scoped(scope, { type: 'mission_updated' as const })
}

export function samplesUpdatedRow(scope: RowScope): Unstamped<SamplesUpdatedRow> {
  return scoped(scope, { type: 'samples_updated' as const })
}

export type PartialRow = Unstamped<BlockStartRow> | Unstamped<TextDeltaRow> | Unstamped<ReasoningDeltaRow> | Unstamped<ToolInputDeltaRow> | Unstamped<RetractedRow>

type StreamEvent = {
  type?: string
  index?: number
  content_block?: { type?: string; phase?: string; id?: string; name?: string; input?: unknown }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
}

export function partialRowsOf(scope: RowScope, messageId: string, event: StreamEvent): PartialRow[] {
  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block
      const index = event.index ?? 0
      if (block?.type === 'text') {
        return [scoped(scope, { type: 'block_start' as const, message_id: messageId, block: index, of: 'text' as const, ...(block.phase === 'commentary' || block.phase === 'final_answer' ? { phase: block.phase } : {}) })]
      }
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        return [scoped(scope, { type: 'block_start' as const, message_id: messageId, block: index, of: 'reasoning' as const })]
      }
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use' || block?.type === 'mcp_tool_use') {
        const rows: PartialRow[] = [
          scoped(scope, {
            type: 'block_start' as const,
            message_id: messageId,
            block: index,
            of: 'tool_call' as const,
            ...(typeof block.id === 'string' ? { call_id: block.id } : {}),
            ...(typeof block.name === 'string' ? { tool: block.name } : {}),
          }),
        ]
        if (block.input !== undefined && block.input !== null && typeof block.input === 'object' && Object.keys(block.input as object).length > 0) {
          rows.push(scoped(scope, { type: 'tool_input_delta' as const, message_id: messageId, block: index, json: JSON.stringify(block.input) }))
        }
        return rows
      }
      return []
    }
    case 'content_block_delta': {
      const delta = event.delta
      const index = event.index ?? 0
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return [scoped(scope, { type: 'text_delta' as const, message_id: messageId, block: index, text: delta.text })]
      }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        return [scoped(scope, { type: 'reasoning_delta' as const, message_id: messageId, block: index, text: delta.thinking })]
      }
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        return [scoped(scope, { type: 'tool_input_delta' as const, message_id: messageId, block: index, json: delta.partial_json })]
      }
      return []
    }
    default:
      return []
  }
}

export function retractedRow(scope: RowScope, messageId: string): Unstamped<RetractedRow> {
  return scoped(scope, { type: 'retracted' as const, message_id: messageId })
}

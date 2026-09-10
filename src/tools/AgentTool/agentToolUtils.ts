
import { z } from 'zod'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import type { Message } from '../../types/message.js'
import type { SetAppState } from '../../Task.js'
import {
  AGENT_BUDGET_RESUME_NOTE,
  AGENT_RESUME_DOOR,
  AGENT_WINDOW_RESUME_NOTE,
  agentStopReasonOf,
  completeAgentTask,
  pauseAgentTask,
  usageWindowPauseOf,
  createActivityDescriptionResolver,
  createAgentLedger,
  createProgressTracker,
  drainPendingMessages,
  enqueueAgentNotification,
  enqueueAgentReceiptRow,
  failAgentTask,
  foldResponseIntoLedger,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  publishAgentProgressSoon,
  publishAgentWaitFromEvent,
  type ProgressTracker,
  updateAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  findToolByName,
  toolMatchesName,
  type Tool,
  type Tools,
  type ToolUseContext,
} from '../../Tool.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import { flushSessionStorage } from '../../utils/sessionStorage.js'
import { recoveryBudgetMs, recoveryBudgetSpentFactsOf } from '../../services/api/recoveryBudget.js'
import { pauseResumeWords, type AgentPauseV1 } from '../../tasks/LocalAgentTask/agentPause.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import { isSyntheticApiErrorMessage } from '../../utils/messages/factories.js'
import { emitTaskProgress as emitSdkTaskProgress } from '../../utils/task/sdkProgress.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const EXIT_PLAN_MODE_NAME = 'ExitStrategyMode'
const MCP_TOOL_PREFIX = 'mcp__'


export function filterToolsForAgent(args: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
  const { tools, isBuiltIn, isAsync, permissionMode } = args
  const teammateKeeps =
    isInProcessTeammate() && isAgentSwarmsEnabled()
  return tools.filter(tool => {
    if (tool.name.startsWith(MCP_TOOL_PREFIX)) return true
    if (permissionMode === 'strategy' && tool.name === EXIT_PLAN_MODE_NAME) {
      return true
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (isAsync) {
      if (ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) return true
      if (
        teammateKeeps &&
        (tool.name === AGENT_TOOL_NAME ||
          IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name))
      ) {
        return true
      }
      return false
    }
    return true
  })
}

export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

export function resolveWorkerTools(
  definition: AgentDefinition,
  workerPermissionMode: NonNullable<AgentDefinition['permissionMode']>,
  pool: Tools,
  isAsync: boolean,
): Tools {
  return resolveAgentTools({ ...definition, permissionMode: workerPermissionMode }, pool, isAsync, false).resolvedTools
}

export function resolveAgentTools(
  definition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  const isBuiltIn = definition.source === 'built-in'
  const filtered = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn,
        isAsync,
        permissionMode: definition.permissionMode,
      })

  const deniedNames = new Set(
    (definition.disallowedTools ?? []).map(
      spec => permissionRuleValueFromString(spec).toolName,
    ),
  )
  const survivors = filtered.filter(
    tool => !deniedNames.has(tool.name),
  )

  const declared = definition.tools
  if (
    declared === undefined ||
    (declared.length === 1 && declared[0] === '*')
  ) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: survivors,
    }
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolvedTools: Tool[] = []
  const seenToolNames = new Set<string>()
  let allowedAgentTypes: string[] | undefined
  for (const spec of declared) {
    const rule = permissionRuleValueFromString(spec)
    const isAgentTypeSpec =
      rule.toolName === AGENT_TOOL_NAME && Boolean(rule.ruleContent)
    if (isAgentTypeSpec) {
      allowedAgentTypes = rule
        .ruleContent!.split(',')
        .map(entry => entry.trim())
        .filter(entry => entry !== '')
      validTools.push(spec)
      if (!isMainThread) {
        continue
      }
    }
    const found = survivors.find(tool => toolMatchesName(tool, rule.toolName))
    if (found) {
      if (!validTools.includes(spec)) validTools.push(spec)
      if (!seenToolNames.has(found.name)) {
        seenToolNames.add(found.name)
        resolvedTools.push(found)
      }
    } else if (!isAgentTypeSpec) {
      invalidTools.push(spec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools,
    ...(allowedAgentTypes ? { allowedAgentTypes } : {}),
  }
}


export type AgentTerminalOutcome =
  | { status: 'completed'; promotedNarration: boolean }
  | { status: 'failed'; reason: 'provider-declined' | 'schema-mismatch' | 'repetition-stop'; error: string }

export const REPETITION_STOP_WORDS = 'stopped by the repetition breaker'

function repetitionStopOf(messages: readonly Message[]): { cause: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'assistant') return null
    if (message.type === 'attachment' && message.attachment.type === 'repetition_breaker') {
      return { cause: message.attachment.cause }
    }
  }
  return null
}

const GENERIC_API_ERROR_PHRASE = 'API error'

export function getLastRealAssistantMessage(
  messages: readonly Message[],
): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'assistant') continue
    if (isSyntheticApiErrorMessage(message)) continue
    return message
  }
  return undefined
}

export function deriveAgentTerminalOutcome(
  messages: readonly Message[],
): AgentTerminalOutcome {
  const last = getLastAssistantMessage(messages as Message[])
  if (last && isSyntheticApiErrorMessage(last)) {
    const text = extractTextContent(last.message.content, '\n')
    return {
      status: 'failed',
      reason: 'provider-declined',
      error: text && text.trim() !== '' ? text : GENERIC_API_ERROR_PHRASE,
    }
  }
  const stop = repetitionStopOf(messages)
  if (stop !== null) return { status: 'failed', reason: 'repetition-stop', error: stop.cause }
  return { status: 'completed', promotedNarration: false }
}

export const PROMOTED_NARRATION_NOTE =
  '[The agent stopped part-way through a turn — what follows is its most recent narration, not a final report.]'


export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    outcome: z
      .discriminatedUnion('status', [
        z.object({
          status: z.literal('completed'),
          promotedNarration: z.boolean(),
        }),
        z.object({
          status: z.literal('failed'),
          reason: z.enum(['provider-declined', 'schema-mismatch', 'repetition-stop']),
          error: z.string(),
        }),
      ])
      .optional(),
    structured: z
      .object({
        data: z.unknown().optional(),
        error: z.string().optional(),
        source: z.enum(['dispatch', 'agent-definition']),
        mode: z.enum(['permissive', 'strict']),
      })
      .optional(),
    agentType: z.string().optional(),
    content: z.array(
      z.object({ type: z.literal('text'), text: z.string() }),
    ),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    costUSD: z.number().optional(),
    unpricedTurns: z.number().optional(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z
        .object({
          web_search_requests: z.number(),
          web_fetch_requests: z.number(),
        })
        .nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: z.number(),
          ephemeral_5m_input_tokens: z.number(),
        })
        .nullable(),
    }),
  }),
)

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

export function countToolUses(messages: readonly Message[]): number {
  let count = 0
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') count++
    }
  }
  return count
}

const EMPTY_USAGE: AgentToolResult['usage'] = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
  cache_creation: null,
}

function textBlocksOf(message: Message | undefined): { type: 'text'; text: string }[] {
  if (!message || message.type !== 'assistant') return []
  const content = message.message.content
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (block): block is Extract<typeof block, { type: 'text' }> =>
        block.type === 'text',
    )
    .map(block => ({ type: 'text' as const, text: block.text }))
}

export function finalizeAgentTool(
  messages: readonly Message[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
    structuredSpec?: { mode: 'permissive' | 'strict'; source: 'dispatch' | 'agent-definition' }
  },
): AgentToolResult {
  const { startTime, agentType } = metadata

  const lastAssistant = getLastAssistantMessage(messages as Message[])
  if (!lastAssistant) {
    throw new Error('No assistant message found in agent result')
  }
  const outcome = deriveAgentTerminalOutcome(messages)
  const lastReal = getLastRealAssistantMessage(messages)
  const anchor =
    outcome.status === 'failed' ? (lastReal ?? lastAssistant) : lastAssistant

  let content = textBlocksOf(
    outcome.status === 'failed' ? lastReal : anchor,
  ).filter(block => block.text.trim() !== '')

  let promotedNarration = false
  if (content.length === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!
      if (message.type !== 'assistant') continue
      if (isSyntheticApiErrorMessage(message)) continue
      const blocks = textBlocksOf(message).filter(
        block => block.text.trim() !== '',
      )
      if (blocks.length > 0) {
        content = blocks
        promotedNarration = true
        break
      }
    }
  }

  const finalOutcome: AgentTerminalOutcome =
    outcome.status === 'completed'
      ? { status: 'completed', promotedNarration }
      : outcome

  const usage =
    anchor.type === 'assistant'
      ? ({
          input_tokens: anchor.message.usage?.input_tokens ?? 0,
          output_tokens: anchor.message.usage?.output_tokens ?? 0,
          cache_creation_input_tokens:
            anchor.message.usage?.cache_creation_input_tokens ?? null,
          cache_read_input_tokens:
            anchor.message.usage?.cache_read_input_tokens ?? null,
          server_tool_use: anchor.message.usage?.server_tool_use ?? null,
          service_tier: anchor.message.usage?.service_tier ?? null,
          cache_creation: anchor.message.usage?.cache_creation ?? null,
        } as AgentToolResult['usage'])
      : EMPTY_USAGE

  const ledger = createAgentLedger()
  for (const message of messages) {
    if (message.type === 'assistant') foldResponseIntoLedger(ledger, message)
  }
  const totalTokens = ledger.inputTokens + ledger.outputTokens

  let structured: AgentToolResult['structured']
  let structuredOutcome: AgentTerminalOutcome | undefined
  if (metadata.structuredSpec !== undefined) {
    const { mode, source } = metadata.structuredSpec
    const found = findLastStructuredYield(messages)
    if (found?.valid === true) {
      structured = { data: found.payload, source, mode }
    } else {
      const error =
        found === null
          ? `no structured yield: the agent never called ${structuredOutputToolName()} with a conforming payload`
          : `the last ${structuredOutputToolName()} call failed schema validation`
      structured = { error, source, mode }
      if (mode === 'strict' && finalOutcome.status === 'completed') {
        structuredOutcome = { status: 'failed', reason: 'schema-mismatch', error }
      }
    }
  }

  return {
    agentId,
    agentType,
    outcome: structuredOutcome ?? finalOutcome,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    costUSD: ledger.costUSD,
    unpricedTurns: ledger.unpricedTurns,
    totalToolUseCount: countToolUses(messages),
    usage,
    ...(structured !== undefined ? { structured } : {}),
  }
}

function structuredOutputToolName(): string {
  return 'StructuredOutput'
}

function findLastStructuredYield(
  messages: readonly Message[],
): { valid: boolean; payload?: unknown } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const contentBlocks = Array.isArray(m.message.content) ? m.message.content : []
    for (const block of contentBlocks) {
      const use = block as { type?: string; id?: string; name?: string; input?: unknown }
      if (use.type !== 'tool_use' || use.name !== structuredOutputToolName() || !use.id) continue
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j]!
        if (candidate.type !== 'user') continue
        const rc = candidate.message.content
        if (!Array.isArray(rc)) continue
        const result = (rc as Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>).find(
          b => b.type === 'tool_result' && b.tool_use_id === use.id,
        )
        if (result !== undefined) {
          return result.is_error === true ? { valid: false } : { valid: true, payload: use.input }
        }
      }
      return { valid: false }
    }
  }
  return null
}

export function getLastToolUseName(message: Message): string | undefined {
  if (message.type !== 'assistant') return undefined
  const content = message.message.content
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]!
    if (block.type === 'tool_use') return block.name
  }
  return undefined
}

export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  const progress = getProgressUpdate(tracker)
  emitSdkTaskProgress({
    taskId,
    toolUseId,
    description:
      progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: getTokenCountFromTracker(tracker),
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

const WRITE_TOOL_NAMES = new Set([FILE_WRITE_TOOL_NAME, FILE_EDIT_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME])

export function landedWritesOf(messages: readonly Message[]): string[] {
  const pending = new Map<string, string>()
  const landed: string[] = []
  for (const message of messages) {
    if (message.type === 'assistant') {
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_use' || !WRITE_TOOL_NAMES.has(block.name)) continue
        const input = (block.input ?? {}) as { file_path?: unknown; notebook_path?: unknown }
        const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
        if (path !== undefined) pending.set(block.id, path)
      }
      continue
    }
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const path = pending.get(block.tool_use_id)
      if (path === undefined) continue
      pending.delete(block.tool_use_id)
      if (block.is_error !== true && !landed.includes(path)) landed.push(path)
    }
  }
  return landed
}

export function extractPartialResult(
  messages: readonly Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'assistant') continue
    const text = extractTextContent(message.message.content, '\n')
    if (text && text.trim() !== '') return text
  }
  return undefined
}

export async function partialResultEnvelopeBlock(args: {
  agentId: string
  agentType: string
  status: 'failed' | 'stopped'
  partialText: string | undefined
  usage: { totalTokens: number; toolUseCount: number; durationMs: number }
}): Promise<string | undefined> {
  try {
    const { buildAgentResultEnvelope, formatEnvelopeBlock } = await import(
      '../../services/agentResults/normalize.js'
    )
    return formatEnvelopeBlock(
      await buildAgentResultEnvelope({
        agentId: args.agentId,
        agentType: args.agentType,
        status: args.status,
        finalText: args.partialText ?? '',
        usage: args.usage,
      }),
    )
  } catch {
    return undefined
  }
}


export function recoveryBudgetCutOf(error: unknown): { words: string; resumeAfterMs: number } | null {
  const facts = recoveryBudgetSpentFactsOf(error)
  return facts === null ? null : { words: facts.words, resumeAfterMs: facts.resumeAfterMs }
}

const RESUME_AFTER_CUT_FLOOR_MS = 1_000

export function budgetCutResumeDelayMs(cut: { resumeAfterMs: number }): number {
  return Math.max(RESUME_AFTER_CUT_FLOOR_MS, cut.resumeAfterMs)
}

const pendingAutomaticResumes = new Map<string, ReturnType<typeof setTimeout>>()
const cutsAlreadyResumed = new WeakSet<AbortController>()

export function automaticResumePending(taskId: string): boolean {
  return pendingAutomaticResumes.has(taskId)
}

export function cancelAutomaticResume(taskId: string): boolean {
  const timer = pendingAutomaticResumes.get(taskId)
  if (timer === undefined) return false
  clearTimeout(timer)
  pendingAutomaticResumes.delete(taskId)
  return true
}

export function armBudgetCutResume(args: {
  taskId: string
  description: string
  registration: AbortController
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  canUseTool?: CanUseToolFn
  invokingRequestId?: string
  delayMs?: number
  automaticResume?: boolean
  pause?: AgentPauseV1
  prompt?: string
  summary?: string
  resume?: (resumeArgs: {
    agentId: string
    prompt: string
    toolUseContext: ToolUseContext
    canUseTool?: CanUseToolFn
    invokingRequestId?: string
    automatic: true
  }) => Promise<unknown>
}): ReturnType<typeof setTimeout> | null {
  if (args.automaticResume === true) return null
  if (pendingAutomaticResumes.has(args.taskId)) return null
  if (cutsAlreadyResumed.has(args.registration)) return null
  if (args.pause !== undefined) pauseAgentTask(args.taskId, args.pause, args.rootSetAppState, args.registration)
  const fire = async (): Promise<void> => {
    pendingAutomaticResumes.delete(args.taskId)
    cutsAlreadyResumed.add(args.registration)
    let tasksNow: Record<string, unknown> | undefined
    args.rootSetAppState(prev => {
      tasksNow = prev.tasks
      return prev
    })
    const row = tasksNow?.[args.taskId]
    if (!isLocalAgentTask(row) || row.status !== 'failed' || row.registration !== args.registration) return
    const { liveAgentOwner, resumeAgentBackground } = await import('./resumeAgent.js')
    if (liveAgentOwner(args.taskId, tasksNow) !== null) return
    const resume = args.resume ?? (resumeAgentBackground as unknown as NonNullable<typeof args.resume>)
    try {
      await resume({
        agentId: args.taskId,
        prompt: args.prompt ?? AGENT_BUDGET_RESUME_NOTE,
        toolUseContext: args.toolUseContext,
        canUseTool: args.canUseTool,
        invokingRequestId: args.invokingRequestId,
        automatic: true,
      })
    } catch (error) {
      logForDebugging(`agent lifecycle: the automatic resume of ${args.taskId} did not start: ${errorMessage(error)}`)
      return
    }
    enqueueAgentReceiptRow({
      taskId: args.taskId,
      description: args.description,
      summary:
        args.summary ??
        `Agent "${args.description}" resumed by itself — the recovery budget's allowance is back after it was spent waiting on the provider; its partial work carried forward`,
    })
  }
  const timer = setTimeout(() => {
    void fire()
  }, args.delayMs ?? recoveryBudgetMs())
  timer.unref?.()
  pendingAutomaticResumes.set(args.taskId, timer)
  return timer
}


export async function runAsyncAgentLifecycle(args: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams?: (params: CacheSafeParams) => void,
    onQueryProgress?: (event: unknown) => void,
  ) => AsyncGenerator<Message, void>
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
    structuredSpec?: { mode: 'permissive' | 'strict'; source: 'dispatch' | 'agent-definition' }
  }
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  automaticResume?: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
  canUseTool?: CanUseToolFn
}): Promise<void> {
  const {
    taskId,
    makeStream,
    metadata,
    description,
    toolUseContext,
    rootSetAppState,
    agentIdForCleanup,
    enableSummarization,
    getWorktreeResult,
  } = args

  const tracker = createProgressTracker()
  const resolveActivity = createActivityDescriptionResolver(
    toolUseContext.options.tools,
  )
  const accumulated: Message[] = []
  let stopSummarization: (() => void) | undefined

  try {
    const stream = makeStream(
      enableSummarization
        ? params => {
            void (async () => {
              try {
                const { startAgentSummarization } = await import(
                  '../../services/AgentSummary/agentSummary.js'
                )
                const { stop } = startAgentSummarization(
                  taskId,
                  taskId,
                  params as never,
                  rootSetAppState,
                )
                stopSummarization = stop
              } catch (error) {
                logForDebugging(
                  `agent lifecycle: summarization start failed: ${errorMessage(error)}`,
                )
              }
            })()
          }
        : undefined,
      event => publishAgentWaitFromEvent(taskId, tracker, event, rootSetAppState),
    )

    for await (const message of stream) {
      accumulated.push(message)
      let retaining = false
      rootSetAppState(prev => {
        const task = prev.tasks[taskId]
        retaining = isLocalAgentTask(task) && task.retain === true
        return prev
      })
      if (retaining) {
        const { appendMessageToLocalAgent } = await import(
          '../../tasks/LocalAgentTask/LocalAgentTask.js'
        )
        appendMessageToLocalAgent(taskId, message, rootSetAppState)
      }
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      publishAgentProgressSoon(taskId, tracker, rootSetAppState)
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    stopSummarization?.()
    const result = finalizeAgentTool(accumulated, taskId, metadata)
    const declined =
      result.outcome?.status === 'failed' ? result.outcome : undefined

    const windowPause = declined ? usageWindowPauseOf(accumulated, metadata.resolvedAgentModel) : null
    if (declined) {
      failAgentTask(taskId, declined.error, rootSetAppState, args.abortController)
      if (windowPause !== null) {
        if (windowPause.resumesAtMs !== undefined && !args.automaticResume) {
          armBudgetCutResume({
            taskId,
            description,
            registration: args.abortController,
            toolUseContext,
            rootSetAppState,
            canUseTool: args.canUseTool,
            delayMs: Math.max(RESUME_AFTER_CUT_FLOOR_MS, windowPause.resumesAtMs - Date.now() + RESUME_AFTER_CUT_FLOOR_MS),
            pause: windowPause,
            prompt: AGENT_WINDOW_RESUME_NOTE,
            summary: `Agent "${description}" resumed by itself — the usage window reset; its partial work carried forward`,
          })
        } else {
          pauseAgentTask(taskId, windowPause, rootSetAppState, args.abortController)
        }
      }
    } else {
      completeAgentTask(result as { agentId: string }, rootSetAppState, args.abortController)
      try {
        const stateReader =
          toolUseContext.getAppState ??
          ((): ReturnType<NonNullable<ToolUseContext['getAppState']>> => {
            let captured: unknown
            rootSetAppState(prev => {
              captured = prev
              return prev
            })
            return captured as ReturnType<
              NonNullable<ToolUseContext['getAppState']>
            >
          })
        const queued = (() => {
          const state = stateReader()
          const task = state.tasks[taskId]
          return isLocalAgentTask(task) ? (task.pendingMessages ?? []) : []
        })()
        if (queued.length > 0) {
          const { resumeAgentBackground } = await import('./resumeAgent.js')
          await resumeAgentBackground({
            agentId: taskId,
            prompt: queued.join('\n\n'),
            toolUseContext,
            canUseTool: args.canUseTool,
          })
          drainPendingMessages(taskId, stateReader, rootSetAppState)
        }
      } catch (error) {
        logForDebugging(
          `agent lifecycle: queued-guidance drain failed: ${errorMessage(error)}`,
        )
      }
    }

    let finalMessage = extractTextContent(result.content, '\n')
    if (
      result.outcome?.status === 'completed' &&
      result.outcome.promotedNarration &&
      finalMessage
    ) {
      finalMessage = `${PROMOTED_NARRATION_NOTE}\n${finalMessage}`
    }

    const worktreeResult = await getWorktreeResult()

    let envelopeBlock: string | undefined
    try {
      const { buildAgentResultEnvelope, formatEnvelopeBlock } = await import(
        '../../services/agentResults/normalize.js'
      )
      envelopeBlock = formatEnvelopeBlock(
        await buildAgentResultEnvelope({
          agentId: String(taskId),
          agentType: metadata.agentType,
          status: declined ? 'failed' : 'completed',
          finalText: finalMessage ?? '',
          usage: {
            totalTokens: getTokenCountFromTracker(tracker),
            toolUseCount: result.totalToolUseCount,
            durationMs: result.totalDurationMs,
          },
        }),
      )
    } catch {
    }

    enqueueAgentNotification({
      taskId,
      description,
      status: declined ? 'failed' : 'completed',
      ...(declined ? { error: declined.error, landedWrites: landedWritesOf(accumulated) } : {}),
      ...(windowPause !== null
        ? {
            summary: `Agent "${description}" paused — ${windowPause.words}; ${pauseResumeWords(windowPause, Date.now())} — its work so far is kept and rides below; ${AGENT_RESUME_DOOR}`,
          }
        : {}),
      setAppState: rootSetAppState,
      controller: args.abortController,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: result.totalToolUseCount,
        durationMs: result.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
      ...(envelopeBlock ? { envelopeBlock } : {}),
    })
  } catch (error) {
    if (error instanceof AbortError) {
      stopSummarization?.()
      const stopReason = agentStopReasonOf(args.abortController.signal.reason)
      killAsyncAgent(taskId, rootSetAppState, stopReason, args.abortController)
      const worktreeResult = await getWorktreeResult()
      await flushSessionStorage()
      const partialResult = extractPartialResult(accumulated)
      const usage = {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: tracker.toolUseCount,
        durationMs: Date.now() - metadata.startTime,
      }
      const envelopeBlock = await partialResultEnvelopeBlock({
        agentId: String(taskId),
        agentType: metadata.agentType,
        status: 'stopped',
        partialText: partialResult,
        usage: { totalTokens: usage.totalTokens, toolUseCount: usage.toolUses, durationMs: usage.durationMs },
      })
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        controller: args.abortController,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        usage,
        landedWrites: landedWritesOf(accumulated),
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...worktreeResult,
        ...(envelopeBlock ? { envelopeBlock } : {}),
      })
      return
    }
    stopSummarization?.()
    const errMsg = errorMessage(error)
    failAgentTask(taskId, errMsg, rootSetAppState, args.abortController)
    const worktreeResult = await getWorktreeResult()
    await flushSessionStorage()
    const partialResult = extractPartialResult(accumulated)
    const usage = {
      totalTokens: getTokenCountFromTracker(tracker),
      toolUses: tracker.toolUseCount,
      durationMs: Date.now() - metadata.startTime,
    }
    const envelopeBlock = await partialResultEnvelopeBlock({
      agentId: String(taskId),
      agentType: metadata.agentType,
      status: 'failed',
      partialText: partialResult,
      usage: { totalTokens: usage.totalTokens, toolUseCount: usage.toolUses, durationMs: usage.durationMs },
    })
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: errMsg,
      finalMessage: partialResult,
      usage,
      landedWrites: landedWritesOf(accumulated),
      setAppState: rootSetAppState,
      controller: args.abortController,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
      ...(envelopeBlock ? { envelopeBlock } : {}),
    })
    const budgetCut = recoveryBudgetCutOf(error)
    if (budgetCut !== null && !args.automaticResume) {
      const delayMs = budgetCutResumeDelayMs(budgetCut)
      armBudgetCutResume({
        taskId,
        description,
        registration: args.abortController,
        toolUseContext,
        rootSetAppState,
        canUseTool: args.canUseTool,
        delayMs,
        pause: { why: 'provider busy', words: budgetCut.words, resumesAtMs: Date.now() + delayMs },
      })
    }
  } finally {
    stopSummarization?.()
    try {
      const { clearInvokedSkillsForAgent } = await import(
        '../../bootstrap/state.js'
      )
      clearInvokedSkillsForAgent(agentIdForCleanup as never)
    } catch (error) {
      logForDebugging(
        `agent lifecycle: final cleanup failed: ${errorMessage(error)}`,
      )
    }
  }
}

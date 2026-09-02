// Tool filtering/resolution for agents, the ONE typed terminal outcome,
// result finalization, and the background-agent lifecycle driver
//
//
// Mercury layers: the terminal-outcome type (every surface reads the same
// law), the promoted-narration label, the structured result envelope, and
// the completion-time drain of queued guidance.
//
// STRUCTURAL RULING: the shared result schema
// below is lazily built (lazySchema) and must never be read at module
// evaluation time — this module sits on an import cycle with the tool pool
// and two landed rewrites tripped the TDZ by changing import order.

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
  completeAgentTask,
  createActivityDescriptionResolver,
  createProgressTracker,
  drainPendingMessages,
  enqueueAgentNotification,
  failAgentTask,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  updateAgentProgress,
  updateProgressFromMessage,
  type ProgressTracker,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  findToolByName,
  toolMatchesName,
  type Tool,
  type Tools,
  type ToolUseContext,
} from '../../Tool.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
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

// Wire names referenced structurally here (probe-verified spellings; the
// modules that export them are heavier than these two literals warrant).
const EXIT_PLAN_MODE_NAME = 'ExitPlanMode'
const MCP_TOOL_PREFIX = 'mcp__'

// ── Per-agent tool filtering ────────────────────────────────────────

/**
 * Filter the candidate pool for an agent context: MCP tools always pass;
 * the plan-exit tool passes for a plan-mode agent (overriding both denial
 * lists); the all-agents denial set drops; custom definitions additionally
 * drop the custom-agent denial set; async runs keep only the async
 * allow-set — except an in-process teammate (teams enabled) also keeps the
 * Agent tool and the task-coordination set.
 */
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

/**
 * Resolve a definition's declared tools against a pool. Main-thread
 * callers skip the agent filter (their pool is already correct); the denial
 * set removes by bare tool name; `tools` undefined or exactly `['*']` means
 * everything that survived; an `Agent(a,b)` spec yields allowedAgentTypes.
 */
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

  // Denial set: each disallowed spec parses down to its bare tool name.
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
        // The agent filter already removed the Agent tool for this run —
        // the spec is valid but the tool itself is not resolved.
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

// ── The typed terminal outcome ──────────────────────────────────────

export type AgentTerminalOutcome =
  | { status: 'completed'; promotedNarration: boolean }
  | { status: 'failed'; reason: 'provider-declined' | 'schema-mismatch'; error: string }

/** A short generic phrase when a fabricated error message carries no text. */
const GENERIC_API_ERROR_PHRASE = 'API error'

/** The last assistant message that is NOT a locally fabricated
 *  provider-error message. */
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

/**
 * The ONE derivation of how an agent execution ended. A locally fabricated
 * API-error tail is a FAILURE — that text is not agent output.
 */
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
  return { status: 'completed', promotedNarration: false }
}

/** The shared label marking promoted narration wherever it is surfaced. */
export const PROMOTED_NARRATION_NOTE =
  '[The agent stopped part-way through a turn — what follows is its most recent narration, not a final report.]'

// ── The result record ─────────────────────────────────────────────────

/** Lazily built (STRUCTURAL RULING): never read at module evaluation. */
export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    /** Optional: older persisted sessions replay results without it. */
    outcome: z
      .discriminatedUnion('status', [
        z.object({
          status: z.literal('completed'),
          promotedNarration: z.boolean(),
        }),
        z.object({
          status: z.literal('failed'),
          reason: z.enum(['provider-declined', 'schema-mismatch']),
          error: z.string(),
        }),
      ])
      .optional(),
    /** Structured output (spec 03-C1): present iff the dispatch carried a
     *  schema — parsed data on a conforming yield, the typed miss
     *  otherwise. */
    structured: z
      .object({
        data: z.unknown().optional(),
        error: z.string().optional(),
        source: z.enum(['dispatch', 'agent-definition']),
        mode: z.enum(['permissive', 'strict']),
      })
      .optional(),
    /** Optional for the same replay reason; gates the one-shot trailer. */
    agentType: z.string().optional(),
    content: z.array(
      z.object({ type: z.literal('text'), text: z.string() }),
    ),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
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

/** Tool-use blocks counted across ALL assistant messages. */
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

/**
 * Finalize an agent execution into the result record. Throws when
 * no assistant message exists at all. On a failed outcome, usage and
 * request identity anchor on the last REAL assistant message (falling back
 * to the tail so metadata is never fabricated) and genuine model output is
 * the only permitted content source — a decline with no prior real output
 * yields EMPTY content, never the decline text. Empty content walks back to
 * the newest genuine assistant text; a promotion on a completed outcome
 * sets promotedNarration.
 */
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
  // The dead metadata fields (prompt, resolvedAgentModel, isBuiltInAgent,
  // isAsync) are emptied telemetry seams — the parameter shape
  // is the contract; nothing here reads them.
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
    // Walk backwards to the newest GENUINE assistant text (skipping
    // fabricated error messages on the way).
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

  const totalTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)

  // Structured capture (spec 03-C1): the last schema-bound finalization
  // round decides. A validated call's INPUT is the parsed payload (the
  // bound tool accepted it); an errored round or absence records the miss
  // — strict marks the run failed, permissive keeps the prose beside the
  // recorded error.
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
    totalToolUseCount: countToolUses(messages),
    usage,
    ...(structured !== undefined ? { structured } : {}),
  }
}

/** The finalization tool's wire name, read lazily (the workflow module's
 *  constant; a direct import would land in the tools.ts TDZ cycle). */
function structuredOutputToolName(): string {
  return 'StructuredOutput'
}

/** The LAST schema-bound finalization round in the transcript: the call's
 *  input is the payload when its result settled non-error. */
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
      // Find the settled result in a following user message.
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
      return { valid: false } // called but never settled
    }
  }
  return null
}

/** The name of the last tool_use block in a message, if any. */
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

/** SDK task-progress emission from a tracker's running totals. */
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

/**
 * The most recent assistant message carrying any text — deliberately NOT
 * skipping fabricated error messages (abort): a killed agent's
 * partial can be a provider decline.
 */
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

// ── The background agent lifecycle ─────────────────────────────────

/** ONE driver for "async from the start" and "resumed in the background". */
export async function runAsyncAgentLifecycle(args: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams?: (params: CacheSafeParams) => void,
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
    )

    for await (const message of stream) {
      accumulated.push(message)
      // When the UI retains this task, append to the retained list — safe
      // because each message is persisted before it is yielded, so the live
      // tail only extends what a bootstrap read from disk. The retain flag
      // is read through the ROOT setter (a no-op updater capture): the
      // tool-use context may carry no app-state accessor at all, and the
      // root tasks setter applies updaters synchronously.
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
      updateAgentProgress(taskId, getProgressUpdate(tracker), rootSetAppState)
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

    // Settle FIRST, embellish after: the terminal transition precedes
    // anything that can hang, so a blocking output reader unblocks now.
    if (declined) {
      failAgentTask(taskId, declined.error, rootSetAppState)
    } else {
      completeAgentTask(result as { agentId: string }, rootSetAppState)
      // Drain, never drop: guidance queued while the turn ran is delivered
      // by resuming the same agent in the background. Failures log only.
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
        // Drain, never drop: PEEK the queue first, deliver by resuming the
        // same agent, and only a launched delivery clears the queue — a
        // failed launch leaves the guidance queued rather than lost.
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

    // The structured result envelope — construction must never break the
    // completion (swallowed).
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
            // The token figure is the TRACKER's running total, not the
            // finalized result's anchor-derived total — the two can
            // differ and the notification reports the tracker's.
            totalTokens: getTokenCountFromTracker(tracker),
            toolUseCount: result.totalToolUseCount,
            durationMs: result.totalDurationMs,
          },
        }),
      )
    } catch {
      /* envelope construction must never break completion */
    }

    enqueueAgentNotification({
      taskId,
      description,
      status: declined ? 'failed' : 'completed',
      ...(declined ? { error: declined.error } : {}),
      setAppState: rootSetAppState,
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
      // Mark killed FIRST (no-op if an explicit stop already did), then
      // fetch the worktree result. The kill notification fires
      // unconditionally from here — only this path holds the messages.
      killAsyncAgent(taskId, rootSetAppState)
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(accumulated)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        ...worktreeResult,
      })
      return
    }
    stopSummarization?.()
    const errMsg = errorMessage(error)
    failAgentTask(taskId, errMsg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: errMsg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } finally {
    stopSummarization?.()
    // Clear the agent's invoked-skills record and prompt-dump state.
    try {
      const { clearInvokedSkillsForAgent } = await import(
        '../../bootstrap/state.js'
      )
      clearInvokedSkillsForAgent(agentIdForCleanup as never)
      const { clearDumpState } = await import(
        '../../services/api/dumpPrompts.js'
      )
      clearDumpState(agentIdForCleanup)
    } catch (error) {
      logForDebugging(
        `agent lifecycle: final cleanup failed: ${errorMessage(error)}`,
      )
    }
  }
}

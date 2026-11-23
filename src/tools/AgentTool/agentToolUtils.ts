import { z } from 'zod'
import { evalNestedToolIds } from '../../services/eval/bridgeProgress.js'
import { expandLspFamily, lspFamilyMatches } from '../../utils/lsp/toolFamily.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  RULE_INHERITS,
} from '../../constants/tools.js'
import type { Message } from '../../types/message.js'
import type { SetAppState } from '../../Task.js'
import {
  AGENT_BUDGET_RESUME_NOTE,
  AGENT_RESUME_DOOR,
  AGENT_WINDOW_RESUME_NOTE,
  agentStopReasonOf,
  agentStopStatusWordOf,
  appendMessageToLocalAgent,
  completeAgentTask,
  overloadPauseOf,
  pauseAgentTask,
  unpauseAgentTask,
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
  peekOperatorMessages,
  publishAgentProgressSoon,
  publishAgentWaitFromEvent,
  type ProgressTracker,
  takeOperatorMessages,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  toolMatchesName,
  type Tool,
  type Tools,
  type ToolUseContext,
} from '../../Tool.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import { flushSessionStorage } from '../../utils/sessionStorage.js'
import { recoveryBudgetMs, recoveryBudgetSpentFactsOf } from '../../services/api/recoveryBudget.js'
import { getMarketingNameForModel } from '../../services/model/model.js'
import { clearInvokedSkillsForAgent, getCwdState } from '../../bootstrap/state.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { pauseResumeWords, type AgentPauseV1 } from '../../tasks/LocalAgentTask/agentPause.js'
import { agentPauseRecordPath, clearAgentPauseRecord, writeAgentPauseRecord } from '../../tasks/LocalAgentTask/pauseCarry.js'
import { CREW_ACCOUNT_RESUME_NOTE, crewAccountResumeSummary, subscribeCrewAccountChange } from '../../services/crew/crewAccountChange.js'
import {
  AGENT_OVERLOAD_RESUME_NOTE,
  nextOverloadProbeDelayMs,
  noteOverloadDeath,
  openOverloadEpisode,
  overloadDeathNotifies,
  overloadNoticeWords,
  overloadPauseWords,
  overloadProbeRequestMs,
  type OverloadEpisode,
} from '../../tasks/LocalAgentTask/agentOverload.js'
import { createUserMessage } from '../../services/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { CacheSafeParams } from '../../services/agents/forkedAgent.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools/fileEdit.js'
import { FILE_WRITE_TOOL_NAME } from '../../constants/tools/fileWrite.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import { JEV_TOOL_NAME } from '../../services/jev/jevContract.js'
import { readJevSettings } from '../../services/jev/jevSetting.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../services/messages.js'
import { isSyntheticApiErrorMessage } from '../../utils/messages/factories.js'
import { emitTaskProgress as emitSdkTaskProgress } from '../../utils/task/sdkProgress.js'
import { emitBackgroundAgentRows } from '../../utils/task/sdkAgentFrames.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import type { CanUseToolFn } from '../../Tool.js'
import { AGENT_TOOL_NAME, MERCURY_SCOUT_AGENT_TYPE } from '../../constants/tools/agent.js'
import { STRUCTURED_TAG } from '../../constants/xml.js'
import type { AgentDefinition } from '../../types/agent.js'
import { passedOver } from '../../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'

const MCP_TOOL_PREFIX = 'mcp__'


export function filterToolsForAgent(args: {
  tools: Tools
  isBuiltIn: boolean
}): Tools {
  const { tools, isBuiltIn } = args
  const jevAllowed = readJevSettings().subagents
  return tools.filter(tool => {
    if (tool.name.startsWith(MCP_TOOL_PREFIX)) return true
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    if (tool.name === JEV_TOOL_NAME && !jevAllowed) return false
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    return true
  })
}

export type ResolvedAgentTools = {
  hasWildcard: boolean
  readOnly?: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

export function resolveWorkerTools(
  definition: AgentDefinition,
  workerPermissionMode: NonNullable<AgentDefinition['permissionMode']>,
  pool: Tools,
): Tools {
  return resolveAgentTools({ ...definition, permissionMode: workerPermissionMode }, pool, false).resolvedTools
}

export function resolveAgentTools(
  definition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  > & { agentType?: string },
  availableTools: Tools,
  isMainThread?: boolean,
): ResolvedAgentTools {
  const basePool = isMainThread
    ? availableTools
    : filterToolsForAgent({ tools: availableTools, isBuiltIn: definition.source === 'built-in' })

  const deniedNames = new Set<string>()
  for (const entry of definition.disallowedTools ?? []) {
    const parsed = permissionRuleValueFromString(entry)
    if (parsed.ruleContent !== undefined) continue
    for (const expanded of expandLspFamily(parsed.toolName)) deniedNames.add(expanded)
  }

  const isToolDenied = (tool: Tool): boolean => {
    for (const name of deniedNames) if (toolMatchesName(tool, name)) return true
    const inheritedFrom = RULE_INHERITS[tool.name]
    if (inheritedFrom !== undefined) {
      for (const parent of inheritedFrom) if (deniedNames.has(parent)) return true
    }
    return false
  }

  const surviving = deniedNames.size > 0 ? basePool.filter(tool => !isToolDenied(tool)) : [...basePool]
  const readOnlyField =
    definition.source === 'built-in' && definition.agentType === MERCURY_SCOUT_AGENT_TYPE
      ? { readOnly: true as const }
      : {}

  const declared = definition.tools
  if (declared === undefined || (declared.length === 1 && declared[0] === '*')) {
    return { hasWildcard: true, ...readOnlyField, validTools: [], invalidTools: [], resolvedTools: surviving }
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolvedTools: Tool[] = []
  const seenNames = new Set<string>()
  let allowedAgentTypes: string[] | undefined
  const addResolved = (tool: Tool): void => {
    if (!seenNames.has(tool.name)) {
      seenNames.add(tool.name)
      resolvedTools.push(tool)
    }
  }

  for (const spec of declared) {
    const parsed = permissionRuleValueFromString(spec)
    const isUnqualified = parsed.ruleContent === undefined
    if (parsed.toolName === AGENT_TOOL_NAME && !isUnqualified) {
      allowedAgentTypes = parsed.ruleContent!.split(',').map(part => part.trim()).filter(part => part.length > 0)
      validTools.push(spec)
      if (isMainThread) {
        const agentTool = surviving.find(tool => toolMatchesName(tool, AGENT_TOOL_NAME))
        if (agentTool) addResolved(agentTool)
      }
      continue
    }

    let matched = false
    let directName: string | undefined
    if (isUnqualified) {
      const lspMatches = surviving.filter(tool => lspFamilyMatches(parsed.toolName, tool.name))
      if (lspMatches.length > 0) {
        matched = true
        for (const tool of lspMatches) addResolved(tool)
      }
    }
    if (!matched) {
      const direct = surviving.find(tool => toolMatchesName(tool, parsed.toolName))
      if (direct) {
        matched = true
        directName = direct.name
        addResolved(direct)
      }
    }
    if (isUnqualified) {
      for (const tool of surviving) {
        const inheritedFrom = RULE_INHERITS[tool.name]
        if (inheritedFrom !== undefined && (inheritedFrom.includes(parsed.toolName) || (directName !== undefined && inheritedFrom.includes(directName)))) {
          matched = true
          addResolved(tool)
        }
      }
    }
    if (matched) {
      if (!validTools.includes(spec)) validTools.push(spec)
    } else {
      invalidTools.push(spec)
    }
  }

  return {
    hasWildcard: false,
    ...readOnlyField,
    validTools,
    invalidTools,
    resolvedTools,
    ...(allowedAgentTypes !== undefined ? { allowedAgentTypes } : {}),
  }
}


export type AgentTerminalOutcome =
  | { status: 'completed'; promotedNarration: boolean }
  | { status: 'failed'; reason: 'provider-declined' | 'schema-mismatch' | 'loop-stopped'; error: string }

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

export function loopStoppedRecordOf(
  messages: readonly Message[],
): { cycle: string[]; message: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'assistant') return null
    if (message.type === 'attachment' && message.attachment.type === 'loop_stopped') {
      return { cycle: message.attachment.cycle, message: message.attachment.message }
    }
  }
  return null
}

export function deriveAgentTerminalOutcome(
  messages: readonly Message[],
): AgentTerminalOutcome {
  const stopped = loopStoppedRecordOf(messages)
  if (stopped !== null) {
    return { status: 'failed', reason: 'loop-stopped', error: stopped.message }
  }
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

export const PROMOTED_NARRATION_NOTE =
  '[The crewmate stopped part-way through a turn — what follows is its most recent narration, not a final report.]'

const SETTLED_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence'])

export function finalResponseOf(messages: readonly Message[]): { messages: Message[]; stopReason: string | null } {
  const run: Message[] = []
  let stopReason: string | null = null
  let id: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'assistant') {
      if (run.length > 0) break
      continue
    }
    const messageId = typeof message.message.id === 'string' && message.message.id !== '' ? message.message.id : undefined
    if (run.length > 0 && (id === undefined || messageId !== id)) break
    id = messageId
    run.unshift(message)
    if (stopReason === null && typeof message.message.stop_reason === 'string') stopReason = message.message.stop_reason
    if (messageId === undefined) break
  }
  return { messages: run, stopReason }
}

export function stoppedPartWay(response: { messages: readonly Message[]; stopReason: string | null }): boolean {
  if (response.stopReason === null || !SETTLED_STOP_REASONS.has(response.stopReason)) return true
  return response.messages.some(
    message => message.type === 'assistant' && Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'tool_use'),
  )
}


export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    outcome: z
      .discriminatedUnion('status', [
        z.object({ status: z.literal('completed'), promotedNarration: z.boolean() }),
        z.object({ status: z.literal('failed'), reason: z.enum(['provider-declined', 'schema-mismatch', 'loop-stopped']), error: z.string() }),
      ])
      .optional(),
    structured: z
      .object({ data: z.unknown().optional(), error: z.string().optional(), source: z.enum(['dispatch', 'agent-definition']), mode: z.enum(['permissive', 'strict']) })
      .optional(),
    agentType: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
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
      server_tool_use: z.object({ web_search_requests: z.number(), web_fetch_requests: z.number() }).nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z.object({ ephemeral_1h_input_tokens: z.number(), ephemeral_5m_input_tokens: z.number() }).nullable(),
    }),
  }),
)

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

export function countToolUses(messages: readonly Message[]): number {
  let count = 0
  const nestedIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') count++
      }
    }
    for (const id of evalNestedToolIds(message)) {
      nestedIds.add(id)
    }
  }
  return count + nestedIds.size
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
  terminalFailure?: Extract<AgentTerminalOutcome, { status: 'failed' }>,
): AgentToolResult {
  const { startTime, agentType } = metadata

  const lastAssistant = getLastAssistantMessage(messages as Message[])
  if (!lastAssistant && terminalFailure === undefined) {
    throw new Error('No assistant message found in crewmate result')
  }
  const outcome = terminalFailure ?? deriveAgentTerminalOutcome(messages)
  const lastReal = getLastRealAssistantMessage(messages)
  const anchor =
    outcome.status === 'failed' ? (lastReal ?? lastAssistant) : lastAssistant
  const chantStopped =
    outcome.status === 'failed' &&
    outcome.reason === 'loop-stopped' &&
    (loopStoppedRecordOf(messages)?.cycle ?? []).join() === 'reply'

  const finalResponse = outcome.status === 'completed' ? finalResponseOf(messages) : null
  let content = chantStopped
    ? []
    : finalResponse !== null
      ? finalResponse.messages.flatMap(message => textBlocksOf(message)).filter(block => block.text.trim() !== '')
      : textBlocksOf(
          outcome.status === 'failed' ? lastReal : anchor,
        ).filter(block => block.text.trim() !== '')

  let promotedNarration = false
  if (content.length === 0 && !chantStopped) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!
      if (message.type !== 'assistant') continue
      if (isSyntheticApiErrorMessage(message)) continue
      const blocks = textBlocksOf(message).filter(
        block => block.text.trim() !== '',
      )
      if (blocks.length > 0) {
        content = blocks
        promotedNarration = finalResponse === null || stoppedPartWay(finalResponse)
        break
      }
    }
  }

  const finalOutcome: AgentTerminalOutcome =
    outcome.status === 'completed'
      ? { status: 'completed', promotedNarration }
      : outcome

  const usage =
    anchor?.type === 'assistant'
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
          ? NO_STRUCTURED_YIELD
          : found.issues === undefined
            ? FAILED_STRUCTURED_YIELD
            : `${FAILED_STRUCTURED_YIELD}: ${found.issues}`
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

export const NO_STRUCTURED_YIELD = `no structured yield: the crewmate never called ${structuredOutputToolName()} with a conforming payload`
export const FAILED_STRUCTURED_YIELD = `the last ${structuredOutputToolName()} call failed schema validation`

const SCHEMA_ISSUE_WORDS_CAP = 300

function schemaIssueWordsOf(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => (typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
        : ''
  const words = text
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/^\s*Output does not match required schema: /, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...words]
  return chars.length > SCHEMA_ISSUE_WORDS_CAP ? `${chars.slice(0, SCHEMA_ISSUE_WORDS_CAP).join('')}…` : words
}

function findLastStructuredYield(
  messages: readonly Message[],
): { valid: true; payload: unknown } | { valid: false; issues?: string } | null {
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
        const result = (rc as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>).find(
          b => b.type === 'tool_result' && b.tool_use_id === use.id,
        )
        if (result !== undefined) {
          if (result.is_error !== true) return { valid: true, payload: use.input }
          const issues = schemaIssueWordsOf(result.content)
          return issues === '' ? { valid: false } : { valid: false, issues }
        }
      }
      return { valid: false }
    }
  }
  return null
}

function structuredMissWords(status: 'missing' | 'invalid', error: string, mode: 'permissive' | 'strict'): string {
  const tool = structuredOutputToolName()
  if (status === 'missing') {
    return mode === 'strict'
      ? `The crewmate never called ${tool}, and schema_mode "strict" fails the call without a payload. Launch the crewmate again and require the answer through ${tool}, or omit schema_mode to accept its prose.`
      : `The crewmate never called ${tool}, so nothing below was checked against your schema. Check any value you take from its prose before relying on it, or launch the crewmate again and require the answer through ${tool}.`
  }
  const issues = error.slice(FAILED_STRUCTURED_YIELD.length).replace(/^: /, '')
  const failed = issues === '' ? `The crewmate's last ${tool} call failed your schema` : `The crewmate's last ${tool} call failed your schema (${issues})`
  const rule = issues === '' ? "with your schema's rules stated in its prompt" : 'with that rule stated in its prompt'
  return mode === 'strict'
    ? `${failed}, and schema_mode "strict" fails the call without a valid payload. Launch the crewmate again ${rule}, or omit schema_mode to accept its prose.`
    : `${failed}, so nothing below was checked against it. Check any value you take from its prose before relying on it, or launch the crewmate again ${rule}.`
}

export function structuredResultBlock(structured: { data?: unknown; error?: string; mode: 'permissive' | 'strict' }): string {
  const status = structured.error === undefined ? 'valid' : structured.error.startsWith(FAILED_STRUCTURED_YIELD) ? 'invalid' : 'missing'
  const body = status === 'valid' ? (JSON.stringify(structured.data) ?? 'null') : structuredMissWords(status, structured.error ?? '', structured.mode)
  return `<${STRUCTURED_TAG} status="${status}">\n${body.replaceAll(`</${STRUCTURED_TAG}`, `<\\/${STRUCTURED_TAG}`)}\n</${STRUCTURED_TAG}>`
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
    description: progress.lastActivity?.activityDescription ?? description,
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

const LAST_TOOL_CALLS = 5
const CALL_ARGUMENTS_CLIP = 120

function argumentsFirstLine(input: unknown): string {
  const text =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Object.entries(input as Record<string, unknown>)
          .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value) ?? ''}`)
          .join(', ')
      : JSON.stringify(input) ?? ''
  const line = text.split('\n')[0] ?? ''
  const chars = [...line]
  return chars.length > CALL_ARGUMENTS_CLIP ? `${chars.slice(0, CALL_ARGUMENTS_CLIP).join('')}…` : line
}

export function lastToolCallsOf(messages: readonly Message[], limit = LAST_TOOL_CALLS): string[] {
  const calls: Array<{ line: string; outcome: string }> = []
  const byId = new Map<string, { line: string; outcome: string }>()
  for (const message of messages) {
    if (message.type === 'assistant') {
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        const call = { line: `${block.name}(${argumentsFirstLine(block.input)})`, outcome: 'no result' }
        calls.push(call)
        byId.set(block.id, call)
      }
      continue
    }
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const call = byId.get(block.tool_use_id)
      if (call !== undefined) call.outcome = block.is_error === true ? 'error' : 'ok'
    }
  }
  return calls.slice(-limit).map(call => `${call.line} → ${call.outcome}`)
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
  } catch (error) {
    passedOver(error)
    return undefined
  }
}


export function recoveryBudgetCutOf(error: unknown): { words: string; resumeAfterMs: number } | null {
  const facts = recoveryBudgetSpentFactsOf(error)
  return facts === null ? null : { words: facts.words, resumeAfterMs: facts.resumeAfterMs }
}

export function overloadBudgetCutOf(error: unknown, model: string): ReturnType<typeof overloadPauseOf> {
  if (recoveryBudgetSpentFactsOf(error)?.lastStatus !== 529) return null
  const who = getMarketingNameForModel(model) ?? model
  return { pause: { why: 'provider overloaded', words: overloadPauseWords(who) }, who, status: 529 }
}

const RESUME_AFTER_CUT_FLOOR_MS = 1_000

export function budgetCutResumeDelayMs(cut: { resumeAfterMs: number }): number {
  return Math.max(RESUME_AFTER_CUT_FLOOR_MS, cut.resumeAfterMs)
}

export function windowPauseResumeDelayMs(resumesAtMs: number, nowMs: number = Date.now()): number {
  return Math.max(RESUME_AFTER_CUT_FLOOR_MS, resumesAtMs - nowMs + RESUME_AFTER_CUT_FLOOR_MS)
}

const pendingAutomaticResumes = new Map<string, ReturnType<typeof setTimeout>>()
const automaticResumesFiring = new Set<string>()
const cutsAlreadyResumed = new WeakSet<AbortController>()

export function automaticResumePending(taskId: string): boolean {
  return pendingAutomaticResumes.has(taskId)
}

export function armedAutomaticResumeCount(): number {
  let firing = 0
  for (const taskId of automaticResumesFiring) if (!pendingAutomaticResumes.has(taskId)) firing++
  return pendingAutomaticResumes.size + firing
}

async function whileFiring(taskId: string, fire: () => Promise<void>): Promise<void> {
  automaticResumesFiring.add(taskId)
  try {
    await fire()
  } finally {
    automaticResumesFiring.delete(taskId)
  }
}

function dropPauseRecord(taskId: string, description?: string): void {
  void clearAgentPauseRecord(taskId).catch((error: unknown) => {
    const reason = errorMessage(error)
    logForDebugging(`agent lifecycle: the pause record of ${taskId} could not be removed, so the next session start arms it again: ${reason}`)
    const who = description ? `Crewmate "${description}"` : `Crewmate ${taskId}`
    enqueueAgentReceiptRow({ taskId, description: description ?? taskId, status: 'paused', summary: `${who}: its pause record ${agentPauseRecordPath(taskId)} could not be removed (${reason}) — delete it, or the next session start resumes it` })
  })
}

function savePauseRecord(taskId: string, description: string, record: Parameters<typeof writeAgentPauseRecord>[1]): void {
  void writeAgentPauseRecord(taskId, record).catch((error: unknown) => {
    const reason = errorMessage(error)
    logForDebugging(`agent lifecycle: the pause of ${taskId} could not be recorded: ${reason}`)
    enqueueAgentReceiptRow({ taskId, description, status: 'paused', summary: `Crewmate "${description}": its pause record ${agentPauseRecordPath(taskId)} could not be saved (${reason}) — it will not resume on its own after a restart` })
  })
}

export function cancelAutomaticResume(taskId: string, description?: string): boolean {
  dropPauseRecord(taskId, description)
  const timer = pendingAutomaticResumes.get(taskId)
  if (timer === undefined) return false
  stopTimeout(timer)
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
  }) => Promise<{ note?: string } | void>
}): ReturnType<typeof setTimeout> | null {
  if (args.automaticResume === true) return null
  if (pendingAutomaticResumes.has(args.taskId)) return null
  if (cutsAlreadyResumed.has(args.registration)) return null
  if (args.pause !== undefined) pauseAgentTask(args.taskId, args.pause, args.rootSetAppState, args.registration)
  let unsubscribeAccount: (() => void) | undefined
  const resumeNow = async (accountChanged: boolean): Promise<void> => {
    unsubscribeAccount?.()
    unsubscribeAccount = undefined
    const armed = pendingAutomaticResumes.get(args.taskId)
    if (armed !== undefined) stopTimeout(armed)
    pendingAutomaticResumes.delete(args.taskId)
    cutsAlreadyResumed.add(args.registration)
    dropPauseRecord(args.taskId, args.description)
    let tasksNow: Record<string, unknown> | undefined
    args.rootSetAppState(prev => {
      tasksNow = prev.tasks
      return prev
    })
    const row = tasksNow?.[args.taskId]
    if (!isLocalAgentTask(row) || row.status !== 'failed' || row.registration !== args.registration) return
    const { liveAgentOwner, resumeAgentBackground } = await import('./resumeAgent.js')
    if (liveAgentOwner(args.taskId, tasksNow) !== null) return
    const resume = args.resume ?? resumeAgentBackground
    let resumed: { note?: string } | void
    try {
      resumed = await resume({
        agentId: args.taskId,
        prompt: accountChanged ? CREW_ACCOUNT_RESUME_NOTE : (args.prompt ?? AGENT_BUDGET_RESUME_NOTE),
        toolUseContext: { ...args.toolUseContext, abortController: new AbortController() },
        canUseTool: args.canUseTool,
        invokingRequestId: args.invokingRequestId,
        automatic: true,
      })
    } catch (error) {
      logForDebugging(`agent lifecycle: the automatic resume of ${args.taskId} did not start: ${errorMessage(error)}`)
      unpauseAgentTask(args.taskId, args.rootSetAppState, args.registration)
      return
    }
    enqueueAgentReceiptRow({
      taskId: args.taskId,
      description: args.description,
      summary: (accountChanged
        ? crewAccountResumeSummary(`Crewmate "${args.description}"`)
        : args.summary ??
          `Crewmate "${args.description}" resumed by itself — the recovery budget's allowance is back after it was spent waiting on the provider; its partial work carried forward`) + (resumed?.note ?? ''),
    })
  }
  const fire = (accountChanged = false): Promise<void> => whileFiring(args.taskId, () => resumeNow(accountChanged))
  const timer = startTimeout(() => {
    void runWithCwdOverride(getCwdState(), () => fire())
  }, args.delayMs ?? recoveryBudgetMs())
  timer.unref?.()
  pendingAutomaticResumes.set(args.taskId, timer)
  if (args.pause !== undefined && args.pause.why !== 'provider overloaded' && args.pause.resumesAtMs !== undefined) {
    const toolUseId = args.toolUseContext.toolUseId
    savePauseRecord(args.taskId, args.description, { pause: { ...args.pause, resumesAtMs: args.pause.resumesAtMs }, description: args.description, armedAt: Date.now(), ...(toolUseId !== undefined && toolUseId !== '' ? { toolUseId } : {}) })
  }
  if (args.pause !== undefined && args.pause.why !== 'provider overloaded') {
    unsubscribeAccount = subscribeCrewAccountChange(() => {
      if (pendingAutomaticResumes.get(args.taskId) !== timer) {
        unsubscribeAccount?.()
        unsubscribeAccount = undefined
        return
      }
      void runWithCwdOverride(getCwdState(), () => fire(true))
    })
  }
  return timer
}

const overloadEpisodes = new Map<string, OverloadEpisode>()

export function overloadEpisodeOf(taskId: string, nowMs: number = Date.now()): OverloadEpisode {
  const open = overloadEpisodes.get(taskId)
  if (open !== undefined && nowMs < open.untilMs) return open
  const fresh = openOverloadEpisode(nowMs)
  overloadEpisodes.set(taskId, fresh)
  return fresh
}

function overloadEpisodeStanding(taskId: string, nowMs: number): OverloadEpisode {
  const open = overloadEpisodes.get(taskId)
  if (open !== undefined) return open
  return overloadEpisodeOf(taskId, nowMs)
}

export function closeOverloadEpisode(taskId: string): void {
  overloadEpisodes.delete(taskId)
}

export async function probeProviderAnswers(model: string, deadlineMs: number = overloadProbeRequestMs()): Promise<boolean> {
  const { routedCallModel } = await import('../../services/providers/callModelRouter.js')
  const controller = new AbortController()
  const cut = startTimeout(() => controller.abort(), deadlineMs)
  cut.unref?.()
  try {
    const stream = routedCallModel({
      messages: [createUserMessage({ content: 'Reply with the single word ready.' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: controller.signal,
      options: {
        model,
        querySource: 'overload_probe',
        isNonInteractiveSession: true,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 1,
        skipCacheWrite: true,
      },
    })
    for await (const message of stream) {
      const m = message as { type?: string; event?: { type?: string }; isApiErrorMessage?: boolean }
      if (m.type === 'stream_event' && m.event?.type === 'message_start') return true
      if (m.type === 'assistant' && m.isApiErrorMessage !== true) return true
    }
    return false
  } catch (error) {
    logForDebugging(`overload probe of ${model} did not answer: ${errorMessage(error)}`)
    return false
  } finally {
    stopTimeout(cut)
  }
}

export function armOverloadProbe(args: {
  taskId: string
  description: string
  registration: AbortController
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  canUseTool?: CanUseToolFn
  invokingRequestId?: string
  model: string
  pause: AgentPauseV1
  afterDeath: boolean
  recorded?: boolean
  probe?: (model: string) => Promise<boolean>
  resume?: (resumeArgs: {
    agentId: string
    prompt: string
    toolUseContext: ToolUseContext
    canUseTool?: CanUseToolFn
    invokingRequestId?: string
    automatic: true
  }) => Promise<{ note?: string } | void>
}): ReturnType<typeof setTimeout> | null {
  if (pendingAutomaticResumes.has(args.taskId)) return null
  const nowMs = Date.now()
  const episode = overloadEpisodeStanding(args.taskId, nowMs)
  const delayMs = nextOverloadProbeDelayMs(episode, nowMs, args.afterDeath)
  if (delayMs === null) {
    unpauseAgentTask(args.taskId, args.rootSetAppState, args.registration)
    closeOverloadEpisode(args.taskId)
    dropPauseRecord(args.taskId, args.description)
    return null
  }
  pauseAgentTask(args.taskId, args.pause, args.rootSetAppState, args.registration)
  const stillThisRow = (): boolean => {
    let tasksNow: Record<string, unknown> | undefined
    args.rootSetAppState(prev => {
      tasksNow = prev.tasks
      return prev
    })
    const row = tasksNow?.[args.taskId]
    return isLocalAgentTask(row) && row.status === 'failed' && row.registration === args.registration && row.paused !== undefined
  }
  const probeNow = async (): Promise<void> => {
    pendingAutomaticResumes.delete(args.taskId)
    if (!stillThisRow()) return
    episode.probes += 1
    const answered = await (args.probe ?? probeProviderAnswers)(args.model)
    if (!stillThisRow()) return
    if (!answered) {
      armOverloadProbe({ ...args, afterDeath: false, recorded: true })
      return
    }
    dropPauseRecord(args.taskId, args.description)
    const { liveAgentOwner, resumeAgentBackground } = await import('./resumeAgent.js')
    let tasksNow: Record<string, unknown> | undefined
    args.rootSetAppState(prev => {
      tasksNow = prev.tasks
      return prev
    })
    if (liveAgentOwner(args.taskId, tasksNow) !== null) return
    const resume = args.resume ?? resumeAgentBackground
    try {
      const resumed = await resume({
        agentId: args.taskId,
        prompt: AGENT_OVERLOAD_RESUME_NOTE,
        toolUseContext: { ...args.toolUseContext, abortController: new AbortController() },
        canUseTool: args.canUseTool,
        invokingRequestId: args.invokingRequestId,
        automatic: true,
      })
      if (resumed?.note) enqueueAgentReceiptRow({ taskId: args.taskId, description: args.description, summary: resumed.note.trimStart() })
    } catch (error) {
      logForDebugging(`agent lifecycle: the resume of ${args.taskId} after the provider answered did not start: ${errorMessage(error)}`)
      unpauseAgentTask(args.taskId, args.rootSetAppState, args.registration)
      closeOverloadEpisode(args.taskId)
    }
  }
  const fire = (): Promise<void> => whileFiring(args.taskId, probeNow)
  const timer = startTimeout(() => {
    void runWithCwdOverride(getCwdState(), fire)
  }, delayMs)
  timer.unref?.()
  pendingAutomaticResumes.set(args.taskId, timer)
  if (args.recorded !== true) {
    const toolUseId = args.toolUseContext.toolUseId
    savePauseRecord(args.taskId, args.description, { pause: { why: 'provider overloaded', words: args.pause.words }, model: args.model, description: args.description, armedAt: nowMs, ...(toolUseId !== undefined && toolUseId !== '' ? { toolUseId } : {}) })
  }
  return timer
}

function taskStateReader(
  toolUseContext: ToolUseContext,
  rootSetAppState: SetAppState,
): NonNullable<ToolUseContext['getAppState']> {
  return (
    toolUseContext.getAppState ??
    (() => {
      let captured!: ReturnType<NonNullable<ToolUseContext['getAppState']>>
      rootSetAppState(prev => {
        captured = prev
        return prev
      })
      return captured
    })
  )
}

export async function deliverOperatorMessagesAfterStop(
  taskId: string,
  description: string,
  toolUseContext: ToolUseContext,
  rootSetAppState: SetAppState,
  canUseTool?: CanUseToolFn,
): Promise<boolean> {
  const stateReader =
    toolUseContext.getAppState ??
    ((): ReturnType<NonNullable<ToolUseContext['getAppState']>> => {
      let captured: unknown
      rootSetAppState(prev => {
        captured = prev
        return prev
      })
      return captured as ReturnType<NonNullable<ToolUseContext['getAppState']>>
    })
  const queued = peekOperatorMessages(stateReader().tasks[taskId])
  if (queued.length === 0) return false
  try {
    const { resumeAgentBackground } = await import('./resumeAgent.js')
    const resumed = await resumeAgentBackground({
      agentId: taskId,
      prompt: queued.join('\n\n'),
      replyTarget: 'operator',
      toolUseContext: { ...toolUseContext, abortController: new AbortController() },
      canUseTool,
    })
    if (resumed.note) enqueueAgentReceiptRow({ taskId, description, summary: resumed.note.trimStart() })
    takeOperatorMessages(taskId, stateReader, rootSetAppState)
    return true
  } catch (error) {
    logForDebugging(`agent lifecycle: the operator's queued lines did not deliver after the stop: ${errorMessage(error)}`)
    return false
  }
}

const noticesOwed = new Set<object>()

export function crewmateNoticeOwed(): boolean {
  return noticesOwed.size > 0
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
  replyTarget?: 'parent' | 'operator'
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
  canUseTool?: CanUseToolFn
}): Promise<void> {
  const { taskId, makeStream, metadata, description, toolUseContext, rootSetAppState, agentIdForCleanup, enableSummarization } = args
  const tracker = createProgressTracker()
  const resolveActivity = createActivityDescriptionResolver(toolUseContext.options.tools)
  const readState = taskStateReader(toolUseContext, rootSetAppState)
  const accumulated: Message[] = []
  const owedKey = {}
  let stopSummarization: (() => void) | undefined
  let summaryStopped = false
  const stopSummary = (): void => {
    summaryStopped = true
    stopSummarization?.()
    stopSummarization = undefined
  }
  const onCacheSafeParams = enableSummarization
    ? (params: CacheSafeParams) => {
        void import('../../services/AgentSummary/agentSummary.js')
          .then(({ startAgentSummarization }) => {
            const handle = startAgentSummarization(taskId, agentIdForCleanup, params, rootSetAppState)
            if (summaryStopped) handle.stop()
            else stopSummarization = handle.stop
          })
          .catch((error: unknown) => {
            logForDebugging(`agent lifecycle: summarization start failed: ${errorMessage(error)}`)
          })
      }
    : undefined
  const onQueryProgress = (event: unknown): void => {
    publishAgentWaitFromEvent(taskId, tracker, event, rootSetAppState)
  }

  let streamError: unknown
  let hasStreamError = false
  let result: AgentToolResult | undefined
  try {
    try {
      for await (const message of makeStream(onCacheSafeParams, onQueryProgress)) {
        accumulated.push(message)
        emitBackgroundAgentRows(toolUseContext.toolUseId, message)
        const currentTask = readState().tasks?.[taskId]
        if (isLocalAgentTask(currentTask) && currentTask.retain === true) {
          appendMessageToLocalAgent(taskId, message, rootSetAppState)
        }
        updateProgressFromMessage(tracker, message, resolveActivity, toolUseContext.options.tools)
        publishAgentProgressSoon(taskId, tracker, rootSetAppState)
        const lastToolName = getLastToolUseName(message)
        if (lastToolName !== undefined) {
          emitTaskProgress(tracker, taskId, toolUseContext.toolUseId, description, metadata.startTime, lastToolName)
        }
      }
      stopSummary()
      result = finalizeAgentTool(accumulated, taskId, metadata)
    } catch (error) {
      streamError = error
      hasStreamError = true
      stopSummary()
    }

    if (hasStreamError) {
      if (streamError instanceof AbortError) {
        await settleAbortedRun(args, tracker, accumulated, owedKey)
      } else {
        await settleErroredRun(args, streamError, tracker, accumulated, owedKey)
      }
    } else {
      await settleFinishedRun(args, result!, tracker, accumulated, owedKey)
    }
  } finally {
    noticesOwed.delete(owedKey)
    stopSummary()
    try {
      clearInvokedSkillsForAgent(agentIdForCleanup)
    } catch (error) {
      logForDebugging(`agent lifecycle: final cleanup failed: ${errorMessage(error)}`)
    }
  }
}

async function settleAbortedRun(
  args: AsyncAgentLifecycleArgs,
  tracker: ProgressTracker,
  accumulated: Message[],
  owedKey: object,
): Promise<void> {
  const { taskId, abortController, metadata, description, toolUseContext, rootSetAppState, getWorktreeResult, canUseTool } = args
  const stopReason = agentStopReasonOf(abortController.signal.reason)
  const stopStatusWord = agentStopStatusWordOf(abortController.signal.reason)
  noticesOwed.add(owedKey)
  killAsyncAgent(taskId, rootSetAppState, stopReason, abortController)
  closeOverloadEpisode(taskId)
  const worktreeResult = await getWorktreeResult()
  await flushSessionStorage()
  const partialResult = extractPartialResult(accumulated)
  const usage = { totalTokens: getTokenCountFromTracker(tracker), toolUses: tracker.toolUseCount, durationMs: Date.now() - metadata.startTime }
  const envelopeBlock = await partialResultEnvelopeBlock({
    agentId: taskId,
    agentType: metadata.agentType,
    status: 'stopped',
    partialText: partialResult,
    usage: { totalTokens: usage.totalTokens, toolUseCount: usage.toolUses, durationMs: usage.durationMs },
  })
  enqueueAgentNotification(stoppedNoticeOf(args, { partialResult, usage, accumulated, stopReason, stopStatusWord, worktreeResult, envelopeBlock }))
  noticesOwed.delete(owedKey)
  await deliverOperatorMessagesAfterStop(taskId, description, toolUseContext, rootSetAppState, canUseTool)
}

async function settleErroredRun(args: AsyncAgentLifecycleArgs, streamError: unknown, tracker: ProgressTracker, accumulated: Message[], owedKey: object): Promise<void> {
  const { taskId, abortController, metadata, description, toolUseContext, rootSetAppState, automaticResume, replyTarget, getWorktreeResult, canUseTool } = args
  const errMsg = errorMessage(streamError)
  const overload = overloadBudgetCutOf(streamError, metadata.resolvedAgentModel)
  const budgetCut = overload === null ? recoveryBudgetCutOf(streamError) : null
  let overloadSuppressesNotice = false
  if (overload !== null) {
    const episode = overloadEpisodeOf(taskId)
    noteOverloadDeath(episode)
    overloadSuppressesNotice = !overloadDeathNotifies(episode)
  }
  noticesOwed.add(owedKey)
  const noticeFollows = !overloadSuppressesNotice && replyTarget !== 'operator'
  failAgentTask(taskId, errMsg, rootSetAppState, abortController, { settleFrame: !noticeFollows })
  const worktreeResult = await getWorktreeResult()
  await flushSessionStorage()
  if (!overloadSuppressesNotice) {
    const partialResult = extractPartialResult(accumulated)
    const usage = { totalTokens: getTokenCountFromTracker(tracker), toolUses: tracker.toolUseCount, durationMs: Date.now() - metadata.startTime }
    const envelopeBlock = await partialResultEnvelopeBlock({ agentId: taskId, agentType: metadata.agentType, status: 'failed', partialText: partialResult, usage: { totalTokens: usage.totalTokens, toolUseCount: usage.toolUses, durationMs: usage.durationMs } })
    enqueueAgentNotification(failedNoticeOf(args, { errMsg, overload, partialResult, usage, accumulated, worktreeResult, envelopeBlock }))
  }
  noticesOwed.delete(owedKey)
  if (overload !== null) {
    armOverloadProbe({ taskId, description, registration: abortController, toolUseContext, rootSetAppState, canUseTool, model: metadata.resolvedAgentModel, pause: overload.pause, afterDeath: true })
  } else if (budgetCut !== null && !automaticResume) {
    const delayMs = budgetCutResumeDelayMs(budgetCut)
    armBudgetCutResume({ taskId, description, registration: abortController, toolUseContext, rootSetAppState, canUseTool, delayMs, automaticResume, pause: { why: 'provider busy', words: budgetCut.words, resumesAtMs: Date.now() + delayMs }, prompt: AGENT_BUDGET_RESUME_NOTE })
  }
}

async function tryQueuedGuidance(args: AsyncAgentLifecycleArgs): Promise<boolean> {
  const { taskId, description, toolUseContext, rootSetAppState, canUseTool } = args
  try {
    const readState = taskStateReader(toolUseContext, rootSetAppState)
    const currentTask = readState().tasks?.[taskId]
    const pendingParent = isLocalAgentTask(currentTask) ? [...(currentTask.pendingMessages ?? [])] : []
    const pendingOperator = peekOperatorMessages(currentTask)
    const combined = [...pendingParent, ...pendingOperator]
    if (combined.length === 0) return false
    const nextReplyTarget: 'parent' | 'operator' = pendingParent.length > 0 ? 'parent' : 'operator'
    const { resumeAgentBackground } = await import('./resumeAgent.js')
    const resumed = await resumeAgentBackground({ agentId: taskId, prompt: combined.join('\n\n'), toolUseContext, canUseTool, replyTarget: nextReplyTarget })
    if (resumed.note) {
      enqueueAgentReceiptRow({ taskId, description, summary: resumed.note.trimStart() })
    }
    if (pendingParent.length > 0) drainPendingMessages(taskId, readState, rootSetAppState, pendingParent.length)
    if (pendingOperator.length > 0) takeOperatorMessages(taskId, readState, rootSetAppState, pendingOperator.length)
    return nextReplyTarget === 'parent'
  } catch (error) {
    logForDebugging(`agent lifecycle: queued-guidance drain failed: ${errorMessage(error)}`)
    return false
  }
}

async function settleFinishedRun(args: AsyncAgentLifecycleArgs, result: AgentToolResult, tracker: ProgressTracker, accumulated: Message[], owedKey: object): Promise<void> {
  const { taskId, abortController, metadata, rootSetAppState, replyTarget, getWorktreeResult } = args
  const declined = result.outcome?.status === 'failed' ? result.outcome : undefined
  const windowPause = declined ? usageWindowPauseOf(accumulated, metadata.resolvedAgentModel) : null
  const overload = declined && windowPause === null ? overloadPauseOf(accumulated, metadata.resolvedAgentModel) : null
  let overloadSuppressesNotice = false
  if (overload !== null) {
    const episode = overloadEpisodeOf(taskId)
    noteOverloadDeath(episode)
    overloadSuppressesNotice = !overloadDeathNotifies(episode)
  }

  noticesOwed.add(owedKey)
  const noticeFollows = !overloadSuppressesNotice && replyTarget !== 'operator'
  if (declined) {
    settleDeclinedRun(args, declined, noticeFollows, overload, windowPause)
  } else {
    completeAgentTask(result, rootSetAppState, abortController, {
      usage: { tokens: getTokenCountFromTracker(tracker), toolUses: result.totalToolUseCount, durationMs: result.totalDurationMs },
      settleFrame: !noticeFollows,
    })
  }

  let continuedOnParentGuidance = false
  if (!declined) {
    closeOverloadEpisode(taskId)
    continuedOnParentGuidance = await tryQueuedGuidance(args)
  }

  if (!continuedOnParentGuidance && !overloadSuppressesNotice) {
    const joinedContent = result.content.map(block => block.text).join('\n')
    const finalMessage =
      result.outcome?.status === 'completed' && result.outcome.promotedNarration && joinedContent !== ''
        ? `${PROMOTED_NARRATION_NOTE}\n\n${joinedContent}`
        : joinedContent
    const worktreeResult = await getWorktreeResult()
    const envelopeStatus: 'paused' | 'failed' | 'completed' = windowPause !== null || overload !== null ? 'paused' : declined ? 'failed' : 'completed'
    let envelopeBlock: string | undefined
    try {
      const { buildAgentResultEnvelope, formatEnvelopeBlock } = await import('../../services/agentResults/normalize.js')
      envelopeBlock = formatEnvelopeBlock(
        await buildAgentResultEnvelope({ agentId: taskId, agentType: metadata.agentType, status: envelopeStatus, finalText: finalMessage, usage: { totalTokens: getTokenCountFromTracker(tracker), toolUseCount: result.totalToolUseCount, durationMs: result.totalDurationMs } }),
      )
    } catch (error) {
      passedOver(error)
    }
    enqueueAgentNotification(completionNoticeOf(args, { declined, accumulated, windowPause, overload, finalMessage, result, tracker, worktreeResult, envelopeBlock }))
  }
  noticesOwed.delete(owedKey)
}

type AsyncAgentLifecycleArgs = Parameters<typeof runAsyncAgentLifecycle>[0]
type AgentNotice = Parameters<typeof enqueueAgentNotification>[0]
type DeclinedOutcome = Extract<NonNullable<AgentToolResult['outcome']>, { status: 'failed' }>
type PartialRunFacts = { partialResult: ReturnType<typeof extractPartialResult>; usage: { totalTokens: number; toolUses: number; durationMs: number }; accumulated: Message[]; worktreeResult: Awaited<ReturnType<AsyncAgentLifecycleArgs['getWorktreeResult']>>; envelopeBlock: Awaited<ReturnType<typeof partialResultEnvelopeBlock>> }

function settleDeclinedRun(args: AsyncAgentLifecycleArgs, declined: DeclinedOutcome, noticeFollows: boolean, overload: ReturnType<typeof overloadPauseOf>, windowPause: AgentPauseV1 | null): void {
  const { taskId, description, toolUseContext, rootSetAppState, metadata } = args
  failAgentTask(taskId, declined.error, rootSetAppState, args.abortController, { settleFrame: !noticeFollows })
  if (overload !== null) {
    armOverloadProbe({
      taskId,
      description,
      registration: args.abortController,
      toolUseContext,
      rootSetAppState,
      canUseTool: args.canUseTool,
      model: metadata.resolvedAgentModel,
      pause: overload.pause,
      afterDeath: true,
    })
  } else if (windowPause !== null) {
    if (windowPause.resumesAtMs !== undefined && !args.automaticResume) {
      armBudgetCutResume({
        taskId,
        description,
        registration: args.abortController,
        toolUseContext,
        rootSetAppState,
        canUseTool: args.canUseTool,
        delayMs: windowPauseResumeDelayMs(windowPause.resumesAtMs),
        pause: windowPause,
        prompt: AGENT_WINDOW_RESUME_NOTE,
        summary: `Crewmate "${description}" resumed by itself — the usage window reset; its partial work carried forward`,
      })
    } else {
      pauseAgentTask(taskId, windowPause, rootSetAppState, args.abortController)
    }
  }
}

function completionNoticeOf(
  args: AsyncAgentLifecycleArgs,
  { declined, accumulated, windowPause, overload, finalMessage, result, tracker, worktreeResult, envelopeBlock }: Omit<PartialRunFacts, 'partialResult' | 'usage' | 'envelopeBlock'> & { declined: DeclinedOutcome | undefined; windowPause: AgentPauseV1 | null; overload: ReturnType<typeof overloadPauseOf>; finalMessage: string; result: AgentToolResult; tracker: ReturnType<typeof createProgressTracker>; envelopeBlock: string | undefined },
): AgentNotice {
  const { taskId, description, toolUseContext, rootSetAppState } = args
  return {
    taskId,
    description,
    status: declined ? 'failed' : 'completed',
    ...(declined ? { error: declined.error, landedWrites: landedWritesOf(accumulated), lastCalls: lastToolCallsOf(accumulated) } : {}),
    ...(windowPause !== null
      ? {
          statusWord: 'paused',
          summary: `Crewmate "${description}" paused — ${windowPause.words}; ${pauseResumeWords(windowPause, Date.now())} — its work so far is kept and rides below; ${AGENT_RESUME_DOOR}`,
        }
      : {}),
    ...(overload !== null
      ? {
          statusWord: 'paused',
          summary: overloadNoticeWords(description, overload.who, undefined, overload.status),
        }
      : {}),
    setAppState: rootSetAppState,
    controller: args.abortController,
    replyTarget: args.replyTarget,
    finalMessage,
    ...(result.structured !== undefined ? { structuredBlock: structuredResultBlock(result.structured) } : {}),
    usage: {
      totalTokens: getTokenCountFromTracker(tracker),
      toolUses: result.totalToolUseCount,
      durationMs: result.totalDurationMs,
    },
    toolUseId: toolUseContext.toolUseId,
    ...worktreeResult,
    ...(envelopeBlock ? { envelopeBlock } : {}),
  }
}

function stoppedNoticeOf(args: AsyncAgentLifecycleArgs, { partialResult, usage, accumulated, stopReason, stopStatusWord, worktreeResult, envelopeBlock }: PartialRunFacts & { stopReason: string | undefined; stopStatusWord: string | undefined }): AgentNotice {
  const { taskId, description, toolUseContext, rootSetAppState } = args
  return {
    taskId,
    description,
    status: 'killed',
    setAppState: rootSetAppState,
    controller: args.abortController,
    replyTarget: args.replyTarget,
    toolUseId: toolUseContext.toolUseId,
    finalMessage: partialResult,
    usage,
    landedWrites: landedWritesOf(accumulated),
    lastCalls: lastToolCallsOf(accumulated),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(stopStatusWord !== undefined ? { statusWord: stopStatusWord } : {}),
    ...worktreeResult,
    ...(envelopeBlock ? { envelopeBlock } : {}),
  }
}

function failedNoticeOf(args: AsyncAgentLifecycleArgs, { errMsg, overload, partialResult, usage, accumulated, worktreeResult, envelopeBlock }: PartialRunFacts & { errMsg: string; overload: ReturnType<typeof overloadPauseOf> }): AgentNotice {
  const { taskId, description, toolUseContext, rootSetAppState } = args
  return {
    taskId,
    description,
    status: 'failed',
    error: errMsg,
    ...(overload !== null ? { statusWord: 'paused', summary: overloadNoticeWords(description, overload.who, undefined, overload.status) } : {}),
    finalMessage: partialResult,
    usage,
    landedWrites: landedWritesOf(accumulated),
    lastCalls: lastToolCallsOf(accumulated),
    setAppState: rootSetAppState,
    controller: args.abortController,
    replyTarget: args.replyTarget,
    toolUseId: toolUseContext.toolUseId,
    ...worktreeResult,
    ...(envelopeBlock ? { envelopeBlock } : {}),
  }
}

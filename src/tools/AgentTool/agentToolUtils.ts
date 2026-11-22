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
import { getCwdState } from '../../bootstrap/state.js'
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
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

const MCP_TOOL_PREFIX = 'mcp__'


export function filterToolsForAgent(args: {
  tools: Tools
  isBuiltIn: boolean
}): Tools {
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:97')
}

export type ResolvedAgentTools = Unbuilt

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
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:130')
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


export const agentToolResultSchema: Unbuilt = unbuilt('src/tools/AgentTool/agentToolUtils.ts:307')

export type AgentToolResult = Unbuilt

export function countToolUses(messages: readonly Message[]): number {
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:364')
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
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:594')
}

export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:605')
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
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:808')
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
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:958')
}

export async function deliverOperatorMessagesAfterStop(
  taskId: string,
  description: string,
  toolUseContext: ToolUseContext,
  rootSetAppState: SetAppState,
  canUseTool?: CanUseToolFn,
): Promise<boolean> {
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:1048')
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
  return notBuilt('src/tools/AgentTool/agentToolUtils.ts:1091')
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

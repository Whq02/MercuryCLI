import { featureReached } from '../../substrate/featureReached.js'
import type {
  CanUseToolFn,
  AnyObject,
  Tool,
  ToolResult,
  ToolUseContext,
} from '../../Tool.js'
import { closestToolByName, findToolByName, offeredToolNamesClause, toolMatchesName } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { AGENT_TOOL_NAME } from '../../constants/tools/agent.js'
import { completionIdentity } from '../agentResults/summaryRoom.js'
import { addToToolDuration, canAnswerAsks, getSessionId, getSessionKind, getStatsStore } from '../../bootstrap/state.js'
import { guardKeysOf, judgeToolCall } from '../../guards/guards.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import type { PermissionAllowDecision, PermissionDecisionReason } from '../../types/permissions.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import type { ContentBlockParam, ToolResultBlockParam, ToolUseBlock } from '../../types/wire.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { createAttachmentMessage } from '../attachments/orchestrator.js'
import { logForDebugging } from '../../utils/debug.js'
import { isAbortError, ShellError, type ShellRunFact } from '../../utils/errors.js'
import { clampToolResultImageBlocks } from '../../utils/imageResizer.js'
import { logError } from '../../utils/log.js'
import { CANCEL_MESSAGE, createToolResultStopMessage, createUserMessage } from '../messages.js'
import type { HermesKillInfo } from '../../utils/permissions/capabilityGate.js'
import { toolKillReason } from '../../utils/permissions/capabilityGate.js'
import { formatZodValidationError } from '../../utils/toolErrors.js'
import { processPreMappedToolResultBlock } from '../../utils/toolResultStorage.js'
import { RESULT_ROOM_WORDS, resultRoomFor, tokensOfResultText } from '../run/resultRoom.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
} from '../messages/toolSearch.js'
import { isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import { deferralSearchIsServerSide, deferralWireFormFor } from '../providers/deferralWire.js'
import { repairToolInput, toolCallRefusalResultText } from '../providers/toolCallGate.js'
import { outputSchemaMismatch } from './toolOutputCheck.js'
import { getEngineModel } from '../model/model.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools/fileEdit.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tools/fileRead.js'
import { FILE_WRITE_TOOL_NAME } from '../../constants/tools/fileWrite.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { refusalWithReason, ruleSentence, wholeToolDenyRulesCovering, withRuleReason } from '../../utils/permissions/ruleReason.js'
import { displayToolName } from '../../utils/toolNameDisplay.js'
import type { HookAnnounce, HookPermissionOutcome } from './toolHooks.js'
import { afterToolHooks, beforeToolHooks, deciderOf, hookPermissionOutcomeOf, permissionDecidedHooks, resolveHookPermissionDecision } from './toolHooks.js'
import { hookProgressMessage, hookRowsOfResult } from '../../utils/hooks/rows.js'
import { hookWaitSeconds, hookWaitWords } from '../../utils/hooks/wait.js'
import { baseToolsOfTheTable } from '../../tools/toolTable.js'
import { passedOver } from '../../utils/passedOver.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../../utils/timers.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export type MessageUpdateLazy<M = Message> = Unbuilt

function shellRunOfResult(tool: Tool, data: unknown): ShellRunFact | null {
  if (!toolMatchesName(tool, BASH_TOOL_NAME)) return null
  if (typeof data !== 'object' || data === null) return null
  const out = data as { code?: unknown; interrupted?: unknown }
  if (out.interrupted === true) return null
  return { code: typeof out.code === 'number' ? out.code : null }
}

function shellRunOfError(tool: Tool, error: unknown): ShellRunFact | null {
  if (!toolMatchesName(tool, BASH_TOOL_NAME)) return null
  if (!(error instanceof ShellError) || !error.ran || error.interrupted) return null
  return { code: error.code, output: [error.stderr, error.stdout].filter(part => part !== '').join('\n') }
}

const SLOW_PHASE_THRESHOLD_MS = 2000

const PRE_TOOL_HOOK_DURATION_METRIC = 'pre_tool_hook_duration_ms'

const TOOL_EXEC_ACTIVITY = 'tool_exec'

const SIMULATED_EDIT_MARKER = '_simulatedSedEdit'

type SchemaHintAsk = {
  tool: Tool
  messages: Message[]
  tools: readonly { name: string }[]
  model: string
}

type SchemaHintSilence =
  | 'tool-search-off'
  | 'tool-search-not-callable'
  | 'schema-sent'
  | 'server-side-search'
  | 'already-loaded'

const SCHEMA_HINT_SILENCES: ReadonlyArray<readonly [SchemaHintSilence, (ask: SchemaHintAsk) => boolean]> = [
  ['tool-search-off', () => !isToolSearchEnabledOptimistic()],
  ['tool-search-not-callable', ({ tools }) => !isToolSearchToolAvailable(tools)],
  ['schema-sent', ({ tool, model, messages }) => !isDeferredToolFor(tool, model, undefined, messages)],
  ['server-side-search', ({ model }) => deferralSearchIsServerSide(deferralWireFormFor(model).form)],
  ['already-loaded', ({ tool, messages }) => extractDiscoveredToolNames(messages).has(tool.name)],
]

function schemaHintSilence(ask: SchemaHintAsk): SchemaHintSilence | null {
  return SCHEMA_HINT_SILENCES.find(([, holds]) => holds(ask))?.[0] ?? null
}

function loadRoadSentence(toolName: string): string {
  return `Load it with one call — ${TOOL_SEARCH_TOOL_NAME} with query "select:${toolName}" — then make this call again.`
}

function schemaNotSentWords(toolName: string): string {
  return (
    `\n\nThe ${toolName} schema was not in this turn's request: the tool sits in the deferred set and nothing in this conversation has loaded it yet. ` +
    `Without the schema in front of you, every typed parameter (an array, a number, a boolean) went out as a string, and the parser refused the call for that. ` +
    loadRoadSentence(toolName)
  )
}

export function buildSchemaNotSentHint(
  tool: Tool,
  messages: Message[],
  tools: readonly { name: string }[],
  model?: Unbuilt,
): string | null {
  return notBuilt('src/services/tools/toolExecution.ts:140')
}

function extractKillTarget(toolName: string, input: AnyObject): string | undefined {
  let target: string | undefined
  try {
    const clamp = (s: string): string => s.split('\n')[0]!.slice(0, 60)
    if (toolName === 'WebFetch' && typeof input?.url === 'string') {
      target = new URL(input.url).hostname
    } else if (typeof input?.command === 'string') {
      target = clamp(String(input.command))
    } else if (
      (toolName === FILE_READ_TOOL_NAME ||
        toolName === FILE_EDIT_TOOL_NAME ||
        toolName === FILE_WRITE_TOOL_NAME) &&
      typeof input?.file_path === 'string'
    ) {
      target = clamp(String(input.file_path))
    } else if (
      toolName === NOTEBOOK_EDIT_TOOL_NAME &&
      typeof input?.notebook_path === 'string'
    ) {
      target = clamp(String(input.notebook_path))
    } else {
      for (const [k, v] of Object.entries(input ?? {})) {
        if (
          /(key|secret|token|password|passwd|credential|authorization|bearer|cookie)/i.test(k)
        ) {
          continue
        }
        if (typeof v === 'string' && v) {
          target = clamp(v)
          break
        }
        if (typeof v === 'number') {
          target = String(v)
          break
        }
      }
    }
  } catch (error) {
    passedOver(error)
  }
  return target || undefined
}

export function toolUseError(content: string): string {
  return `<tool_use_error>${content}</tool_use_error>`
}

function errorResultUpdate(args: {
  toolUseID: string
  content: string
  toolUseResult: unknown
  sourceToolAssistantUUID: AssistantMessage['uuid']
  extraBlocks?: ContentBlockParam[]
  imagePasteIds?: number[]
}): MessageUpdateLazy {
  const block: ToolResultBlockParam = {
    type: 'tool_result',
    content: toolUseError(args.content),
    is_error: true,
    tool_use_id: args.toolUseID,
  }
  return {
    message: createUserMessage({
      content: [block, ...(args.extraBlocks ?? [])],
      toolUseResult: args.toolUseResult,
      sourceToolAssistantUUID: args.sourceToolAssistantUUID,
      ...(args.imagePasteIds !== undefined ? { imagePasteIds: args.imagePasteIds } : {}),
    }),
  }
}

function interruptResultUpdate(
  toolUseID: string,
  sourceToolAssistantUUID: AssistantMessage['uuid'],
  text: string = CANCEL_MESSAGE,
): MessageUpdateLazy {
  const block = {
    ...createToolResultStopMessage(toolUseID),
    content: text,
  }
  return {
    message: createUserMessage({
      content: [block],
      toolUseResult: text,
      sourceToolAssistantUUID,
    }),
  }
}

const TOOL_ABORT_GRACE_MS = 750

class ToolCallAbandonedError extends Error {
  constructor(toolName: string) {
    super(`${toolName} did not answer the interrupt within ${TOOL_ABORT_GRACE_MS}ms — the call was abandoned`)
    this.name = 'ToolCallAbandonedError'
  }
}

function blockWords(content: ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (part.type === 'text' ? part.text : '')).filter(Boolean).join('\n')
}

function settleUnderAbort<T>(
  call: Promise<T>,
  signal: AbortSignal,
  toolName: string,
  onAbandoned: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let abandoned = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    const finish = (land: () => void): void => {
      if (settled) return
      settled = true
      if (grace !== undefined) stopTimeout(grace)
      signal.removeEventListener('abort', onAbort)
      land()
    }
    const onAbort = (): void => {
      if (settled || grace !== undefined) return
      grace = startTimeout(() => {
        abandoned = true
        onAbandoned()
        finish(() => reject(new ToolCallAbandonedError(toolName)))
      }, TOOL_ABORT_GRACE_MS)
    }
    call.then(
      value => {
        if (abandoned) {
          logForDebugging(`tool ${toolName} answered ${Date.now() - startedAt}ms after its call was abandoned on interrupt — the late result is dropped`)
          return
        }
        finish(() => resolve(value))
      },
      (error: unknown) => {
        if (abandoned) {
          logForDebugging(`tool ${toolName} failed ${Date.now() - startedAt}ms after its call was abandoned on interrupt — the late error is dropped`)
          return
        }
        finish(() => reject(error))
      },
    )
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function nextImagePasteIds(messages: Message[], count: number): number[] {
  let max = 0
  for (const message of messages) {
    if (message.type !== 'user') continue
    for (const id of (message as UserMessage).imagePasteIds ?? []) {
      if (id > max) max = id
    }
  }
  const ids: number[] = []
  for (let i = 1; i <= count; i++) ids.push(max + i)
  return ids
}

function isImageBlock(block: unknown): boolean {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: string }).type === 'image'
  )
}

export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  round?: { id: string; ordinal: number },
): AsyncGenerator<MessageUpdateLazy> {
  return notBuilt('src/services/tools/toolExecution.ts:321')
}

async function runTransactionBody(args: {
  tool: Tool
  toolUse: ToolUseBlock
  toolUseID: string
  roundHandle: string
  rawInput: AnyObject
  assistantMessage: AssistantMessage
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  push: (update: MessageUpdateLazy) => void
}): Promise<void> {
  return notBuilt('src/services/tools/toolExecution.ts:457')
}

type TraceOnce = (opts: { killed?: boolean; durationMs?: number; ok?: boolean; outputMismatch?: boolean }) => void

function refuseKilledTool(tool: Tool, toolUseContext: ToolUseContext, input: AnyObject, traceOnce: TraceOnce, push: (update: MessageUpdateLazy) => void, toolUseID: string, sourceUUID: AssistantMessage['uuid']): void {
  const reason = toolKillReason(tool, toolUseContext.agentType)
  const target = extractKillTarget(tool.name, input)
  const hermesKill: HermesKillInfo = {
    kind: 'capability-gate',
    ...(reason?.killPattern !== undefined ? { killPattern: reason.killPattern } : {}),
    tool: tool.name,
    ...(target !== undefined ? { target } : {}),
  }
  traceOnce({ killed: true, ok: false })
  const content = `The ${tool.name} tool has been switched off for this agent by the operator (capability kill-switch).`
  push(
    errorResultUpdate({
      toolUseID,
      content,
      toolUseResult: { error: content, hermesKill },
      sourceToolAssistantUUID: sourceUUID,
    }),
  )
  logForDebugging(`tool use refused by capability kill-switch: ${tool.name}`)
}

function refuseInvalidInput(tool: Tool, parsed: { error: Parameters<typeof formatZodValidationError>[1] }, toolUseContext: ToolUseContext, traceOnce: TraceOnce, emitError: (content: string, toolUseResult: unknown) => void): void {
  traceOnce({ ok: false })
  let content = formatZodValidationError(tool.name, parsed.error, tool.inputJSONSchema)
  const silence = schemaHintSilence({
    tool,
    messages: toolUseContext.messages,
    tools: toolUseContext.options.tools,
    model: toolUseContext.options.engineModel,
  })
  if (silence === null) content += schemaNotSentWords(tool.name)
  else logForDebugging(`schema hint withheld for ${tool.name}: ${silence}`)
  emitError(content, content)
}

interface ToolCallNeeds {
  args: Parameters<typeof runTransactionBody>[0]
  tool: Tool
  toolUseID: string
  assistantMessage: AssistantMessage
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  push: (update: MessageUpdateLazy) => void
  signal: AbortSignal
  sourceUUID: AssistantMessage['uuid']
  traceOnce: TraceOnce
  settleHookWait: () => void
  announceHooks: (event: 'tool.before' | 'tool.after') => HookAnnounce
  decision: PermissionAllowDecision
  callInput: AnyObject
  observableInput: AnyObject
  decidedRows: { message: ReturnType<typeof createAttachmentMessage> }[]
  allowanceRow: ReturnType<typeof createAttachmentMessage> | null
  hookNotes: Message[]
  stopReason: string | undefined
}

interface ResultUpdateNeeds {
  assistantMessage: AssistantMessage
  tool: Tool
  toolUseID: string
  toolUseContext: ToolUseContext
  acceptFeedback: string | undefined
  allowBlocks: ContentBlockParam[]
  isSubagent: boolean
  result: ToolResult<unknown> | undefined
  sourceUUID: AssistantMessage['uuid']
}

async function buildResultUpdate(blockForEmission: ToolResultBlockParam, { assistantMessage, tool, toolUseID, toolUseContext, acceptFeedback, allowBlocks, isSubagent, result, sourceUUID }: ResultUpdateNeeds): Promise<MessageUpdateLazy> {
  const room = resultRoomFor(assistantMessage)
  const processed = await processPreMappedToolResultBlock(
    blockForEmission,
    tool.name,
    tool.maxResultSizeChars,
    room === null || room.reserved(toolUseID) ? undefined : { shareChars: room.allowance(toolUseID) * 4, words: RESULT_ROOM_WORDS },
    toolUseContext.options.engineModel,
  )
  if (room !== null) {
    const landed = (processed as { content?: unknown }).content
    room.settle(toolUseID, tokensOfResultText(typeof landed === 'string' ? landed : JSON.stringify(landed ?? '')))
  }
  const blocks: ContentBlockParam[] = [processed]
  if (acceptFeedback) blocks.push({ type: 'text', text: acceptFeedback })
  blocks.push(...allowBlocks)
  const imageCount = allowBlocks.filter(isImageBlock).length
  const imagePasteIds =
    imageCount > 0 ? nextImagePasteIds(toolUseContext.messages, imageCount) : undefined
  return {
    message: createUserMessage({
      content: blocks,
      ...(isSubagent ? tool.name === AGENT_TOOL_NAME && completionIdentity(result!.data) !== null ? { toolUseResult: completionIdentity(result!.data) } : {} : { toolUseResult: result!.data }),
      ...(isSubagent || result!.mcpMeta === undefined
        ? {}
        : { mcpMeta: result!.mcpMeta }),
      sourceToolAssistantUUID: sourceUUID,
      ...(imagePasteIds !== undefined ? { imagePasteIds } : {}),
    }),
    ...(result!.contextModifier !== undefined
      ? {
          contextModifier: {
            toolUseID,
            modifier: result!.contextModifier,
          },
        }
      : {}),
  }
}

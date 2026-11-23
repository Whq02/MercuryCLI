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
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { observeToolStart, observeToolTerminal, type ToolTerminalEvent } from '../../utils/run/effectObserver.js'
import { emitInvocationTrace } from '../../utils/observability/invocationTrace.js'
import { isToolKilled } from '../../utils/permissions/capabilityGate.js'
import { startSessionActivity, stopSessionActivity } from '../../utils/sessionActivity.js'
import { formatError } from '../../utils/toolErrors.js'
import { getCwd } from '../../utils/cwd.js'
import { Stream } from '../../utils/stream.js'
import { POWERSHELL_TOOL_NAME } from '../../constants/tools/powershell.js'
import { McpAuthError } from '../mcp/client.js'
import { createProgressMessage, turnCutOf, turnCutResultText } from '../messages.js'
import { ambientRound, closeRound, openRoundCall, recordToolCall, repeatedResultPointer, toolResultBlockOf, withResultContent } from './loopGuard.js'


export type MessageUpdateLazy<M = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifier: (context: ToolUseContext) => ToolUseContext
  }
  shellRun?: ShellRunFact
}

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
  model: string = getEngineModel(),
): string | null {
  return schemaHintSilence({ tool, messages, tools, model }) === null ? schemaNotSentWords(tool.name) : null
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
  const toolUseID = toolUse.id
  const rawInput = (toolUse.input ?? {}) as AnyObject
  const sourceUUID = assistantMessage.uuid
  const { tools } = toolUseContext.options
  const { signal } = toolUseContext.abortController
  const owner = ownerFromToolUseContext(toolUseContext)

  const ambient = round === undefined ? ambientRound(owner, toolUseContext.toolUseId) : null
  const joined = round ?? ambient
  const roundID = joined === null ? `call:${toolUseID}` : joined.id
  const roundOrdinal = joined === null ? 0 : joined.ordinal
  const parentHandle = ambient === null ? null : toolUseContext.roundHandle ?? toolUseContext.toolUseId ?? null
  const roundHandle = openRoundCall(owner, roundID, toolUseID, roundOrdinal, parentHandle, toolUseContext.messages)

  function* closeCall(toolName: string, result: ToolResultBlockParam | undefined): Generator<MessageUpdateLazy> {
    if (signal.aborted) return
    recordToolCall(owner, { toolName, toolUseID, roundHandle, roundID, roundOrdinal, arguments: rawInput, result, messages: toolUseContext.messages })
    if (joined !== null) return
    for (const message of closeRound(owner, roundID).messages) yield { message }
  }

  const refusal = assistantMessage.refusedToolCalls?.find(entry => entry.id === toolUseID && entry.code !== 'unknown-tool')
  const tool = offeredToolOf(tools, toolUse.name)
  if (refusal !== undefined || tool === undefined) {
    const text = refusal !== undefined ? toolCallRefusalResultText(refusal) : unknownToolWords(toolUse.name, toolUseContext)
    const update = errorResultUpdate({ toolUseID, content: text, toolUseResult: `Error: ${text}`, sourceToolAssistantUUID: sourceUUID })
    yield update
    yield* closeCall(displayToolName(toolUse.name), toolResultBlockOf(update.message, toolUseID))
    return
  }

  const updates = new Stream<MessageUpdateLazy>()
  runTransactionBody({ tool, toolUse, toolUseID, roundHandle, rawInput, assistantMessage, canUseTool, toolUseContext, push: update => updates.enqueue(update) }).then(
    () => updates.done(),
    (error: unknown) => updates.error(error),
  )
  let settled: ToolResultBlockParam | undefined
  try {
    for await (const update of updates) {
      const block = toolResultBlockOf(update.message, toolUseID)
      if (block === undefined) {
        yield update
        continue
      }
      settled = block
      const pointer = await repeatedResultPointer(owner, { toolName: tool.name, toolUseID, roundID, arguments: rawInput, result: block, messages: toolUseContext.messages })
      yield pointer === null ? update : withResultContent(update, toolUseID, pointer)
    }
  } catch (error) {
    logError(error)
    const text = `Error calling tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`
    const update = errorResultUpdate({ toolUseID, content: text, toolUseResult: text, sourceToolAssistantUUID: sourceUUID })
    settled = toolResultBlockOf(update.message, toolUseID)
    yield update
  }
  yield* closeCall(tool.name, settled)
}

function offeredToolOf(tools: ToolUseContext['options']['tools'], requestedName: string): Tool | undefined {
  const offered = findToolByName(tools, requestedName)
  if (offered !== undefined) return offered
  const base = findToolByName(baseToolsOfTheTable(), requestedName)
  return base !== undefined && base.name !== requestedName && toolMatchesName(base, requestedName) ? base : undefined
}

function noSuchToolWords(shownName: string, offeredNames: string): string {
  return `No such tool available: ${shownName}. It is not in this session's tool list — call one of the tools you were given${offeredNames} (a ToolSearch query loads a deferred tool when one is offered).`
}

function deferredNearNameWords(shownName: string, closestName: string, loadSentence: string): string {
  return `No such tool available: ${shownName}. Did you mean \`${closestName}\`? It is a deferred tool this session has not loaded yet. ${loadSentence}`
}

function nearNameWords(shownName: string, closestName: string): string {
  return `No such tool available: ${shownName}. Did you mean \`${closestName}\`? Call it by that exact name.`
}

function headlessQuestionWords(toolName: string): string {
  return `This session runs headless with no host, so no operator can answer ${toolName} — the request was auto-denied and nothing was asked. Choose the most reasonable option yourself, state the assumption in your reply, and continue; a host on the runner door (mercury runner) can answer such asks. If nothing reasonable remains without the answer, end your turn here: the run then ends blocked, with your question on its outcome row.`
}

function headlessPermissionWords(toolName: string): string {
  return `This session runs headless and cannot ask for approval, so the request was auto-denied — it was not run. To allow it, pre-approve the tool at launch with --allowed-tools (for example --allowed-tools "${toolName}"), or start in a permission mode that does not stop here with --mode. (Interactive-only shortcuts such as the "!" prefix do not apply to a headless run.)`
}

function unknownToolWords(requestedName: string, toolUseContext: ToolUseContext): string {
  const { tools } = toolUseContext.options
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  const named = findToolByName([...baseToolsOfTheTable(), ...(appState.mcp?.tools ?? [])], requestedName)
  const covering = named === undefined ? [] : wholeToolDenyRulesCovering(permissionContext, named)
  const denyRule = covering[0]
  if (denyRule !== undefined) {
    const said = withRuleReason(permissionContext, denyRule, () => covering)
    return refusalWithReason(ruleSentence(`Using ${requestedName}`, 'deny', said), said.ruleValue.reason)
  }
  const shownName = displayToolName(requestedName)
  const near = closestToolByName(tools, requestedName)
  if (near === undefined) return noSuchToolWords(shownName, offeredToolNamesClause(tools))
  if (buildSchemaNotSentHint(near, toolUseContext.messages, tools, toolUseContext.options.engineModel) !== null) {
    return deferredNearNameWords(shownName, near.name, loadRoadSentence(near.name))
  }
  return nearNameWords(shownName, near.name)
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
  const { tool, toolUseID, rawInput, assistantMessage, canUseTool, toolUseContext, push } = args
  const { signal } = toolUseContext.abortController
  const sourceUUID = assistantMessage.uuid
  const owner = ownerFromToolUseContext(toolUseContext)

  let traced = false
  const traceOnce: TraceOnce = opts => {
    if (traced) return
    traced = true
    try {
      emitInvocationTrace(tool, opts)
    } catch (error) {
      passedOver(error)
    }
  }
  const pushCancel = (): void => push(interruptResultUpdate(toolUseID, sourceUUID))

  let closeHookWait: (() => void) | null = null
  const settleHookWait = (): void => {
    const close = closeHookWait
    closeHookWait = null
    close?.()
  }
  const announceHooks = (event: 'tool.before' | 'tool.after'): HookAnnounce => prepared => {
    settleHookWait()
    const { names, timeoutsS } = prepared
    names.forEach((name, index) => {
      push({ message: hookProgressMessage(event, name, 'running', toolUseID, names.length, { timeoutS: timeoutsS[index] }) })
    })
    const sinceMs = Date.now()
    const first = names[0] ?? ''
    const timeoutS = Math.max(0, ...timeoutsS)
    let waitedS = 0
    let ticked = false
    const timer = startInterval(() => {
      waitedS = hookWaitSeconds(waitedS + 1, sinceMs, Date.now())
      ticked = true
      const line = hookWaitWords({ event, names, sinceMs, timeoutS }, sinceMs + waitedS * 1000)
      push({ message: hookProgressMessage(event, first, 'waiting', toolUseID, names.length, { timeoutS, elapsedS: waitedS, line }) })
    }, 1000)
    timer.unref()
    closeHookWait = () => {
      stopInterval(timer)
      if (ticked) push({ message: hookProgressMessage(event, first, 'waiting', toolUseID, names.length) })
    }
  }

  if (signal.aborted) {
    pushCancel()
    return
  }
  if (isToolKilled(tool, toolUseContext.agentType)) {
    refuseKilledTool(tool, toolUseContext, rawInput, traceOnce, push, toolUseID, sourceUUID)
    return
  }
  const parsed = tool.inputSchema.safeParse(repairToolInput(tool, rawInput))
  if (!parsed.success) {
    refuseInvalidInput(tool, parsed, toolUseContext, traceOnce, (content, toolUseResult) => {
      push(errorResultUpdate({ toolUseID, content, toolUseResult, sourceToolAssistantUUID: sourceUUID }))
    })
    return
  }
  let parsedInput: AnyObject = parsed.data

  const validation = await tool.validateInput?.(parsedInput, toolUseContext)
  if (validation?.result === false) {
    traceOnce({ ok: false })
    if (tool.name === FILE_EDIT_TOOL_NAME && validation.errorCode !== undefined) {
      await noteEditOutcome(toolUseContext, `error-${validation.errorCode}`)
    }
    logForDebugging(`tool input validation failed for ${tool.name}: ${validation.message.slice(0, 200)}`)
    push(errorResultUpdate({ toolUseID, content: validation.message, toolUseResult: `Error: ${validation.message}`, sourceToolAssistantUUID: sourceUUID }))
    return
  }
  if (Object.hasOwn(parsedInput, SIMULATED_EDIT_MARKER)) {
    const { [SIMULATED_EDIT_MARKER]: _marker, ...unmarked } = parsedInput
    parsedInput = unmarked
  }

  let observableInput = parsedInput
  let backfilledPath: string | undefined
  if (tool.backfillObservableInput !== undefined) {
    try {
      const copy = { ...parsedInput }
      tool.backfillObservableInput(copy)
      observableInput = copy
      if (typeof copy.file_path === 'string' && copy.file_path !== parsedInput.file_path) backfilledPath = copy.file_path
    } catch (error) {
      logError(error)
    }
  }

  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  const permissionMode = permissionContext.mode
  const gateStartedAt = Date.now()
  const judgement = await judgeToolCall(
    guardKeysOf(getSessionId(), toolUseContext.agentId),
    {
      tool: tool.name,
      input: observableInput,
      callId: toolUseID,
      messages: toolUseContext.messages,
      offeredTools: toolUseContext.options.tools.map(offered => offered.name),
      toolRef: tool,
      asksAnswerable: canAnswerAsks() && permissionContext.shouldAvoidPermissionPrompts !== true,
    },
    signal,
  )
  const hookNotes: Message[] = judgement.notes
  let hookOutcome: HookPermissionOutcome | undefined
  let hookInput: AnyObject | undefined
  let stopReason: string | undefined
  if (judgement.refused) {
    hookOutcome = { behavior: 'deny', message: judgement.reason, decisionReason: { type: 'guard', guard: judgement.guard, reason: judgement.reason } }
  } else {
    const before = await beforeToolHooks(tool, toolUseID, observableInput, toolUseContext, signal, announceHooks('tool.before'))
    settleHookWait()
    for (const outcome of before.outcomes) {
      push({ message: hookProgressMessage('tool.before', outcome.name, 'ran', toolUseID, before.outcomes.length) })
    }
    for (const row of hookRowsOfResult(before, { callId: toolUseID })) push({ message: createAttachmentMessage(row) })
    hookOutcome = hookPermissionOutcomeOf(before, tool.name)
    if (hookOutcome === undefined && before.answer.input !== undefined) hookInput = before.answer.input
    stopReason = before.answer.stop
  }
  const gateMs = Date.now() - gateStartedAt
  try {
    getStatsStore()?.observe(PRE_TOOL_HOOK_DURATION_METRIC, gateMs)
  } catch (error) {
    passedOver(error)
  }
  if (gateMs > SLOW_PHASE_THRESHOLD_MS) logForDebugging(`pre-tool hooks for ${tool.name} took ${gateMs}ms`)

  if (signal.aborted) {
    traceOnce({ ok: false })
    pushCancel()
    return
  }

  const workingInput = hookInput ?? observableInput
  const decisionStartedAt = Date.now()
  const resolved = await resolveHookPermissionDecision(hookOutcome, tool, workingInput, toolUseContext, canUseTool, assistantMessage, toolUseID)
  const { decision } = resolved
  const decisionMs = Date.now() - decisionStartedAt
  if (decisionMs > SLOW_PHASE_THRESHOLD_MS && permissionMode === 'flow') {
    logForDebugging(`permission decision for ${tool.name} took ${decisionMs}ms (mode ${permissionMode}) → ${decision.behavior}`)
  }

  const decided = await permissionDecidedHooks(
    tool,
    toolUseID,
    resolved.input,
    {
      decision: decision.behavior === 'allow' ? 'allowed' : 'denied',
      by: deciderOf(decision.decisionReason),
      ...(decision.behavior !== 'allow' && decision.message !== undefined ? { reason: decision.message } : {}),
    },
    toolUseContext,
    signal,
  )
  const decidedRows = hookRowsOfResult(decided, { callId: toolUseID }).map(row => ({ message: createAttachmentMessage(row) }))
  const allowanceRow =
    decision.behavior === 'allow' && decision.decisionReason?.type === 'bypassedAsk'
      ? createAttachmentMessage({
          type: 'bypassed_ask',
          toolUseID,
          mode: decision.decisionReason.mode,
          road: decision.decisionReason.road,
          reason: createPermissionRequestMessage(tool.name, decision.decisionReason.reason),
        })
      : null

  if (decision.behavior !== 'allow') {
    traceOnce({ ok: false })
    const own = decision.message ?? (stopReason === undefined ? `Permission to use ${tool.name} was denied.` : `Tool execution was stopped by a pre-tool hook${stopReason === '' ? '' : `: ${stopReason}`}`)
    const nobodyToAsk =
      (toolUseContext.options.isNonInteractiveSession && getSessionKind() !== 'oculus') ||
      toolUseContext.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts === true
    const note =
      decision.behavior === 'ask' && nobodyToAsk
        ? `\n\n${tool.requiresUserInteraction?.(rawInput) === true ? headlessQuestionWords(tool.name) : headlessPermissionWords(tool.name)}`
        : ''
    const text = `${own}${note}`
    const extraBlocks = decision.behavior === 'ask' ? decision.contentBlocks ?? [] : []
    const imageCount = extraBlocks.filter(isImageBlock).length
    push(
      errorResultUpdate({
        toolUseID,
        content: text,
        toolUseResult: `Error: ${text}`,
        sourceToolAssistantUUID: sourceUUID,
        ...(extraBlocks.length > 0 ? { extraBlocks } : {}),
        ...(imageCount > 0 ? { imagePasteIds: nextImagePasteIds(toolUseContext.messages, imageCount) } : {}),
      }),
    )
    for (const row of decidedRows) push(row)
    logForDebugging(`tool use refused: ${tool.name}`)
    return
  }

  const allowedInput = decision.updatedInput ?? workingInput
  if (signal.aborted) {
    traceOnce({ ok: false })
    pushCancel()
    return
  }
  const callInput =
    allowedInput === observableInput || allowedInput === parsedInput
      ? parsedInput
      : backfilledPath !== undefined && allowedInput.file_path === backfilledPath
        ? { ...allowedInput, file_path: parsedInput.file_path }
        : allowedInput
  await runAdmittedCall({
    args,
    tool,
    toolUseID,
    assistantMessage,
    canUseTool,
    toolUseContext,
    push,
    signal,
    sourceUUID,
    traceOnce,
    settleHookWait,
    announceHooks,
    decision,
    callInput,
    observableInput,
    decidedRows,
    allowanceRow,
    hookNotes,
    stopReason,
  })
}

async function noteEditOutcome(toolUseContext: ToolUseContext, outcome: string): Promise<void> {
  try {
    const { recordEditOutcome } = await import('../changeTransaction/editOutcomeLedger.js')
    recordEditOutcome(ownerFromToolUseContext(toolUseContext), toolUseContext.options.engineModel, 'edit', outcome)
  } catch (error) {
    passedOver(error)
  }
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

function isShellOutcome(data: unknown): data is NonNullable<ToolTerminalEvent['shellOutcome']> {
  return typeof data === 'object' && data !== null && typeof (data as { code?: unknown }).code === 'number'
}

function launchedInBackground(data: unknown): boolean {
  return typeof data === 'object' && data !== null && typeof (data as { backgroundTaskId?: unknown }).backgroundTaskId === 'string'
}

async function runAdmittedCall(needs: ToolCallNeeds): Promise<void> {
  const { args, tool, toolUseID, assistantMessage, canUseTool, toolUseContext, push, signal, sourceUUID, traceOnce, settleHookWait, announceHooks, decision, callInput, observableInput, decidedRows, allowanceRow, hookNotes } = needs
  const owner = ownerFromToolUseContext(toolUseContext)
  const isSubagent = toolUseContext.agentId !== undefined && toolUseContext.preserveToolResults !== true
  const pushHookRows = (fired: Awaited<ReturnType<typeof afterToolHooks>>): void => {
    for (const outcome of fired.outcomes) {
      push({ message: hookProgressMessage('tool.after', outcome.name, 'ran', toolUseID, fired.outcomes.length) })
    }
    for (const row of hookRowsOfResult(fired, { callId: toolUseID })) push({ message: createAttachmentMessage(row) })
  }

  startSessionActivity(TOOL_EXEC_ACTIVITY)
  const startedAt = Date.now()
  let executed = false
  let succeeded = false
  let durationMs: number | undefined
  let outputMismatch = false
  let result: ToolResult<unknown> | undefined
  let failedShellOutcome: ToolTerminalEvent['shellOutcome']
  try {
    observeToolStart({ owner, toolName: tool.name, toolUseId: toolUseID })
    executed = true
    if (tool.isMcp !== true) featureReached('tool', tool.name)

    let abandoned = false
    const answered = await settleUnderAbort(
      tool.call(
        callInput,
        { ...toolUseContext, toolUseId: toolUseID, roundHandle: args.roundHandle, userModifiedInput: decision.userModified },
        canUseTool,
        assistantMessage,
        progress => {
          if (abandoned) return
          push({ message: createProgressMessage({ toolUseID: progress.toolUseID, parentToolUseID: toolUseID, data: progress.data }) })
        },
      ),
      signal,
      tool.name,
      () => {
        abandoned = true
      },
    )
    result = answered
    durationMs = Date.now() - startedAt
    try {
      addToToolDuration(durationMs)
    } catch (error) {
      passedOver(error)
    }
    const { structured_output: structuredOutput } = answered as ToolResult<unknown> & { structured_output?: unknown }
    if (structuredOutput !== undefined) push({ message: createAttachmentMessage({ type: 'structured_output', data: structuredOutput }) })
    succeeded = answered.effect?.outcome !== 'failed'
    const mismatch = outputSchemaMismatch(tool, answered.data)
    if (mismatch !== undefined) {
      outputMismatch = true
      logForDebugging(`tool output mismatch for ${tool.name}: ${mismatch}`)
    }
    const mapped = tool.mapToolResultToToolResultBlockParam(answered.data, toolUseID)
    try {
      await clampToolResultImageBlocks(mapped)
    } catch (error) {
      logError(error)
    }
    if (!succeeded) mapped.is_error = true

    const returnedError = !succeeded || mapped.is_error === true
    const cut = signal.aborted
    const errorWords = !succeeded
      ? answered.effect?.evidence
      : returnedError
        ? blockWords(mapped.content)
        : cut
          ? turnCutResultText(turnCutOf(signal.reason), tool.name)
          : undefined
    const afterStartedAt = Date.now()
    const after = await afterToolHooks(
      tool,
      toolUseID,
      callInput,
      { ok: !returnedError && !cut, output: answered.data, ...(errorWords !== undefined ? { error: errorWords } : {}), cut, wallMs: durationMs },
      toolUseContext,
      signal,
      announceHooks('tool.after'),
    )
    settleHookWait()
    const afterMs = Date.now() - afterStartedAt
    if (afterMs > SLOW_PHASE_THRESHOLD_MS) logForDebugging(`post-tool hooks for ${tool.name} took ${afterMs}ms`)

    const replacement = after.answer.output
    const block: ToolResultBlockParam =
      replacement === undefined
        ? mapped
        : {
            type: 'tool_result',
            tool_use_id: toolUseID,
            content: typeof replacement === 'string' ? replacement : jsonStringify(replacement),
            ...(returnedError ? { is_error: true } : {}),
          }
    const update = await buildResultUpdate(block, {
      assistantMessage,
      tool,
      toolUseID,
      toolUseContext,
      acceptFeedback: decision.acceptFeedback,
      allowBlocks: decision.contentBlocks ?? [],
      isSubagent,
      result: answered,
      sourceUUID,
    })
    const shellRun = tool.isMcp === true || replacement !== undefined ? null : shellRunOfResult(tool, answered.data)
    push(shellRun === null ? update : { ...update, shellRun })
    pushHookRows(after)
    for (const message of answered.newMessages ?? []) push({ message })
  } catch (error) {
    settleHookWait()
    durationMs = Date.now() - startedAt
    succeeded = false
    const room = resultRoomFor(assistantMessage)
    if (room !== null && room.reserved(toolUseID)) room.settle(toolUseID, 0)
    try {
      addToToolDuration(durationMs)
    } catch (failure) {
      passedOver(failure)
    }
    if (error instanceof ShellError && error.ran && !error.interrupted) {
      failedShellOutcome = { code: error.code, ...(error.pipelineStatus !== undefined ? { pipelineStatus: error.pipelineStatus } : {}) }
    }
    const abandoned = error instanceof ToolCallAbandonedError
    if (abandoned) logForDebugging(`tool ${tool.name}: ${error.message}`)
    const interrupt = abandoned || isAbortError(error)
    const cutText = interrupt && signal.aborted ? turnCutResultText(turnCutOf(signal.reason), tool.name) : undefined
    const message = cutText ?? (error instanceof Error ? error.message : String(error))
    if (error instanceof McpAuthError) {
      try {
        flipMcpClientToNeedsAuth(tool, toolUseContext)
      } catch (failure) {
        logError(failure)
      }
    }
    if (!interrupt) {
      logForDebugging(`tool ${tool.name} failed after ${durationMs}ms: ${message.slice(0, 200)}`)
      if (!(error instanceof ShellError)) logError(error)
    }
    if (cutText !== undefined) push(interruptResultUpdate(toolUseID, sourceUUID, cutText))
    const after = await afterToolHooks(tool, toolUseID, callInput, { ok: false, error: message, cut: signal.aborted, wallMs: durationMs }, toolUseContext, signal, announceHooks('tool.after'))
    settleHookWait()
    if (cutText === undefined) {
      const { mcpMeta } = error as { mcpMeta?: UserMessage['mcpMeta'] }
      const shellRun = shellRunOfError(tool, error)
      push({
        message: createUserMessage({
          content: [{ type: 'tool_result', content: toolUseError(formatError(error)), is_error: true, tool_use_id: toolUseID }],
          toolUseResult: `Error: ${message}`,
          ...(mcpMeta === undefined || isSubagent ? {} : { mcpMeta }),
          sourceToolAssistantUUID: sourceUUID,
        }),
        ...(shellRun === null ? {} : { shellRun }),
      })
    }
    pushHookRows(after)
  } finally {
    if (executed) {
      for (const row of decidedRows) push(row)
      if (allowanceRow !== null) push({ message: allowanceRow })
      for (const note of hookNotes) push({ message: note })
      traceOnce({ durationMs, ok: succeeded, ...(outputMismatch ? { outputMismatch: true } : {}) })
      const effect = result?.effect
      if (tool.name === FILE_EDIT_TOOL_NAME && effect?.operation === 'file.edit') {
        await noteEditOutcome(toolUseContext, effect.outcome === 'succeeded' ? 'applied' : effect.outcome === 'no-change' ? 'no-change' : `error-${effect.outcome}`)
      }
      try {
        const shell = tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME
        observeToolTerminal({
          owner,
          toolName: tool.name,
          toolUseId: toolUseID,
          input: observableInput,
          ok: succeeded,
          durationMs,
          effect,
          ...(result?.changeIntent !== undefined ? { intentProjection: result.changeIntent } : {}),
          cwd: getCwd(),
          ...(shell ? { shellOutcome: failedShellOutcome ?? (isShellOutcome(result?.data) ? result.data : undefined) } : {}),
          ...(shell && launchedInBackground(result?.data) ? { lifecycle: 'launch' } : {}),
        })
      } catch (error) {
        passedOver(error)
      }
    } else {
      traceOnce({ ok: false })
    }
    stopSessionActivity(TOOL_EXEC_ACTIVITY)
    toolUseContext.toolDecisions?.delete(toolUseID)
  }
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

function flipMcpClientToNeedsAuth(tool: Tool, context: ToolUseContext): void {
  const serverName = tool.mcpInfo?.serverName
  if (!serverName) return
  context.setAppState(prevState => {
    const mcp = (prevState as { mcp?: { clients?: Array<{ name: string; type: string }> } }).mcp
    if (!mcp?.clients) return prevState
    const index = mcp.clients.findIndex(
      client => client.name === serverName && client.type === 'connected',
    )
    if (index === -1) return prevState
    const clients = [...mcp.clients]
    clients[index] = { ...clients[index]!, type: 'needs-auth' }
    return { ...prevState, mcp: { ...mcp, clients } } as typeof prevState
  })
}

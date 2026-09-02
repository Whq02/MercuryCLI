import type {
  AnyObject,
  Tool,
  ToolResult,
  ToolUseContext,
} from '../../Tool.js'
import { findToolByName, toolMatchesName } from '../../Tool.js'
import { startSpeculativeClassifierCheck } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { getLoggingSafeMcpBaseUrl } from '../mcp/utils.js'
import type { McpServerConfig } from '../mcp/types.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { addToToolDuration, getStatsStore } from '../../bootstrap/state.js'
import { themisToolGate } from '../../substrate/themis/gate.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import type { ToolResultBlockParam, ToolUseBlock } from '../../types/wire.js'
import { createAttachmentMessage } from '../../utils/attachments/orchestrator.js'
import { logForDebugging } from '../../utils/debug.js'
import { isAbortError, ShellError } from '../../utils/errors.js'
import { clampToolResultImageBlocks } from '../../utils/imageResizer.js'
import { logError } from '../../utils/log.js'
import {
  CANCEL_MESSAGE,
  createProgressMessage,
  createToolResultStopMessage,
  createUserMessage,
  withMemoryCorrectionHint,
} from '../../utils/messages.js'
import { emitInvocationTrace } from '../../utils/observability/invocationTrace.js'
import type { HermesKillInfo } from '../../utils/permissions/capabilityGate.js'
import { isToolKilled, toolKillReason } from '../../utils/permissions/capabilityGate.js'
import { McpAuthError } from '../mcp/client.js'
import { mcpInfoFromString } from '../mcp/mcpStringUtils.js'
import { normalizeNameForMCP } from '../mcp/normalization.js'
import { observeToolStart, observeToolTerminal } from '../run/effectObserver.js'
import { ownerFromToolUseContext } from '../run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { startSessionActivity, stopSessionActivity } from '../../utils/sessionActivity.js'
import { Stream } from '../../utils/stream.js'
import { formatError, formatZodValidationError } from '../../utils/toolErrors.js'
import {
  processPreMappedToolResultBlock,
  processToolResultBlock,
} from '../../utils/toolResultStorage.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
} from '../../utils/toolSearch.js'
import { isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { getAllBaseTools } from '../../tools.js'
import type { HookPermissionOutcome, PreToolUseHookItem } from './toolHooks.js'
import {
  resolveHookPermissionDecision,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from './toolHooks.js'


export type McpServerType =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'ws'
  | 'sdk'
  | 'sse-ide'
  | 'ws-ide'
  | 'claudeai-proxy'
  | undefined

export type MessageUpdateLazy<M = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifier: (context: ToolUseContext) => ToolUseContext
  }
}

const SLOW_PHASE_THRESHOLD_MS = 2000

export const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500

const PRE_TOOL_HOOK_DURATION_METRIC = 'pre_tool_hook_duration_ms'

const TOOL_EXEC_ACTIVITY = 'tool_exec'

const PERMISSION_REQUEST_HOOK_NAME = 'PermissionRequest'

const SIMULATED_EDIT_MARKER = '_simulatedSedEdit'

export function buildSchemaNotSentHint(
  tool: Tool,
  messages: Message[],
  tools: readonly { name: string }[],
): string | null {
  if (!isToolSearchEnabledOptimistic()) return null
  if (!isToolSearchToolAvailable(tools)) return null
  if (!isDeferredTool(tool)) return null
  const discovered = extractDiscoveredToolNames(messages)
  if (discovered.has(tool.name)) return null
  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
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
  } catch {
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
  extraBlocks?: unknown[]
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
      content: [block, ...((args.extraBlocks as never[]) ?? [])] as never,
      toolUseResult: args.toolUseResult,
      sourceToolAssistantUUID: args.sourceToolAssistantUUID as never,
      ...(args.imagePasteIds !== undefined ? { imagePasteIds: args.imagePasteIds } : {}),
    }),
  }
}

function interruptResultUpdate(
  toolUseID: string,
  sourceToolAssistantUUID: AssistantMessage['uuid'],
): MessageUpdateLazy {
  const block = {
    ...createToolResultStopMessage(toolUseID),
    content: withMemoryCorrectionHint(CANCEL_MESSAGE),
  }
  return {
    message: createUserMessage({
      content: [block] as never,
      toolUseResult: CANCEL_MESSAGE,
      sourceToolAssistantUUID: sourceToolAssistantUUID as never,
    }),
  }
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
): AsyncGenerator<MessageUpdateLazy> {
  const toolUseID = toolUse.id
  const requestedName = toolUse.name
  const rawInput = (toolUse.input ?? {}) as AnyObject

  let tool = findToolByName(toolUseContext.options.tools, requestedName)
  if (!tool) {
    const baseMatch = findToolByName(getAllBaseTools(), requestedName)
    if (baseMatch && baseMatch.name !== requestedName && toolMatchesName(baseMatch, requestedName)) {
      tool = baseMatch
    }
  }
  if (!tool) {
    const unknownToolText = `No such tool available: ${requestedName}. It is not in this session's tool list — call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).`
    yield errorResultUpdate({
      toolUseID,
      content: unknownToolText,
      toolUseResult: `Error: ${unknownToolText}`,
      sourceToolAssistantUUID: assistantMessage.uuid,
    })
    return
  }

  const stream = new Stream<MessageUpdateLazy>()
  const resolved = tool
  const body = runTransactionBody({
    tool: resolved,
    toolUse,
    toolUseID,
    rawInput,
    assistantMessage,
    canUseTool,
    toolUseContext,
    push: update => stream.enqueue(update),
  })
  body.then(
    () => stream.done(),
    error => stream.error(error),
  )
  try {
    for await (const update of stream) {
      yield update
    }
    await body
  } catch (error) {
    logError(error)
    const message = error instanceof Error ? error.message : String(error)
    yield errorResultUpdate({
      toolUseID,
      content: `Error calling tool ${resolved.name}: ${message}`,
      toolUseResult: `Error calling tool ${resolved.name}: ${message}`,
      sourceToolAssistantUUID: assistantMessage.uuid,
    })
  }
}

async function runTransactionBody(args: {
  tool: Tool
  toolUse: ToolUseBlock
  toolUseID: string
  rawInput: AnyObject
  assistantMessage: AssistantMessage
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  push: (update: MessageUpdateLazy) => void
}): Promise<void> {
  const { tool, toolUseID, assistantMessage, canUseTool, toolUseContext, push } = args
  const input = args.rawInput
  const signal = toolUseContext.abortController.signal
  const sourceUUID = assistantMessage.uuid

  let traceEmitted = false
  const traceOnce = (opts: { killed?: boolean; durationMs?: number; ok?: boolean }): void => {
    if (traceEmitted) return
    traceEmitted = true
    try {
      emitInvocationTrace(tool as never, opts as never)
    } catch {
    }
  }

  const emitError = (content: string, toolUseResult: unknown): void => {
    push(
      errorResultUpdate({
        toolUseID,
        content,
        toolUseResult,
        sourceToolAssistantUUID: sourceUUID,
      }),
    )
  }

  if (signal.aborted) {
    traceOnce({ ok: false })
    push(interruptResultUpdate(toolUseID, sourceUUID))
    return
  }

  const mcpFacts = mcpServerConnectionFacts(
    tool,
    toolUseContext.options.mcpClients ?? [],
  )
  const hookSeam = {
    messageId: assistantMessage.uuid as string | undefined,
    requestId: (assistantMessage as { requestId?: string }).requestId,
    mcpServerType: mcpFacts.serverType as McpServerType,
    mcpServerUrl: mcpFacts.serverUrl,
  }

  if (isToolKilled(tool, toolUseContext.agentType)) {
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
    return
  }

  const themisVerdict = themisToolGate(tool.name, input, toolUseContext.agentType)
  if (themisVerdict.action === 'deny-mission') {
    traceOnce({ killed: true, ok: false })
    const content = `This call was refused by the active change mission (enforce level). ${themisVerdict.missionMessage}`
    const hermesKill: HermesKillInfo = { kind: 'themis-mission', tool: tool.name }
    push(
      errorResultUpdate({
        toolUseID,
        content,
        toolUseResult: { error: content, hermesKill },
        sourceToolAssistantUUID: sourceUUID,
      }),
    )
    return
  }
  if (themisVerdict.action === 'deny') {
    traceOnce({ killed: true, ok: false })
    const hit = themisVerdict.hit
    const content =
      `This call was refused by the THEMIS blocklist: rule ${hit.id} (${hit.category}). ` +
      `Do not rephrase the command to evade this rule — surface the refusal to the operator instead.`
    const hermesKill: HermesKillInfo = {
      kind: 'themis-blocklist',
      killPattern: hit.id,
      tool: tool.name,
      target: hit.match,
    }
    push(
      errorResultUpdate({
        toolUseID,
        content,
        toolUseResult: { error: content, hermesKill },
        sourceToolAssistantUUID: sourceUUID,
      }),
    )
    return
  }

  const parsed = tool.inputSchema.safeParse(input)
  if (!parsed.success) {
    traceOnce({ ok: false })
    let content = `InputValidationError: ${formatZodValidationError(tool.name, parsed.error, tool.inputJSONSchema)}`
    const hint = buildSchemaNotSentHint(
      tool,
      toolUseContext.messages,
      toolUseContext.options.tools,
    )
    if (hint) content += hint
    emitError(content, `InputValidationError: ${parsed.error.message}`)
    return
  }
  let parsedInput = parsed.data as AnyObject

  if (tool.validateInput) {
    const verdict = await tool.validateInput(parsedInput as never, toolUseContext)
    if (verdict && verdict.result === false) {
      traceOnce({ ok: false })
      try {
        const code = (verdict as { errorCode?: number }).errorCode
        if (tool.name === 'Edit' && code !== undefined) {
          const { recordEditOutcome } = await import('../changeTransaction/editOutcomeLedger.js')
          recordEditOutcome(
            ownerFromToolUseContext(toolUseContext),
            toolUseContext.options.mainLoopModel,
            'edit',
            `error-${code}`,
          )
        }
      } catch {
      }
      logForDebugging(
        `tool input validation failed for ${tool.name}: ${(verdict.message ?? '').slice(0, 200)}`,
      )
      emitError(verdict.message, `Error: ${verdict.message}`)
      return
    }
  }


  if (
    typeof parsedInput === 'object' &&
    parsedInput !== null &&
    SIMULATED_EDIT_MARKER in parsedInput
  ) {
    const scrubbed = { ...parsedInput }
    delete scrubbed[SIMULATED_EDIT_MARKER]
    parsedInput = scrubbed
  }

  let observableInput = parsedInput
  let backfilledPath: string | undefined
  if (tool.backfillObservableInput) {
    const clone = { ...parsedInput }
    try {
      tool.backfillObservableInput(clone as never)
      observableInput = clone
      if (typeof clone.file_path === 'string' && clone.file_path !== parsedInput.file_path) {
        backfilledPath = clone.file_path
      }
    } catch (error) {
      logError(error)
    }
  }

  if (
    toolMatchesName(tool, BASH_TOOL_NAME) &&
    typeof parsedInput['command'] === 'string'
  ) {
    startSpeculativeClassifierCheck(
      parsedInput['command'],
      toolUseContext.getAppState().toolPermissionContext,
      toolUseContext.abortController.signal,
      toolUseContext.options.isNonInteractiveSession,
    )
  }

  const permissionMode = toolUseContext.getAppState().toolPermissionContext.mode
  const preHooksStartedAt = Date.now()
  let hookCount = 0
  let hookPermissionResult: HookPermissionOutcome | undefined
  let hookUpdatedInput: AnyObject | undefined
  let preventContinuation = false
  let stopReason: string | undefined
  let stopped = false
  const additionalContextMessages: Message[] = []

  for await (const item of runPreToolUseHooks(
    tool,
    toolUseID,
    observableInput,
    toolUseContext,
    permissionMode,
    signal,
    hookSeam,
  ) as AsyncGenerator<PreToolUseHookItem>) {
    hookCount++
    switch (item.kind) {
      case 'message':
        push({ message: item.message })
        break
      case 'permissionResult':
        hookPermissionResult = item.result
        break
      case 'updatedInput':
        hookUpdatedInput = item.updatedInput
        break
      case 'preventContinuation':
        preventContinuation = true
        break
      case 'stopReason':
        stopReason = item.stopReason
        break
      case 'additionalContext':
        additionalContextMessages.push(item.message as never)
        break
      case 'stop':
        stopped = true
        break
    }
    if (stopped) break
  }

  const preHookDuration = Date.now() - preHooksStartedAt
  try {
    getStatsStore()?.observe(PRE_TOOL_HOOK_DURATION_METRIC, preHookDuration)
  } catch {
  }
  if (preHookDuration > SLOW_PHASE_THRESHOLD_MS) {
    logForDebugging(
      `pre-tool hooks for ${tool.name} took ${preHookDuration}ms (${hookCount} hook results)`,
    )
  }

  for (const message of additionalContextMessages) {
    push({ message })
  }

  if (stopped) {
    traceOnce({ ok: false })
    const block = createToolResultStopMessage(toolUseID)
    push({
      message: createUserMessage({
        content: [block] as never,
        toolUseResult: stopReason ?? CANCEL_MESSAGE,
        sourceToolAssistantUUID: sourceUUID as never,
      }),
    })
    return
  }

  if (signal.aborted) {
    traceOnce({ ok: false })
    push(interruptResultUpdate(toolUseID, sourceUUID))
    return
  }

  const decisionStartedAt = Date.now()
  const workingInputBeforeDecision = hookUpdatedInput ?? observableInput
  const { decision, input: inputAfterDecision } = await resolveHookPermissionDecision(
    hookPermissionResult,
    tool,
    workingInputBeforeDecision,
    toolUseContext,
    canUseTool,
    assistantMessage,
    toolUseID,
  )
  const decisionDuration = Date.now() - decisionStartedAt
  if (decisionDuration > SLOW_PHASE_THRESHOLD_MS && permissionMode === 'flow') {
    logForDebugging(
      `permission decision for ${tool.name} took ${decisionDuration}ms (mode ${permissionMode}) → ${decision.behavior}`,
    )
  }

  const decisionReason = (decision as { decisionReason?: { type?: string; hookName?: string } })
    .decisionReason
  if (
    decisionReason?.type === 'hook' &&
    decisionReason.hookName?.includes(PERMISSION_REQUEST_HOOK_NAME) &&
    decision.behavior !== 'ask'
  ) {
    push({
      message: createAttachmentMessage({
        type: 'hook_permission_decision',
        decision: decision.behavior === 'allow' ? 'allow' : 'deny',
        toolUseID,
        hookEvent: PERMISSION_REQUEST_HOOK_NAME,
      } as never),
    })
  }

  if (decision.behavior !== 'allow') {
    traceOnce({ ok: false })
    const decisionMessage = (decision as { message?: string }).message
    const baseComposed =
      decisionMessage ??
      (preventContinuation
        ? `Tool execution was stopped by a pre-tool hook${stopReason ? `: ${stopReason}` : ''}`
        : `Permission to use ${tool.name} was denied.`)
    const cannotPrompt =
      toolUseContext.options.isNonInteractiveSession === true ||
      toolUseContext.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts === true
    const headlessAskNote =
      decision.behavior === 'ask' && cannotPrompt
        ? `\n\nThis session runs headless and cannot ask for approval, so the request was auto-denied — it was not run. To allow it, pre-approve the tool at launch with --allowedTools (for example --allowedTools "${tool.name}"), or start in a permission mode that does not stop here with --permission-mode. (Interactive-only shortcuts such as the "!" prefix do not apply to a headless run.)`
        : ''
    const composed = `${baseComposed}${headlessAskNote}`
    const rejectionBlocks = decision.behavior === 'ask' ? (decision.contentBlocks ?? []) : []
    const imageCount = rejectionBlocks.filter(isImageBlock).length
    const imagePasteIds =
      imageCount > 0 ? nextImagePasteIds(toolUseContext.messages, imageCount) : undefined
    push(
      errorResultUpdate({
        toolUseID,
        content: composed,
        toolUseResult: `Error: ${composed}`,
        sourceToolAssistantUUID: sourceUUID,
        extraBlocks: rejectionBlocks,
        imagePasteIds,
      }),
    )
    logForDebugging(`tool use refused: ${tool.name}`)
    return
  }

  const decisionUpdatedInput = (decision as { updatedInput?: AnyObject }).updatedInput
  let workingInput = decisionUpdatedInput ?? workingInputBeforeDecision

  if (signal.aborted) {
    traceOnce({ ok: false })
    push(interruptResultUpdate(toolUseID, sourceUUID))
    return
  }

  let callInput = workingInput
  if (workingInput === observableInput || workingInput === parsedInput) {
    callInput = parsedInput
  } else if (
    backfilledPath !== undefined &&
    typeof workingInput.file_path === 'string' &&
    workingInput.file_path === backfilledPath
  ) {
    callInput = { ...workingInput, file_path: parsedInput.file_path }
  }

  const executionRecord = toolUseContext.toolDecisions?.get(toolUseID)
  void executionRecord
  const executionStartedAt = Date.now()
  startSessionActivity(TOOL_EXEC_ACTIVITY)

  let executed = false
  let success = true
  let durationMs: number | undefined
  let result: ToolResult<unknown> | undefined

  try {
    observeToolStart({
      owner: ownerFromToolUseContext(toolUseContext),
      toolName: tool.name,
      toolUseId: toolUseID,
    })

    executed = true
    const contextForCall: ToolUseContext = {
      ...toolUseContext,
      toolUseId: toolUseID,
      userModifiedInput: (decision as { userModified?: boolean }).userModified,
    }
    result = await tool.call(
      callInput as never,
      contextForCall,
      canUseTool as never,
      assistantMessage,
      progress => {
        push({
          message: createProgressMessage({
            toolUseID: progress.toolUseID,
            parentToolUseID: toolUseID,
            data: progress.data as never,
          }),
        })
      },
    )
    durationMs = Date.now() - executionStartedAt

    try {
      addToToolDuration(durationMs)
    } catch {
    }
    const effect = result.effect
    const changeIntent = result.changeIntent
    const structuredOutput = (result as { structured_output?: unknown }).structured_output
    if (structuredOutput !== undefined) {
      push({
        message: createAttachmentMessage({
          type: 'structured_output',
          data: structuredOutput,
        } as never),
      })
    }
    success = effect?.outcome === 'failed' ? false : true
    const dataRecord =
      typeof result.data === 'object' && result.data !== null
        ? (result.data as { backgroundTaskId?: unknown })
        : undefined
    const isLaunch =
      (tool.name === 'Bash' || tool.name === 'PowerShell') &&
      typeof dataRecord?.backgroundTaskId === 'string'

    let mappedBlock = tool.mapToolResultToToolResultBlockParam(
      result.data as never,
      toolUseID,
    )
    try {
      await clampToolResultImageBlocks(mappedBlock as never)
    } catch (error) {
      logError(error)
    }
    if (effect?.outcome === 'failed') {
      mappedBlock = { ...mappedBlock, is_error: true }
    }

    const isSubagent =
      toolUseContext.agentId !== undefined && toolUseContext.preserveToolResults !== true

    const acceptFeedback = (decision as { acceptFeedback?: string }).acceptFeedback
    const allowBlocks = (decision as { contentBlocks?: unknown[] }).contentBlocks ?? []

    const buildResultUpdate = async (
      blockForEmission: ToolResultBlockParam,
      preMapped: boolean,
    ): Promise<MessageUpdateLazy> => {
      const processed = preMapped
        ? await processPreMappedToolResultBlock(
            blockForEmission,
            tool.name,
            tool.maxResultSizeChars,
          )
        : await processToolResultBlock(tool as never, result!.data, toolUseID)
      const blocks: unknown[] = [processed]
      if (acceptFeedback) blocks.push({ type: 'text', text: acceptFeedback })
      blocks.push(...allowBlocks)
      const imageCount = allowBlocks.filter(isImageBlock).length
      const imagePasteIds =
        imageCount > 0 ? nextImagePasteIds(toolUseContext.messages, imageCount) : undefined
      return {
        message: createUserMessage({
          content: blocks as never,
          ...(isSubagent ? {} : { toolUseResult: result!.data }),
          ...(isSubagent || result!.mcpMeta === undefined
            ? {}
            : { mcpMeta: result!.mcpMeta }),
          sourceToolAssistantUUID: sourceUUID as never,
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

    const postHookMessages: Message[] = []
    if (tool.isMcp) {
      let output = result.data
      const postStartedAt = Date.now()
      let postHookCount = 0
      for await (const item of runPostToolUseHooks(
        tool,
        toolUseID,
        observableInput,
        output,
        toolUseContext,
        permissionMode,
        signal,
        hookSeam,
      )) {
        postHookCount++
        if (item.kind === 'updatedOutput') {
          output = item.output
        } else {
          postHookMessages.push(item.message)
        }
      }
      const postDuration = Date.now() - postStartedAt
      if (postDuration > SLOW_PHASE_THRESHOLD_MS) {
        logForDebugging(
          `post-tool hooks for ${tool.name} took ${postDuration}ms (${postHookCount} hook results)`,
        )
      }
      result = { ...result, data: output }
      const remapped = tool.mapToolResultToToolResultBlockParam(output as never, toolUseID)
      push(await buildResultUpdate(remapped, false))
      for (const message of postHookMessages) {
        push({ message })
      }
    } else {
      push(await buildResultUpdate(mappedBlock, true))
      const postStartedAt = Date.now()
      let postHookCount = 0
      for await (const item of runPostToolUseHooks(
        tool,
        toolUseID,
        observableInput,
        result.data,
        toolUseContext,
        permissionMode,
        signal,
        hookSeam,
      )) {
        postHookCount++
        if (item.kind === 'message') push({ message: item.message })
      }
      const postDuration = Date.now() - postStartedAt
      if (postDuration > SLOW_PHASE_THRESHOLD_MS) {
        logForDebugging(
          `post-tool hooks for ${tool.name} took ${postDuration}ms (${postHookCount} hook results)`,
        )
      }
    }

    for (const message of result.newMessages ?? []) {
      push({ message })
    }
    if (preventContinuation) {
      push({
        message: createAttachmentMessage({
          type: 'hook_stopped_continuation',
          content: stopReason ?? 'Tool execution was stopped by a pre-tool hook',
          hookName: `PreToolUse:${tool.name}`,
          toolUseID,
          hookEvent: 'PreToolUse',
        } as never),
      })
    }
  } catch (error) {
    durationMs = Date.now() - executionStartedAt
    success = false
    try {
      addToToolDuration(durationMs)
    } catch {
    }
    const isInterrupt = isAbortError(error)
    const message = error instanceof Error ? error.message : String(error)

    if (error instanceof McpAuthError) {
      try {
        flipMcpClientToNeedsAuth(tool, toolUseContext)
      } catch (flipError) {
        logError(flipError)
      }
    }
    if (!isInterrupt) {
      logForDebugging(
        `tool ${tool.name} failed after ${durationMs}ms: ${message.slice(0, 200)}`,
      )
      if (!(error instanceof ShellError)) {
        logError(error)
      }
    }

    const failureHookMessages: Message[] = []
    for await (const item of runPostToolUseFailureHooks(
      tool,
      toolUseID,
      observableInput,
      message,
      isInterrupt,
      toolUseContext,
      permissionMode,
      signal,
      hookSeam,
    )) {
      failureHookMessages.push(item.message)
    }

    const isSubagent =
      toolUseContext.agentId !== undefined && toolUseContext.preserveToolResults !== true
    const mcpMeta = (error as { mcpMeta?: { _meta?: Record<string, unknown> } }).mcpMeta
    const modelFacingText = formatError(error)
    push({
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: toolUseError(modelFacingText),
            is_error: true,
            tool_use_id: toolUseID,
          },
        ] as never,
        toolUseResult: `Error: ${message}`,
        ...(isSubagent || mcpMeta === undefined ? {} : { mcpMeta }),
        sourceToolAssistantUUID: sourceUUID as never,
      }),
    })
    for (const failureMessage of failureHookMessages) {
      push({ message: failureMessage })
    }
  } finally {
    if (executed) {
      traceOnce({ durationMs, ok: success })
      try {
        try {
          const op = result?.effect?.operation
          if (tool.name === 'Edit' && op === 'file.edit') {
            const { recordEditOutcome } = await import('../changeTransaction/editOutcomeLedger.js')
            const outcome =
              result!.effect!.outcome === 'succeeded'
                ? 'applied'
                : result!.effect!.outcome === 'no-change'
                  ? 'no-change'
                  : `error-${result!.effect!.outcome}`
            recordEditOutcome(
              ownerFromToolUseContext(toolUseContext),
              toolUseContext.options.mainLoopModel,
              'edit',
              outcome,
            )
          }
        } catch {
        }
        observeToolTerminal({
          owner: ownerFromToolUseContext(toolUseContext),
          toolName: tool.name,
          toolUseId: toolUseID,
          input: observableInput,
          ok: success,
          durationMs,
          effect: result?.effect,
          ...(result?.changeIntent !== undefined
            ? { intentProjection: result.changeIntent }
            : {}),
          cwd: getCwd(),
          ...(result !== undefined &&
          typeof result.data === 'object' &&
          result.data !== null &&
          typeof (result.data as { backgroundTaskId?: unknown }).backgroundTaskId ===
            'string' &&
          (tool.name === 'Bash' || tool.name === 'PowerShell')
            ? { lifecycle: 'launch' as const }
            : {}),
        })
      } catch {
      }
    } else {
      traceOnce({ ok: false })
    }
    stopSessionActivity(TOOL_EXEC_ACTIVITY)
    toolUseContext.toolDecisions?.delete(toolUseID)
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


function mcpServerConnectionFacts(
  tool: Pick<Tool, 'name'> & { mcpInfo?: { serverName: string } },
  clients: readonly unknown[],
): { serverType: string | undefined; serverUrl: string | undefined } {
  const absent = { serverType: undefined, serverUrl: undefined }
  try {
    const toolName = tool.name
    const known = tool.mcpInfo?.serverName
    if (known === undefined && !toolName.startsWith('mcp__')) return absent
    const info = known !== undefined ? { serverName: normalizeNameForMCP(known) } : (mcpInfoFromString(toolName) as { serverName?: string } | null | undefined)
    const serverName = info?.serverName
    if (!serverName) return absent
    for (const raw of clients) {
      const client = raw as {
        name?: unknown
        type?: unknown
        config?: McpServerConfig
      }
      if (client?.type !== 'connected') continue
      if (typeof client.name !== 'string') continue
      if (normalizeNameForMCP(client.name) !== serverName) continue
      const kind = typeof client.config?.type === 'string' ? client.config.type : 'stdio'
      const url = client.config !== undefined ? getLoggingSafeMcpBaseUrl(client.config) : undefined
      return { serverType: kind, serverUrl: url }
    }
    return absent
  } catch {
    return absent
  }
}

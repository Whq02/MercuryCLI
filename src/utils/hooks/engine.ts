import { randomUUID } from 'crypto'
import chalk from 'chalk'
import type { HookEvent, HookInput, HookJSONOutput, SyncHookJSONOutput } from './contract.js'
import { hookEventTable } from './contract.js'
import { getStatsStore, addToTurnHookDuration, getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { recordHookFailure } from '../../extensions/health.js'
import { errorMessage } from '../errors.js'
import { all } from '../generators.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import { emitHookResponse, emitHookStarted, withHookRunContext, getHookRunContext, type HookProgressEvent } from './hookEvents.js'
import { execAgentHook } from './execAgentHook.js'
import { execHttpHook } from './execHttpHook.js'
import { execPromptHook } from './execPromptHook.js'
import { getSessionHookCallback, type FunctionHook, type FunctionHookPass } from './sessionHooks.js'
import { getHookDisplayText, retireOnceHookFromSettings } from './hooksSettings.js'
import { shouldDisableAllHooksIncludingManaged, updateHooksConfigSnapshot } from './hooksConfigSnapshot.js'
import { type HookCallback, type PromptRequest, type PromptResponse, isAsyncHookJSONOutput, isSyncHookJSONOutput } from '../../types/hooks.js'
import { isEnvTruthy } from '../envUtils.js'
import type { PermissionResult } from '../permissions/PermissionResult.js'
import { findToolByName, type Tool, type ToolUseContext } from '../../Tool.js'
import { execCommandHook, shouldSkipHookDueToTrust, TOOL_HOOK_EXECUTION_TIMEOUT_MS, createBaseHookInput } from './execution.js'
import { getMatchingHooks, isInternalHook } from './matching.js'
import { parseHookOutput, parseHttpHookOutput, processHookJSONOutput } from './outputProcessing.js'
import type { AggregatedHookResult, HookResult, HookLifecycleResult } from './types.js'
import type { Message } from '../../types/message.js'
import type { HookCommand } from '../settings/types.js'

type Match = Awaited<ReturnType<typeof getMatchingHooks>>[number]
type Execution = Parameters<typeof executeHooks>[0]
type Invocation = Execution & {
  hook: Match['hook']
  extensionRoot?: string
  extensionId?: string
  skillRoot?: string
  hookIndex: number
  hookName: string
  hookId: string
  hookEvent: HookEvent
  command: string
  startedAt: number
  timeoutMs: number
  getJsonInput: () => string
  request: ((request: PromptRequest) => Promise<PromptResponse>) | undefined
}

function retireOnceHookAfterRun(hook: HookCommand, hookEvent: HookEvent): void {
  try {
    const source = retireOnceHookFromSettings(hookEvent, hook)
    if (source !== null) {
      updateHooksConfigSnapshot()
      logForDebugging(`once hook retired from ${source} after its run: ${getHookDisplayText(hook)} (${hookEvent})`)
    } else {
      logForDebugging(`once hook ran but no editable settings entry was found to retire: ${getHookDisplayText(hook)} (${hookEvent})`)
    }
  } catch (error) {
    logForDebugging(`once hook retirement failed: ${String(error)}`)
  }
}

function errorOutcome(run: Invocation, stderr: string, stdout = '', exitCode = 1): HookResult {
  return {
    message: createAttachmentMessage({ type: 'hook_non_blocking_error', hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent, stderr, stdout, exitCode, command: run.command, durationMs: Date.now() - run.startedAt }),
    outcome: 'non_blocking_error',
    hook: run.hook,
    lifecycle: { command: run.command, succeeded: false, output: stderr, blocked: false },
  }
}

function response(run: Invocation, output: string, stdout: string, stderr: string, outcome: 'success' | 'error' | 'cancelled', exitCode?: number): void {
  emitHookResponse({ hookId: run.hookId, hookName: run.hookName, hookEvent: run.hookEvent, output, stdout, stderr, outcome, exitCode })
}

function lifecycleOf(run: Invocation, json: HookJSONOutput | undefined, raw: string, succeeded: boolean, blocked: boolean): HookLifecycleResult {
  const sync = json && isSyncHookJSONOutput(json) ? json : undefined
  const specific = sync?.hookSpecificOutput
  const output = run.hook.type !== 'command' && run.hookEvent === 'WorktreeCreate'
    ? specific?.hookEventName === 'WorktreeCreate' ? specific.worktreePath : ''
    : raw
  return {
    command: run.command,
    succeeded,
    output,
    blocked: blocked || sync?.decision === 'block',
    ...(run.hook.type === 'command' ? { watchPaths: specific && 'watchPaths' in specific ? specific.watchPaths : undefined, systemMessage: sync?.systemMessage } : {}),
  }
}

function processedOutcome(run: Invocation, json: SyncHookJSONOutput, stdout?: string, stderr?: string, exitCode?: number): Partial<HookResult> {
  return processHookJSONOutput({ json, command: run.command, hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent, expectedHookEvent: run.hookEvent, stdout, stderr, exitCode, durationMs: Date.now() - run.startedAt })
}

async function commandTransport(run: Invocation): Promise<HookResult> {
  const hook = run.hook as HookCommand & { type: 'command' }
  const timeoutMs = hook.timeout ? hook.timeout * 1000 : run.timeoutMs
  const combined = createCombinedAbortSignal(run.signal, { timeoutMs })
  try {
    const jsonInput = run.getJsonInput()
    emitHookStarted(run.hookId, run.hookName, run.hookEvent)
    const result = await execCommandHook(hook, run.hookEvent, run.hookName, jsonInput, combined.signal, run.hookId, run.hookIndex, run.extensionRoot, run.extensionId, run.skillRoot, run.forceSyncExecution, run.request)
    if (hook.once === true && !run.extensionRoot && !run.skillRoot && !(result.aborted && run.signal?.aborted === true)) retireOnceHookAfterRun(hook, run.hookEvent)
    if (result.backgrounded) return { outcome: 'success', hook, lifecycle: lifecycleOf(run, undefined, '', true, false) }
    if (result.aborted) {
      if (run.signal?.aborted !== true) {
        const seconds = Math.round(timeoutMs / 1000)
        const stderr = `hook timed out after ${seconds}s and was killed; the ${run.hookEvent} it guarded proceeded (a blocking guard must answer inside its own timeout)` + (result.stderr ? `\n${result.stderr}` : '')
        if (run.extensionId) recordHookFailure(run.extensionId, run.command, 'timeout')
        response(run, result.output, result.stdout, stderr, 'error', result.status)
        reportHeadlessHookFailure(`hook ${run.hookName} (${run.hookEvent}) timed out after ${seconds}s and was killed; the ${run.hookEvent} it guarded proceeded`, run)
        return { ...errorOutcome(run, stderr, result.stdout, result.status), lifecycle: { command: hook.command, succeeded: false, output: 'Hook cancelled', blocked: false } }
      }
      response(run, result.output, result.stdout, result.stderr, 'cancelled', result.status)
      return { message: createAttachmentMessage({ type: 'hook_cancelled', hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent, command: run.command, durationMs: Date.now() - run.startedAt }), outcome: 'cancelled', hook, lifecycle: { command: hook.command, succeeded: false, output: 'Hook cancelled', blocked: false } }
    }
    const parsed = parseHookOutput(result.stdout)
    if (parsed.validationError) {
      if (run.extensionId) recordHookFailure(run.extensionId, run.command, 'unparseable output')
      const stderr = `JSON validation failed: ${parsed.validationError}`
      response(run, result.output, result.stdout, stderr, 'error', 1)
      reportHeadlessHookFailure(`hook ${run.hookName} (${run.hookEvent}) returned JSON that failed validation: ${parsed.validationError.split('\n')[0]}`, run)
      return { ...errorOutcome(run, stderr, result.stdout), lifecycle: { command: hook.command, succeeded: false, output: parsed.validationError, blocked: false } }
    }
    const lifecycle = lifecycleOf(run, parsed.json, result.status === 0 ? result.stdout : result.stderr, result.status === 0, result.status === 2)
    if (parsed.json) {
      if (isAsyncHookJSONOutput(parsed.json)) return { outcome: 'success', hook, lifecycle }
      const processed = processedOutcome(run, parsed.json, result.stdout, result.stderr, result.status)
      response(run, result.output, result.stdout, result.stderr, result.status === 0 ? 'success' : 'error', result.status)
      if (isSyncHookJSONOutput(parsed.json) && !parsed.json.suppressOutput && parsed.plainText && result.status === 0) {
        return { ...processed, message: processed.message || createAttachmentMessage({ type: 'hook_success', hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent, content: `${chalk.bold(run.hookName)} completed`, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, command: run.command, durationMs: Date.now() - run.startedAt }), outcome: 'success', hook, lifecycle }
      }
      return { ...processed, outcome: 'success', hook, lifecycle }
    }
    response(run, result.output, result.stdout, result.stderr, result.status === 0 ? 'success' : 'error', result.status)
    if (result.status === 0) return { message: createAttachmentMessage({ type: 'hook_success', hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent, content: result.stdout.trim(), stdout: result.stdout, stderr: result.stderr, exitCode: result.status, command: run.command, durationMs: Date.now() - run.startedAt }), outcome: 'success', hook, lifecycle }
    if (result.status === 2) return { blockingError: { blockingError: `[${hook.command}]: ${result.stderr || 'No stderr output'}`, command: hook.command }, outcome: 'blocking', hook, lifecycle }
    if (run.extensionId) recordHookFailure(run.extensionId, run.command, `exit ${result.status}`)
    reportHeadlessHookFailure(`hook ${run.hookName} (${run.hookEvent}) failed with exit ${result.status ?? '?'}: ${result.stderr.trim() || 'no stderr output'}`, run)
    return { ...errorOutcome(run, `Failed with non-blocking status code: ${result.stderr.trim() || 'No stderr output'}`, result.stdout, result.status), lifecycle }
  } finally {
    combined.cleanup()
  }
}

async function httpTransport(run: Invocation): Promise<HookResult> {
  const hook = run.hook as HookCommand & { type: 'http' }
  const input = run.getJsonInput()
  emitHookStarted(run.hookId, run.hookName, run.hookEvent)
  const result = await execHttpHook(hook, run.hookEvent, input, run.signal)
  if (result.aborted) {
    response(run, 'Hook cancelled', '', '', 'cancelled')
    return { message: createAttachmentMessage({ type: 'hook_cancelled', hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent }), outcome: 'cancelled', hook, lifecycle: { command: hook.url, succeeded: false, output: 'Hook cancelled', blocked: false } }
  }
  if (hook.once === true && !run.extensionRoot && !run.skillRoot) retireOnceHookAfterRun(hook, run.hookEvent)
  if (result.error || !result.ok) {
    const stderr = result.error || `HTTP ${result.statusCode} from ${hook.url}`
    response(run, stderr, '', stderr, 'error', result.statusCode)
    return errorOutcome(run, stderr, '', result.statusCode ?? 0)
  }
  const parsed = parseHttpHookOutput(result.body)
  if (parsed.validationError) {
    const stderr = `JSON validation failed: ${parsed.validationError}`
    response(run, result.body, result.body, stderr, 'error', result.statusCode)
    return { ...errorOutcome(run, stderr, result.body, result.statusCode ?? 0), lifecycle: { command: hook.url, succeeded: false, output: parsed.validationError, blocked: false } }
  }
  const lifecycle = lifecycleOf(run, parsed.json, result.body, true, false)
  const processed = parsed.json && !isAsyncHookJSONOutput(parsed.json) ? processedOutcome(run, parsed.json, result.body, '', result.statusCode) : {}
  response(run, result.body, result.body, '', 'success', result.statusCode)
  return { ...processed, outcome: 'success', hook, lifecycle }
}

async function modelTransport(run: Invocation): Promise<HookResult> {
  const hook = run.hook as HookCommand & { type: 'prompt' | 'agent' }
  if (run.perHook && !run.toolUseContext) return { outcome: 'non_blocking_error', hook, lifecycle: { command: hook.prompt, succeeded: false, output: hook.type === 'prompt' ? 'Prompt stop hooks are not yet supported outside chat' : 'Agent stop hooks are not yet supported outside chat', blocked: false } }
  if (!run.toolUseContext) throw new Error(`ToolUseContext is required for ${hook.type} hooks. This is a bug.`)
  if (hook.type === 'agent' && !run.messages) throw new Error('Messages are required for agent hooks. This is a bug.')
  const combined = createCombinedAbortSignal(run.signal, { timeoutMs: hook.timeout ? hook.timeout * 1000 : run.timeoutMs })
  try {
    const input = run.getJsonInput()
    const result = hook.type === 'prompt'
      ? await execPromptHook(hook, run.hookName, run.hookEvent, input, combined.signal, run.toolUseContext, run.messages, run.toolUseID)
      : await execAgentHook(hook, run.hookName, run.hookEvent, input, combined.signal, run.toolUseContext, run.toolUseID, run.messages!, 'agent_type' in run.hookInput ? run.hookInput.agent_type : undefined)
    if (result.message?.type === 'attachment') {
      const att = result.message.attachment
      if (att.type === 'hook_success' || att.type === 'hook_non_blocking_error') { att.command = run.command; att.durationMs = Date.now() - run.startedAt }
    }
    if (hook.once === true && !run.extensionRoot && !run.skillRoot && run.signal?.aborted !== true) retireOnceHookAfterRun(hook, run.hookEvent)
    return result
  } finally {
    combined.cleanup()
  }
}

async function inProcessOutcome(run: Invocation): Promise<HookResult> {
  if (run.hook.type === 'callback') {
    const combined = createCombinedAbortSignal(run.signal, { timeoutMs: run.hook.timeout ? run.hook.timeout * 1000 : run.timeoutMs })
    try {
      return await executeHookCallback({ toolUseID: run.toolUseID, hook: run.hook, hookEvent: run.hookEvent, hookInput: run.hookInput, signal: combined.signal, hookIndex: run.hookIndex, toolUseContext: run.toolUseContext })
    } finally { combined.cleanup() }
  }
  const hook = run.hook as FunctionHook
  if (!run.messages) return { message: createAttachmentMessage({ type: 'hook_error_during_execution', hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent, content: 'Messages not provided for function hook' }), outcome: 'non_blocking_error', hook }
  return executeFunctionHook({ hook, messages: run.messages, hookName: run.hookName, toolUseID: run.toolUseID, hookEvent: run.hookEvent, timeoutMs: run.timeoutMs, signal: run.signal, hookInput: run.hookInput, tool: run.toolUseContext && 'tool_name' in run.hookInput ? findToolByName(run.toolUseContext.options.tools, run.hookInput.tool_name) : undefined })
}

async function inProcessTransport(run: Invocation): Promise<HookResult> {
  const visible = !(run.hook.type === 'callback' && run.hook.internal) && !(run.hook.type === 'function' && run.hook.silent)
  if (visible) emitHookStarted(run.hookId, run.hookName, run.hookEvent)
  const result = await inProcessOutcome(run)
  if (visible) {
    const output = result.lifecycle?.output ?? result.systemMessage ?? result.blockingError?.blockingError ?? ''
    response(run, output, output, '', result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'success' ? 'success' : 'error')
  }
  return result
}

const transportTable = {
  command: commandTransport,
  http: httpTransport,
  prompt: modelTransport,
  agent: modelTransport,
  in_process: inProcessTransport,
} satisfies Record<string, (run: Invocation) => Promise<HookResult>>

function* foldHookResult(result: HookResult, permission: PermissionResult['behavior'] | undefined, hookName: string, toolUseID: string, hookEvent: HookEvent, source?: string): Generator<AggregatedHookResult> {
  if (result.preventContinuation) yield { preventContinuation: true, stopReason: result.stopReason }
  if (result.blockingError) yield { blockingError: result.blockingError }
  if (result.message) yield { message: result.message }
  if (result.systemMessage) yield { message: createAttachmentMessage({ type: 'hook_system_message', content: result.systemMessage, hookName, toolUseID, hookEvent }) }
  if (result.additionalContext) yield { additionalContexts: [result.additionalContext] }
  if (result.initialUserMessage) yield { initialUserMessage: result.initialUserMessage }
  if (result.watchPaths?.length) yield { watchPaths: result.watchPaths }
  if (result.updatedMCPToolOutput) yield { updatedMCPToolOutput: result.updatedMCPToolOutput }
  if (permission !== undefined) yield { permissionBehavior: permission, hookPermissionDecisionReason: result.hookPermissionDecisionReason, hookSource: source, updatedInput: result.updatedInput && (result.permissionBehavior === 'allow' || result.permissionBehavior === 'ask') ? result.updatedInput : undefined }
  if (result.updatedInput && result.permissionBehavior === undefined) yield { updatedInput: result.updatedInput }
  if (result.permissionRequestResult) yield { permissionRequestResult: result.permissionRequestResult }
  if (result.retry) yield { retry: result.retry }
  if (result.elicitationResponse) yield { elicitationResponse: result.elicitationResponse }
  if (result.elicitationResultResponse) yield { elicitationResultResponse: result.elicitationResultResponse }
}

function permissionAfter(prior: PermissionResult['behavior'] | undefined, next: HookResult['permissionBehavior']): PermissionResult['behavior'] | undefined {
  if (next === 'deny') return 'deny'
  if (next === 'ask') return prior === 'deny' ? prior : 'ask'
  if (next === 'allow') return prior ?? 'allow'
  return prior
}

export async function* executeHooksPerHook(options: Parameters<typeof executeHooks>[0] & { perHook?: boolean }): AsyncGenerator<HookResult> {
  for await (const result of executeHooks({ ...options, perHook: true })) yield result as HookResult
}

export async function* executeHooks({
  hookInput, toolUseID, matchQuery, signal, timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS, toolUseContext, messages, forceSyncExecution, requestPrompt, toolInputSummary, perHook, getAppState,
}: {
  hookInput: HookInput
  toolUseID: string
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs?: number
  toolUseContext?: ToolUseContext
  messages?: Message[]
  forceSyncExecution?: boolean
  requestPrompt?: (sourceName: string, toolInputSummary?: string | null) => (request: PromptRequest) => Promise<PromptResponse>
  toolInputSummary?: string | null
  perHook?: boolean
  getAppState?: () => Parameters<typeof getMatchingHooks>[0]
}): AsyncGenerator<AggregatedHookResult> {
  if (shouldDisableAllHooksIncludingManaged() || isEnvTruthy(process.env.MERCURY_BARE)) return
  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent
  const trustAccepted = getHookRunContext()?.trustAccepted
  if (trustAccepted === false || (trustAccepted === undefined && shouldSkipHookDueToTrust())) {
    logForDebugging(`Skipping ${hookName} hook execution - workspace trust not accepted`)
    return
  }
  const appState = getAppState ? getAppState() : toolUseContext?.getAppState()
  const sessionId = toolUseContext?.agentId ?? hookInput.session_id
  const matched = await getMatchingHooks(appState, sessionId, hookEvent, hookInput, toolUseContext?.options?.tools)
  if (matched.length === 0 || signal?.aborted) return
  const startedAt = Date.now()
  if (matched.every(isInternalHook)) {
    const context = toolUseContext ? { getAppState: toolUseContext.getAppState, updateAttributionState: toolUseContext.updateAttributionState } : undefined
    for (const [index, { hook }] of matched.entries()) if (hook.type === 'callback') await hook.callback(hookInput, toolUseID, signal, index, context)
    const duration = Date.now() - startedAt
    getStatsStore()?.observe('hook_duration_ms', duration)
    addToTurnHookDuration(duration)
    return
  }
  if (!perHook) for (const { hook } of matched) {
    if (hook.type === 'function' && hook.silent) continue
    yield { message: { type: 'progress', data: { type: 'hook_progress', hookEvent, hookName, command: getHookDisplayText(hook), ...(hook.type === 'prompt' ? { promptText: hook.prompt } : {}), ...('statusMessage' in hook && hook.statusMessage != null ? { statusMessage: hook.statusMessage } : {}) }, parentToolUseID: toolUseID, toolUseID, timestamp: new Date().toISOString(), uuid: randomUUID() } }
  }
  let serialized: string | undefined
  const getJsonInput = (): string => serialized ??= jsonStringify(hookInput)
  const request = requestPrompt?.(hookName, toolInputSummary)
  const streams = matched.map(async function* (match, hookIndex): AsyncGenerator<HookResult> {
    const run: Invocation = { ...match, hookInput, toolUseID, matchQuery, signal, timeoutMs, toolUseContext, messages, forceSyncExecution, perHook, hookIndex, hookName, hookEvent, hookId: randomUUID(), command: getHookDisplayText(match.hook), startedAt: Date.now(), getJsonInput, request }
    try {
      const key = match.hook.type === 'callback' || match.hook.type === 'function' ? 'in_process' : match.hook.type
      yield await transportTable[key](run)
    } catch (error) {
      const detail = errorMessage(error)
      if (run.extensionId) recordHookFailure(run.extensionId, run.command, /abort|time/i.test(detail) ? 'timeout' : detail.slice(0, 80))
      response(run, `Failed to run: ${detail}`, '', `Failed to run: ${detail}`, 'error', 1)
      yield { ...errorOutcome(run, `Failed to run: ${detail}`), lifecycle: { command: run.command, succeeded: false, output: detail, blocked: false } }
    }
  })
  let permission: PermissionResult['behavior'] | undefined
  try {
    if (perHook) {
      const results = await Promise.all(streams.map(async stream => {
        const item = await stream.next()
        await stream.return(undefined as never)
        return item.done ? undefined : item.value
      }))
      for (const result of results) if (result) yield result as AggregatedHookResult
      return
    }
    for await (const result of all(streams)) {
      permission = permissionAfter(permission, result.permissionBehavior)
      yield* foldHookResult(result, permission, hookName, toolUseID, hookEvent, matched.find(match => match.hook === result.hook)?.hookSource)
      if (appState && result.hook.type !== 'callback' && result.outcome === 'success') {
        const entry = getSessionHookCallback(appState, sessionId, hookEvent, matchQuery ?? '', result.hook)
        try { entry?.onHookSuccess?.(result.hook, result as AggregatedHookResult) } catch (error) { logError(Error('Session hook success callback failed', { cause: error })) }
      }
    }
  } finally {
    const duration = Date.now() - startedAt
    getStatsStore()?.observe('hook_duration_ms', duration)
    addToTurnHookDuration(duration)
  }
}

export async function executeFunctionHook({ hook, messages, hookName, toolUseID, hookEvent, timeoutMs, signal, hookInput, tool }: {
  hook: FunctionHook
  messages: Message[]
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  timeoutMs: number
  signal?: AbortSignal
  hookInput?: HookInput
  tool?: Tool
}): Promise<HookResult> {
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, { timeoutMs: hook.timeout ?? timeoutMs })
  try {
    if (abortSignal.aborted) return { outcome: 'cancelled', hook }
    const passed = await new Promise<boolean | string | FunctionHookPass>((resolve, reject) => {
      const onAbort = () => reject(new Error('Function hook cancelled'))
      abortSignal.addEventListener('abort', onAbort)
      Promise.resolve(hook.callback(messages, abortSignal, { hookInput, tool })).then(resolve, reject).finally(() => abortSignal.removeEventListener('abort', onAbort))
    })
    if (passed === true) return { outcome: 'success', hook }
    if (typeof passed === 'object') return { outcome: 'success', hook, message: passed.note }
    return { blockingError: { blockingError: typeof passed === 'string' && passed.length > 0 ? passed : hook.errorMessage, command: 'function', silent: hook.silent }, outcome: 'blocking', hook }
  } catch (error) {
    if (error instanceof Error && (error.message === 'Function hook cancelled' || error.name === 'AbortError')) return { outcome: 'cancelled', hook }
    logError(error)
    return { message: createAttachmentMessage({ type: 'hook_error_during_execution', hookName, toolUseID, hookEvent, content: error instanceof Error ? error.message : 'Function hook execution error' }), outcome: 'non_blocking_error', hook }
  } finally { cleanup() }
}

export async function executeHookCallback({ toolUseID, hook, hookEvent, hookInput, signal, hookIndex, toolUseContext }: {
  toolUseID: string
  hook: HookCallback
  hookEvent: HookEvent
  hookInput: HookInput
  signal: AbortSignal
  hookIndex?: number
  toolUseContext?: ToolUseContext
}): Promise<HookResult> {
  const context = toolUseContext ? { getAppState: toolUseContext.getAppState, updateAttributionState: toolUseContext.updateAttributionState } : undefined
  const json = await hook.callback(hookInput, toolUseID, signal, hookIndex, context)
  if (isAsyncHookJSONOutput(json)) return { outcome: 'success', hook, lifecycle: { command: 'callback', succeeded: true, output: '', blocked: false } }
  const specific = json.hookSpecificOutput
  const lifecycle: HookLifecycleResult = { command: 'callback', succeeded: true, output: hookEvent === 'WorktreeCreate' && specific?.hookEventName === 'WorktreeCreate' ? specific.worktreePath : json.systemMessage || '', blocked: json.decision === 'block' }
  const processed = processHookJSONOutput({ json, command: 'callback', hookName: `${hookEvent}:Callback`, toolUseID, hookEvent, expectedHookEvent: hookEvent, stdout: undefined, stderr: undefined, exitCode: undefined })
  return { ...processed, outcome: 'success', hook, lifecycle }
}

function reportHeadlessHookFailure(line: string, run: Invocation): void {
  if (run.perHook || !getIsNonInteractiveSession()) return
  try { process.stderr.write(`${line}\n`) } catch {}
}

export async function* runHookEvent({ event, fields, toolUseID = randomUUID(), matchQuery, signal, timeoutMs, toolUseContext, messages, forceSyncExecution, requestPrompt, toolInputSummary, sessionId, cwd, transcriptPath, trustAccepted, getAppState, marks, perHook }: {
  event: HookEvent
  fields: Partial<Omit<HookInput, 'hook_event_name' | 'session_id' | 'transcript_path' | 'cwd'>>
  toolUseID?: string
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs?: number
  toolUseContext?: ToolUseContext
  messages?: Message[]
  forceSyncExecution?: boolean
  requestPrompt?: (sourceName: string, toolInputSummary?: string | null) => (request: PromptRequest) => Promise<PromptResponse>
  toolInputSummary?: string | null
  sessionId?: string
  cwd?: string
  transcriptPath?: string
  trustAccepted?: boolean
  getAppState?: () => Parameters<typeof getMatchingHooks>[0]
  marks?: {
    started: (mark: { hookId: string; hookName: string; hookEvent: HookEvent }) => void
    progress?: (mark: HookProgressEvent) => void
    response: (mark: { hookId: string; hookName: string; hookEvent: HookEvent; output: string; stdout: string; stderr: string; exitCode?: number; outcome: 'success' | 'error' | 'cancelled' }) => void
  }
  perHook?: boolean
}): AsyncGenerator<AggregatedHookResult | HookResult> {
  const record = fields as Record<string, unknown>
  const base = createBaseHookInput(record.permission_mode as string | undefined, sessionId, toolUseContext ? { agentId: toolUseContext.agentId, agentType: record.agent_type as string | undefined } : record.agent_id !== undefined || record.agent_type !== undefined ? { agentId: record.agent_id as string | undefined, agentType: record.agent_type as string | undefined } : undefined)
  const hookInput = { ...base, hook_event_name: event, ...record, session_id: base.session_id, cwd: cwd ?? base.cwd, transcript_path: transcriptPath ?? base.transcript_path } as HookInput
  yield* withHookRunContext({ sessionId: hookInput.session_id, cwd: hookInput.cwd, ...(trustAccepted !== undefined ? { trustAccepted } : {}), ...(marks ? { handler: emitted => { if (emitted.type === 'started') marks.started({ ...emitted, hookEvent: event }); else if (emitted.type === 'progress') marks.progress?.(emitted); else marks.response({ ...emitted, hookEvent: event }) } } : {}) }, executeHooks({ hookInput, toolUseID, matchQuery, signal, timeoutMs: timeoutMs ?? hookEventTable[event].timeoutMs ?? TOOL_HOOK_EXECUTION_TIMEOUT_MS, toolUseContext, messages, forceSyncExecution, requestPrompt, toolInputSummary, perHook, getAppState }))
}

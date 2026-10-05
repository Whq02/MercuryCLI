import type { AsyncHookJSONOutput, HookEvent } from './contract.js'

import type { ShellCommand } from '../ShellCommand.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { jsonParse } from '../slowOperations.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { emitHookResponse, hookProgressReporter } from './hookEvents.js'


export type PendingAsyncHookEvent = HookEvent | 'FileSuggestion'

type PendingAsyncHook = {
  processId: string
  hookId: string
  hookName: string
  hookEvent: PendingAsyncHookEvent
  toolName?: string
  extensionId?: string
  command: string
  startTime: number
  timeout: number
  responseAttachmentSent: boolean
  shellCommand: ShellCommand | undefined
  stopProgressInterval: () => void
}

export type AsyncHookResponsePayload = {
  processId: string
  response: Record<string, unknown>
  hookName: string
  hookEvent: PendingAsyncHookEvent
  toolName?: string
  extensionId?: string
  stdout: string
  stderr: string
  exitCode: number | undefined
}

const DEFAULT_ASYNC_TIMEOUT_MS = 15_000

const registry = new Map<string, PendingAsyncHook>()
const completionMarks = new WeakMap<PendingAsyncHook, Promise<void>>()

export function registerPendingAsyncHook(params: {
  processId: string
  hookId: string
  asyncResponse: AsyncHookJSONOutput
  hookEvent: PendingAsyncHookEvent
  hookName: string
  command: string
  shellCommand: ShellCommand | undefined
  extensionId?: string
  toolName?: string
  subscribeProgress?: (observer: (snapshot: { stdout: string; stderr: string; output: string }) => void) => () => void
}): void {
  const timeoutMs = params.asyncResponse.asyncTimeout || DEFAULT_ASYNC_TIMEOUT_MS
  const reportProgress = hookProgressReporter({
    hookId: params.hookId,
    hookName: params.hookName,
    hookEvent: params.hookEvent,
  })
  const unsubscribe = params.subscribeProgress?.(reportProgress) ?? (() => {})
  const entry: PendingAsyncHook = {
    processId: params.processId,
    hookId: params.hookId,
    hookName: params.hookName,
    hookEvent: params.hookEvent,
    ...(params.toolName !== undefined ? { toolName: params.toolName } : {}),
    ...(params.extensionId !== undefined ? { extensionId: params.extensionId } : {}),
    command: params.command,
    startTime: Date.now(),
    timeout: timeoutMs,
    responseAttachmentSent: false,
    shellCommand: params.shellCommand,
    stopProgressInterval: unsubscribe,
  }
  registry.set(params.processId, entry)
  if (params.shellCommand) {
    const completion = params.shellCommand.result.then(result => finalizeEntry(params.processId, entry, result.code, params.shellCommand?.status === 'killed' ? 'cancelled' : result.code === 0 ? 'success' : 'error')).catch(logError)
    completionMarks.set(entry, completion)
  }
  logForDebugging(
    `async hook registered: pid ${params.processId}, ${params.hookName}, timeout ${timeoutMs}ms`,
  )
}


function finalizeEntry(
  processId: string,
  entry: PendingAsyncHook,
  exitCode: number | undefined,
  outcome: 'success' | 'error' | 'cancelled',
): Promise<void> {
  entry.stopProgressInterval()
  const taskOutput = entry.shellCommand?.taskOutput
  const finalize = async (): Promise<void> => {
    const stdout = taskOutput ? await taskOutput.getStdout() : ''
    const stderr = taskOutput ? taskOutput.getStderr() : ''
    emitHookResponse({
      hookId: entry.hookId,
      hookName: entry.hookName,
      hookEvent: entry.hookEvent,
      output: stdout + stderr,
      stdout,
      stderr,
      exitCode,
      outcome,
    })
  }
  void processId
  return finalize()
}

function parseDecisionFromOutput(fullOutput: string): Record<string, unknown> {
  for (const line of fullOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = jsonParse(trimmed)
      if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
        logForDebugging(`async hook candidate line failed to parse: ${trimmed.slice(0, 120)}`)
        continue
      }
      const record = parsed as Record<string, unknown>
      if ('async' in record) continue
      return record
    } catch (error) {
      logForDebugging(
        `async hook candidate line threw while parsing: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
  }
  return {}
}

export async function checkForAsyncHookResponses(): Promise<AsyncHookResponsePayload[]> {
  const snapshot = [...registry.entries()]
  logForDebugging(`async hook poll: ${snapshot.length} pending`)
  const removals: string[] = []
  const payloads: AsyncHookResponsePayload[] = []
  let sessionStartAnswered = false

  await Promise.all(
    snapshot.map(async ([processId, entry]) => {
      try {
        const taskOutput = entry.shellCommand?.taskOutput
        const tailStdout = taskOutput ? await taskOutput.getStdout() : ''
        const tailStderr = taskOutput ? taskOutput.getStderr() : ''

        if (!entry.shellCommand) {
          entry.stopProgressInterval()
          removals.push(processId)
          return
        }
        if (entry.shellCommand.status === 'killed') {
          entry.stopProgressInterval()
          entry.shellCommand.cleanup()
          removals.push(processId)
          return
        }
        if (entry.shellCommand.status !== 'completed') {
          return
        }
        if (entry.responseAttachmentSent || tailStdout.trim() === '') {
          entry.stopProgressInterval()
          removals.push(processId)
          return
        }

        const fullOutput = await entry.shellCommand.taskOutput.getStdoutForDecision()
        const response = parseDecisionFromOutput(fullOutput)
        const result = await entry.shellCommand.result
        const exitCode = result.code
        entry.responseAttachmentSent = true
        const completion = completionMarks.get(entry)
        if (completion) await completion
        else await finalizeEntry(processId, entry, exitCode, exitCode === 0 ? 'success' : 'error')
        if (entry.hookEvent === 'SessionStart') sessionStartAnswered = true
        removals.push(processId)
        payloads.push({
          processId,
          response,
          hookName: entry.hookName,
          hookEvent: entry.hookEvent,
          ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
          ...(entry.extensionId !== undefined ? { extensionId: entry.extensionId } : {}),
          stdout: tailStdout,
          stderr: tailStderr,
          exitCode,
        })
      } catch (error) {
        logError(error)
      }
    }),
  )

  for (const processId of removals) {
    registry.get(processId)?.shellCommand?.cleanup()
    registry.delete(processId)
  }
  if (sessionStartAnswered) invalidateSessionEnvCache()
  logForDebugging(`async hook poll done: ${registry.size} still pending`)
  return payloads
}

export function removeDeliveredAsyncHooks(processIds: string[]): void {
  for (const processId of processIds) {
    const entry = registry.get(processId)
    if (!entry || !entry.responseAttachmentSent) continue
    entry.stopProgressInterval()
    registry.delete(processId)
  }
}

export async function finalizePendingAsyncHooks(): Promise<void> {
  const snapshot = [...registry.entries()]
  await Promise.all(
    snapshot.map(async ([processId, entry]) => {
      try {
        if (!entry.shellCommand) {
          entry.stopProgressInterval()
          return
        }
        if (entry.shellCommand.status !== 'completed' && entry.shellCommand.status !== 'killed') entry.shellCommand.kill()
        const result = await entry.shellCommand.result
        const completion = completionMarks.get(entry)
        if (completion) await completion
        else await finalizeEntry(processId, entry, result.code, entry.shellCommand.status === 'killed' ? 'cancelled' : result.code === 0 ? 'success' : 'error')
        entry.shellCommand.cleanup()
      } catch (error) {
        logError(error)
      }
    }),
  )
  registry.clear()
}

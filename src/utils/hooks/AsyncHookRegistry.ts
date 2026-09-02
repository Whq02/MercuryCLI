import type { AsyncHookJSONOutput, HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { ShellCommand } from '../ShellCommand.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { jsonParse } from '../slowOperations.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { emitHookResponse, startHookProgressInterval } from './hookEvents.js'

/**
 * Registry + polling for hooks that answered asynchronously: the initial
 * run returned an async marker, the shell process keeps running, and the
 * real response is collected later from its stdout.
 */

/**
 * The stored event type is deliberately wider than the hook-event
 * vocabulary: the status-line and file-suggestion producers use this
 * registry too.
 */
export type PendingAsyncHookEvent = HookEvent | 'FileSuggestion'

export type PendingAsyncHook = {
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
}): void {
  // `||` on purpose: a declared timeout of 0 still takes the default.
  const timeoutMs = params.asyncResponse.asyncTimeout || DEFAULT_ASYNC_TIMEOUT_MS
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
    // The getter re-reads the entry FROM the registry each tick, so a
    // removed entry stops producing output immediately.
    stopProgressInterval: startHookProgressInterval({
      hookId: params.hookId,
      hookName: params.hookName,
      hookEvent: params.hookEvent,
      getOutput: async () => {
        const live = registry.get(params.processId)
        const taskOutput = live?.shellCommand?.taskOutput
        if (!taskOutput) return { stdout: '', stderr: '', output: '' }
        const stdout = await taskOutput.getStdout()
        const stderr = taskOutput.getStderr()
        return { stdout, stderr, output: stdout + stderr }
      },
    }),
  }
  registry.set(params.processId, entry)
  logForDebugging(
    `async hook registered: pid ${params.processId}, ${params.hookName}, timeout ${timeoutMs}ms`,
  )
}

/** Only entries whose attachment has not yet been sent. */
export function getPendingAsyncHooks(): PendingAsyncHook[] {
  return [...registry.values()].filter(entry => !entry.responseAttachmentSent)
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
    entry.shellCommand?.cleanup()
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

/**
 * The decision is parsed from the FULL bounded stdout through the dedicated
 * accessor, never from the tail view used for prompt context — the tail
 * view drops a response that is more than five lines back, larger than
 * 4 KB, or straddling a chunk boundary, silently turning it into an empty
 * decision. The delivered payload still carries the tail view so prompt
 * context stays bounded.
 */
function parseDecisionFromOutput(fullOutput: string): Record<string, unknown> {
  for (const line of fullOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    // Each candidate line parses inside its own try/catch: an unparseable
    // candidate logs and is skipped, and scanning continues.
    try {
      const parsed = jsonParse(trimmed)
      if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
        logForDebugging(`async hook candidate line failed to parse: ${trimmed.slice(0, 120)}`)
        continue
      }
      const record = parsed as Record<string, unknown>
      // The FIRST parsed object without an `async` KEY (presence test) is
      // the real response.
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

/**
 * Snapshot and process every entry in parallel, failures isolated so one
 * throwing entry cannot orphan side effects already applied to others.
 */
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
          // Still pending.
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
        await finalizeEntry(processId, entry, exitCode, exitCode === 0 ? 'success' : 'error')
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
        // Log only: the entry stays in the registry (interval running) for
        // the next poll — a transient throw must not drop the response.
        logError(error)
      }
    }),
  )

  for (const processId of removals) registry.delete(processId)
  // A SessionStart hook's output may have exported variables.
  if (sessionStartAnswered) invalidateSessionEnvCache()
  logForDebugging(`async hook poll done: ${registry.size} still pending`)
  return payloads
}

/** Delete, by process id, only entries whose attachment flag is set. */
export function removeDeliveredAsyncHooks(processIds: string[]): void {
  for (const processId of processIds) {
    const entry = registry.get(processId)
    if (!entry || !entry.responseAttachmentSent) continue
    entry.stopProgressInterval()
    registry.delete(processId)
  }
}

/** At shutdown: settle completed commands with their real code; kill the rest. */
export async function finalizePendingAsyncHooks(): Promise<void> {
  const snapshot = [...registry.entries()]
  await Promise.all(
    snapshot.map(async ([processId, entry]) => {
      try {
        if (!entry.shellCommand) {
          entry.stopProgressInterval()
          return
        }
        if (entry.shellCommand.status === 'completed') {
          const result = await entry.shellCommand.result
          await finalizeEntry(processId, entry, result.code, result.code === 0 ? 'success' : 'error')
          return
        }
        if (entry.shellCommand.status !== 'killed') {
          entry.shellCommand.kill()
        }
        await finalizeEntry(processId, entry, 1, 'cancelled')
      } catch (error) {
        logError(error)
      }
    }),
  )
  registry.clear()
}

/** Test-only: stop every interval and empty the registry. */
export function clearAllAsyncHooks(): void {
  for (const entry of registry.values()) entry.stopProgressInterval()
  registry.clear()
}

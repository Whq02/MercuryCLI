// The outside-REPL hook runner — parallel execution for lifecycle events
// that run without the REPL's generator loop (notifications, session end,
// config change …); errors log via debug only, callers surface as needed.
// Owned Mercury module.

import type {
  HookInput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { execCommandHook, shouldSkipHookDueToTrust, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from './execution.js'
import { isEnvTruthy } from '../envUtils.js'
import { execHttpHook } from './execHttpHook.js'
import { getMatchingHooks } from './matching.js'
import { shouldDisableAllHooksIncludingManaged } from './hooksConfigSnapshot.js'
import { getSessionId } from '../../bootstrap/state.js'
import { jsonStringify } from '../slowOperations.js'
import { parseHookOutput, parseHttpHookOutput } from './outputProcessing.js'
import type { HookOutsideReplResult } from './types.js'
import { randomUUID } from 'crypto'
import { isAsyncHookJSONOutput, isSyncHookJSONOutput } from '../../types/hooks.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'

/**
 * Run every hook matching a lifecycle event, in parallel, without the
 * REPL's generator loop.
 *
 * Where executeHooks() yields attachments the model sees, this runner only
 * returns flat HookOutsideReplResult rows — success, output, blocked, and
 * the optional watchPaths/systemMessage extras — and confines its own error
 * reporting to the debug log. A caller that owes the operator visibility
 * (executeSessionEndHooks writing to stderr during shutdown, say) surfaces
 * the rows itself.
 *
 * Callback, http, and command hooks run here. Prompt and agent hooks
 * need the REPL's query machinery and report themselves unsupported;
 * a function hook arriving here at all is a routing bug and is logged as
 * one (its Stop-hook home is executeStopHooks).
 */
export async function executeHooksOutsideREPL({
  getAppState,
  hookInput,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
}: {
  getAppState?: () => AppState
  hookInput: HookInput
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs: number
}): Promise<HookOutsideReplResult[]> {
  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
    return []
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent
  if (shouldDisableAllHooksIncludingManaged()) {
    logForDebugging(
      `Skipping hooks for ${hookName} due to 'disableAllHooks' managed setting`,
    )
    return []
  }

  // SECURITY: the same centralized workspace-trust gate as the REPL engine —
  // an untrusted workspace's settings never get to run commands, on any
  // execution path.
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping ${hookName} hook execution - workspace trust not accepted`,
    )
    return []
  }

  const appState = getAppState ? getAppState() : undefined
  // Outside the REPL there is no subagent context; hooks match against the
  // main session.
  const sessionId = getSessionId()
  const matchingHooks = await getMatchingHooks(
    appState,
    sessionId,
    hookEvent,
    hookInput,
  )
  if (matchingHooks.length === 0) {
    return []
  }

  if (signal?.aborted) {
    return []
  }

  // One stringify serves the whole batch; if the input cannot serialize,
  // nothing can run.
  let jsonInput: string
  try {
    jsonInput = jsonStringify(hookInput)
  } catch (error) {
    logError(error)
    return []
  }

  // Each hook runs under its own timeout; the batch is the parallel sum.
  const hookPromises = matchingHooks.map(
    async ({ hook, extensionRoot, extensionId }, hookIndex) => {
      if (hook.type === 'callback') {
        const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
        const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
          signal,
          { timeoutMs: callbackTimeoutMs },
        )

        try {
          const toolUseID = randomUUID()
          const json = await hook.callback(
            hookInput,
            toolUseID,
            abortSignal,
            hookIndex,
          )

          cleanup?.()

          if (isAsyncHookJSONOutput(json)) {
            logForDebugging(
              `${hookName} [callback] returned async response, returning empty output`,
            )
            return {
              command: 'callback',
              succeeded: true,
              output: '',
              blocked: false,
            }
          }

          // WorktreeCreate consumers read `output` as the new worktree's
          // path; every other event reads it as the hook's message.
          const output =
            hookEvent === 'WorktreeCreate' &&
            isSyncHookJSONOutput(json) &&
            json.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
              ? json.hookSpecificOutput.worktreePath
              : json.systemMessage || ''
          const blocked =
            isSyncHookJSONOutput(json) && json.decision === 'block'

          logForDebugging(`${hookName} [callback] completed successfully`)

          return {
            command: 'callback',
            succeeded: true,
            output,
            blocked,
          }
        } catch (error) {
          cleanup?.()

          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(
            `${hookName} [callback] failed to run: ${errorMessage}`,
            { level: 'error' },
          )
          return {
            command: 'callback',
            succeeded: false,
            output: errorMessage,
            blocked: false,
          }
        }
      }

      // Prompt and agent hooks need the REPL's query machinery — an honest
      // unsupported row beats a silent skip. (Their outside-REPL support is
      // an open deferral.)
      if (hook.type === 'prompt') {
        return {
          command: hook.prompt,
          succeeded: false,
          output: 'Prompt stop hooks are not yet supported outside REPL',
          blocked: false,
        }
      }

      if (hook.type === 'agent') {
        return {
          command: hook.prompt,
          succeeded: false,
          output: 'Agent stop hooks are not yet supported outside REPL',
          blocked: false,
        }
      }

      // A function hook here is a routing bug: they hold conversation
      // closures that only the REPL path (executeStopHooks) can feed.
      if (hook.type === 'function') {
        logError(
          new Error(
            `Function hook reached executeHooksOutsideREPL for ${hookEvent}. Function hooks should only be used in REPL context (Stop hooks).`,
          ),
        )
        return {
          command: 'function',
          succeeded: false,
          output: 'Internal error: function hook executed outside REPL context',
          blocked: false,
        }
      }

      // HTTP hooks: a plain POST, no tool context. execHttpHook owns its own
      // timeout (hook.timeout or the transport default), so the parent
      // signal goes through un-stacked.
      if (hook.type === 'http') {
        try {
          const httpResult = await execHttpHook(
            hook,
            hookEvent,
            jsonInput,
            signal,
          )

          if (httpResult.aborted) {
            logForDebugging(`${hookName} [${hook.url}] cancelled`)
            return {
              command: hook.url,
              succeeded: false,
              output: 'Hook cancelled',
              blocked: false,
            }
          }

          if (httpResult.error || !httpResult.ok) {
            const errMsg =
              httpResult.error ||
              `HTTP ${httpResult.statusCode} from ${hook.url}`
            logForDebugging(`${hookName} [${hook.url}] failed: ${errMsg}`, {
              level: 'error',
            })
            return {
              command: hook.url,
              succeeded: false,
              output: errMsg,
              blocked: false,
            }
          }

          // JSON-only transport: the body must clear the schema.
          const { json: httpJson, validationError: httpValidationError } =
            parseHttpHookOutput(httpResult.body)
          if (httpValidationError) {
            throw new Error(httpValidationError)
          }
          if (httpJson && !isAsyncHookJSONOutput(httpJson)) {
            logForDebugging(
              `Parsed JSON output from HTTP hook: ${jsonStringify(httpJson)}`,
              { level: 'verbose' },
            )
          }
          const jsonBlocked =
            httpJson &&
            !isAsyncHookJSONOutput(httpJson) &&
            isSyncHookJSONOutput(httpJson) &&
            httpJson.decision === 'block'

          // On WorktreeCreate the consumer treats `output` as a literal
          // filesystem path (command hooks print one to stdout; the HTTP
          // shape carries it in hookSpecificOutput.worktreePath). A body
          // with no worktreePath must yield '' — the consumer's non-empty
          // filter then drops it, where the raw '{}' body would have been
          // mistaken for a path.
          const output =
            hookEvent === 'WorktreeCreate'
              ? httpJson &&
                isSyncHookJSONOutput(httpJson) &&
                httpJson.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
                ? httpJson.hookSpecificOutput.worktreePath
                : ''
              : httpResult.body

          return {
            command: hook.url,
            succeeded: true,
            output,
            blocked: !!jsonBlocked,
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(
            `${hookName} [${hook.url}] failed to run: ${errorMessage}`,
            { level: 'error' },
          )
          return {
            command: hook.url,
            succeeded: false,
            output: errorMessage,
            blocked: false,
          }
        }
      }

      // Command hooks — the spawner path.
      const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
        signal,
        { timeoutMs: commandTimeoutMs },
      )
      try {
        const result = await execCommandHook(
          hook,
          hookEvent,
          hookName,
          jsonInput,
          abortSignal,
          randomUUID(),
          hookIndex,
          extensionRoot,
          extensionId,
        )

        cleanup?.()

        if (result.aborted) {
          logForDebugging(`${hookName} [${hook.command}] cancelled`)
          return {
            command: hook.command,
            succeeded: false,
            output: 'Hook cancelled',
            blocked: false,
          }
        }

        logForDebugging(
          `${hookName} [${hook.command}] completed with status ${result.status}`,
        )

        // Structured output, when present, contributes the block verdict and
        // the systemMessage/watchPaths extras; a schema failure is this
        // hook's failure.
        const { json, validationError } = parseHookOutput(result.stdout)
        if (validationError) {
          throw new Error(validationError)
        }
        if (json && !isAsyncHookJSONOutput(json)) {
          logForDebugging(
            `Parsed JSON output from hook: ${jsonStringify(json)}`,
            { level: 'verbose' },
          )
        }

        // Blocking arrives two ways: the exit-code protocol's 2, or a JSON
        // decision: 'block'.
        const jsonBlocked =
          json &&
          !isAsyncHookJSONOutput(json) &&
          isSyncHookJSONOutput(json) &&
          json.decision === 'block'
        const blocked = result.status === 2 || !!jsonBlocked

        // Success speaks on stdout; failure speaks on stderr.
        const output =
          result.status === 0 ? result.stdout || '' : result.stderr || ''

        const watchPaths =
          json &&
          isSyncHookJSONOutput(json) &&
          json.hookSpecificOutput &&
          'watchPaths' in json.hookSpecificOutput
            ? json.hookSpecificOutput.watchPaths
            : undefined

        const systemMessage =
          json && isSyncHookJSONOutput(json) ? json.systemMessage : undefined

        return {
          command: hook.command,
          succeeded: result.status === 0,
          output,
          blocked,
          watchPaths,
          systemMessage,
        }
      } catch (error) {
        cleanup?.()

        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logForDebugging(
          `${hookName} [${hook.command}] failed to run: ${errorMessage}`,
          { level: 'error' },
        )
        return {
          command: hook.command,
          succeeded: false,
          output: errorMessage,
          blocked: false,
        }
      }
    },
  )

  return await Promise.all(hookPromises)
}

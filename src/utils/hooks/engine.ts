// The hook engine — executeHooks, the async-generator core that fans matched
// hooks out concurrently (progress events, per-hook timeout, blocking
// aggregation, extension/skill env substitution, telemetry spans), plus the
// function-hook and SDK-callback executors. The concurrency/aggregation semantics
// are behavior — moved exactly.

import { randomUUID } from 'crypto'
import chalk from 'chalk'
import type {
  HookEvent,
  HookInput,
} from 'src/entrypoints/agentSdkTypes.js'
import { getStatsStore, addToTurnHookDuration } from '../../bootstrap/state.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { recordHookFailure } from '../../extensions/health.js'
import { errorMessage } from '../errors.js'
import { all } from '../generators.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import {
  emitHookResponse,
  emitHookStarted,
} from './hookEvents.js'
import { execAgentHook } from './execAgentHook.js'
import { execHttpHook } from './execHttpHook.js'
import { execPromptHook } from './execPromptHook.js'
import { getSessionHookCallback, type FunctionHook } from './sessionHooks.js'
import { getHookDisplayText, retireOnceHookFromSettings } from './hooksSettings.js'
import { shouldDisableAllHooksIncludingManaged, updateHooksConfigSnapshot } from './hooksConfigSnapshot.js'
import {
  type HookCallback,
  type PromptRequest,
  type PromptResponse,
} from '../../types/hooks.js'
import { isEnvTruthy } from '../envUtils.js'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import type { PermissionResult } from '../permissions/PermissionResult.js'
import type { ToolUseContext } from '../../Tool.js'
import { execCommandHook, shouldSkipHookDueToTrust, TOOL_HOOK_EXECUTION_TIMEOUT_MS } from './execution.js'
import { getMatchingHooks, isInternalHook } from './matching.js'
import { parseHookOutput, parseHttpHookOutput, processHookJSONOutput } from './outputProcessing.js'
import type { AggregatedHookResult, HookResult } from './types.js'
import { isAsyncHookJSONOutput, isSyncHookJSONOutput } from '../../types/hooks.js'
import type { Message } from '../../types/message.js'
import type { HookCommand } from '../settings/types.js'

/**
 * A once:true hook that has RUN retires (FC-108): its settings entry is
 * removed and the live snapshot refreshed, per the schema's own promise
 * ("Run this hook once, then remove it."). Callers gate on the run itself
 * — an operator cancel is not a run — and on origin: extension/skill
 * hooks live in manifests, not settings files, so they never reach here.
 * Fail-soft by design: a retirement that cannot land never takes the
 * hook's own result down with it.
 */
function retireOnceHookAfterRun(hook: HookCommand, hookEvent: HookEvent): void {
  try {
    const source = retireOnceHookFromSettings(hookEvent, hook)
    if (source !== null) {
      updateHooksConfigSnapshot()
      logForDebugging(
        `once hook retired from ${source} after its run: ${getHookDisplayText(hook)} (${hookEvent})`,
      )
    } else {
      logForDebugging(
        `once hook ran but no editable settings entry was found to retire: ${getHookDisplayText(hook)} (${hookEvent})`,
      )
    }
  } catch (error) {
    logForDebugging(`once hook retirement failed: ${String(error)}`)
  }
}

/**
 * The generator core every executeXxxHooks wrapper drives.
 *
 * Shape of a run: global kill-switches, the workspace-trust gate, matching,
 * then every matched hook races concurrently under its own timeout while
 * this generator yields three currents back to the caller — progress
 * entries as hooks start, each hook's own results as they land (messages,
 * blocking errors, context, permission verdicts under deny > ask > allow
 * precedence), and batch bookkeeping at the end. Hook failures become
 * yielded results, never throws: one broken hook cannot take the turn down
 * with it.
 *
 * `signal` cancels the batch; `timeoutMs` is the per-hook default that a
 * hook's own `timeout` overrides. Prompt/agent hooks additionally need
 * `toolUseContext` and `messages`; `requestPrompt` lets a command hook ask
 * the operator mid-run (bound here to the hook's display name).
 */
export async function* executeHooks({
  hookInput,
  toolUseID,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext,
  messages,
  forceSyncExecution,
  requestPrompt,
  toolInputSummary,
}: {
  hookInput: HookInput
  toolUseID: string
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs?: number
  toolUseContext?: ToolUseContext
  messages?: Message[]
  forceSyncExecution?: boolean
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolInputSummary?: string | null
}): AsyncGenerator<AggregatedHookResult> {
  if (shouldDisableAllHooksIncludingManaged()) {
    return
  }

  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
    return
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent

  // The prompt callback learns which hook is asking (and for which tool
  // input) here, so the consent UI can attribute the question.
  const boundRequestPrompt = requestPrompt?.(hookName, toolInputSummary)

  // SECURITY: the trust gate is centralized here so EVERY hook family —
  // current and future — runs commands only in a workspace the operator has
  // accepted. Bypassing it would be remote code execution by config file.
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping ${hookName} hook execution - workspace trust not accepted`,
    )
    return
  }

  const appState = toolUseContext ? toolUseContext.getAppState() : undefined
  // Subagents match against their own session id; the main thread against
  // the session's.
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  const matchingHooks = await getMatchingHooks(
    appState,
    sessionId,
    hookEvent,
    hookInput,
    toolUseContext?.options?.tools,
  )
  if (matchingHooks.length === 0) {
    return
  }

  if (signal?.aborted) {
    return
  }

  const userHooks = matchingHooks.filter(h => !isInternalHook(h))
  if (userHooks.length === 0) {
    // Internal-only batches take the short road. When every match is an
    // internal callback (the file-access and attribution observers), each
    // returns {} and ignores the signal — so progress emission, combined
    // signals, JSON projection, and the aggregation loop are all pure
    // overhead. Bypassing them cut a PostToolUse hit from ~6µs to under
    // 2µs in the microbench.
    const batchStartTime = Date.now()
    const context = toolUseContext
      ? {
          getAppState: toolUseContext.getAppState,
          updateAttributionState: toolUseContext.updateAttributionState,
        }
      : undefined
    for (const [i, { hook }] of matchingHooks.entries()) {
      if (hook.type === 'callback') {
        await hook.callback(hookInput, toolUseID, signal, i, context)
      }
    }
    const totalDurationMs = Date.now() - batchStartTime
    getStatsStore()?.observe('hook_duration_ms', totalDurationMs)
    addToTurnHookDuration(totalDurationMs)
    return
  }

  // Announce the batch: one progress entry per visible hook, before any
  // execution starts, so the operator sees what is about to run.
  for (const { hook } of matchingHooks) {
    // Silent function hooks (e.g. a keep-working Stop hook)
    // run invisibly: skip the progress emission so the foreground spinner never
    // shows "running stop hook". The re-prompt still reaches the model via the
    // separate blockingError.silent path — only the UI signal is suppressed.
    // No silent hooks exist in a bare stamp (stamp-gated), so this stays byte-identical.
    if (hook.type === 'function' && (hook as { silent?: boolean }).silent) {
      continue
    }
    yield {
      message: {
        type: 'progress',
        data: {
          type: 'hook_progress',
          hookEvent,
          hookName,
          command: getHookDisplayText(hook),
          ...(hook.type === 'prompt' && { promptText: hook.prompt }),
          ...('statusMessage' in hook &&
            hook.statusMessage != null && {
              statusMessage: hook.statusMessage,
            }),
        },
        parentToolUseID: toolUseID,
        toolUseID,
        timestamp: new Date().toISOString(),
        uuid: randomUUID(),
      },
    }
  }

  // Wall clock for the whole batch — hooks run concurrently, so the batch
  // costs its slowest member, and that is the number worth watching.
  const batchStartTime = Date.now()

  // hookInput serializes at most once per batch, on demand: the string is
  // shared by every spawning transport (the input never mutates), and a
  // batch of only callback/function hooks — which exit before this point —
  // never pays for it at all.
  let jsonInputResult:
    | { ok: true; value: string }
    | { ok: false; error: unknown }
    | undefined
  function getJsonInput() {
    if (jsonInputResult !== undefined) {
      return jsonInputResult
    }
    try {
      return (jsonInputResult = { ok: true, value: jsonStringify(hookInput) })
    } catch (error) {
      logError(
        Error(`Failed to stringify hook ${hookName} input`, { cause: error }),
      )
      return (jsonInputResult = { ok: false, error })
    }
  }

  // One generator per matched hook; `all()` below races them. Every path
  // out of a generator yields exactly one HookResult (or nothing for the
  // no-op cases) and releases its combined-signal cleanup.
  const hookPromises = matchingHooks.map(async function* (
    { hook, extensionRoot, extensionId, skillRoot },
    hookIndex,
  ): AsyncGenerator<HookResult> {
    if (hook.type === 'callback') {
      const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
        signal,
        { timeoutMs: callbackTimeoutMs },
      )
      yield executeHookCallback({
        toolUseID,
        hook,
        hookEvent,
        hookInput,
        signal: abortSignal,
        hookIndex,
        toolUseContext,
      }).finally(cleanup)
      return
    }

    if (hook.type === 'function') {
      if (!messages) {
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: 'Messages not provided for function hook',
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        return
      }

      // Function hooks carry live closures — they exist only in session
      // storage, never in settings files.
      yield executeFunctionHook({
        hook,
        messages,
        hookName,
        toolUseID,
        hookEvent,
        timeoutMs,
        signal,
        hookInput,
      })
      return
    }

    // Everything from here down speaks the JSON-on-stdin protocol.
    const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
    const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
      timeoutMs: commandTimeoutMs,
    })
    const hookId = randomUUID()
    const hookStartMs = Date.now()
    const hookCommand = getHookDisplayText(hook)

    try {
      const jsonInputRes = getJsonInput()
      if (!jsonInputRes.ok) {
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: `Failed to prepare hook input: ${errorMessage(jsonInputRes.error)}`,
            command: hookCommand,
            durationMs: Date.now() - hookStartMs,
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        cleanup()
        return
      }
      const jsonInput = jsonInputRes.value

      if (hook.type === 'prompt') {
        if (!toolUseContext) {
          throw new Error(
            'ToolUseContext is required for prompt hooks. This is a bug.',
          )
        }
        const promptResult = await execPromptHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          messages,
          toolUseID,
        )
        // Stamp command + duration onto the attachment so the transcript's
        // hook rows can show what ran and how long it took.
        if (promptResult.message?.type === 'attachment') {
          const att = promptResult.message.attachment
          if (
            att.type === 'hook_success' ||
            att.type === 'hook_non_blocking_error'
          ) {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        // The prompt has RUN; only a batch cancel is a non-run.
        if (hook.once === true && !extensionRoot && !skillRoot && signal?.aborted !== true) {
          retireOnceHookAfterRun(hook, hookEvent)
        }
        yield promptResult
        cleanup?.()
        return
      }

      if (hook.type === 'agent') {
        if (!toolUseContext) {
          throw new Error(
            'ToolUseContext is required for agent hooks. This is a bug.',
          )
        }
        if (!messages) {
          throw new Error(
            'Messages are required for agent hooks. This is a bug.',
          )
        }
        const agentResult = await execAgentHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          toolUseID,
          messages,
          'agent_type' in hookInput
            ? (hookInput.agent_type as string)
            : undefined,
        )
        // Same timing stamp as the prompt lane.
        if (agentResult.message?.type === 'attachment') {
          const att = agentResult.message.attachment
          if (
            att.type === 'hook_success' ||
            att.type === 'hook_non_blocking_error'
          ) {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        // The agent hook has RUN; only a batch cancel is a non-run.
        if (hook.once === true && !extensionRoot && !skillRoot && signal?.aborted !== true) {
          retireOnceHookAfterRun(hook, hookEvent)
        }
        yield agentResult
        cleanup?.()
        return
      }

      if (hook.type === 'http') {
        emitHookStarted(hookId, hookName, hookEvent)

        // The HTTP transport owns its own clock (hook.timeout or its
        // default), so it gets the bare parent signal — wrapping it in
        // abortSignal would stack a second timeout on the same request.
        const httpResult = await execHttpHook(
          hook,
          hookEvent,
          jsonInput,
          signal,
        )
        cleanup?.()

        if (httpResult.aborted) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: 'Hook cancelled',
            stdout: '',
            stderr: '',
            exitCode: undefined,
            outcome: 'cancelled',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName,
              toolUseID,
              hookEvent,
            }),
            outcome: 'cancelled' as const,
            hook,
          }
          return
        }

        // The request settled — the one-shot promise is now due whatever
        // verdict the body carries below.
        if (hook.once === true && !extensionRoot && !skillRoot) {
          retireOnceHookAfterRun(hook, hookEvent)
        }

        if (httpResult.error || !httpResult.ok) {
          const stderr =
            httpResult.error || `HTTP ${httpResult.statusCode} from ${hook.url}`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: stderr,
            stdout: '',
            stderr,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr,
              stdout: '',
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        // The HTTP transport is JSON-only; the body goes straight through
        // schema validation (parseHttpHookOutput — no plain-text lane).
        const { json: httpJson, validationError: httpValidationError } =
          parseHttpHookOutput(httpResult.body)

        if (httpValidationError) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: `JSON validation failed: ${httpValidationError}`,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr: `JSON validation failed: ${httpValidationError}`,
              stdout: httpResult.body,
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        if (httpJson && isAsyncHookJSONOutput(httpJson)) {
          // An async acknowledgement carries no verdict — success, no
          // further processing.
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        if (httpJson) {
          const processed = processHookJSONOutput({
            json: httpJson,
            command: hook.url,
            hookName,
            toolUseID,
            hookEvent,
            expectedHookEvent: hookEvent,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
          })
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            ...processed,
            outcome: 'success' as const,
            hook,
          }
          return
        }

        return
      }

      emitHookStarted(hookId, hookName, hookEvent)

      const result = await execCommandHook(
        hook,
        hookEvent,
        hookName,
        jsonInput,
        abortSignal,
        hookId,
        hookIndex,
        extensionRoot,
        extensionId,
        skillRoot,
        forceSyncExecution,
        boundRequestPrompt,
      )
      cleanup?.()
      const durationMs = Date.now() - hookStartMs

      // The hook has RUN (spawned and settled, or handed off to the
      // background); only the operator-cancel arm below is a non-run — a
      // timeout overran its one run, it still ran.
      if (
        hook.once === true &&
        !extensionRoot &&
        !skillRoot &&
        !(result.aborted && signal?.aborted === true)
      ) {
        retireOnceHookAfterRun(hook, hookEvent)
      }

      if (result.backgrounded) {
        yield {
          outcome: 'success' as const,
          hook,
        }
        return
      }

      if (result.aborted) {
        // The per-hook timeout is FOLDED into the combined signal, so an
        // overrun used to classify exactly like an operator cancel and
        // dress as hook_cancelled — a registered null-render. A PreToolUse
        // guard that outran its clock failed OPEN with the abandonment
        // reaching no channel (FC-018). The outer signal's own state is the
        // discriminator: only a real batch cancel keeps the cancelled path;
        // a timeout becomes a VISIBLE non-blocking error naming the overrun
        // and the fail-open.
        const outerCancelled = signal?.aborted === true
        if (!outerCancelled) {
          const timeoutSeconds = Math.round(commandTimeoutMs / 1000)
          const timeoutStderr =
            `hook timed out after ${timeoutSeconds}s and was killed; the ${hookEvent} it guarded proceeded ` +
            `(a blocking guard must answer inside its own timeout)` +
            (result.stderr ? `\n${result.stderr}` : '')
          if (extensionId) recordHookFailure(extensionId, hookCommand, 'timeout')
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: result.output,
            stdout: result.stdout,
            stderr: timeoutStderr,
            exitCode: result.status,
            outcome: 'error',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr: timeoutStderr,
              stdout: result.stdout,
              exitCode: result.status,
              command: hookCommand,
              durationMs,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'cancelled',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_cancelled',
            hookName,
            toolUseID,
            hookEvent,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'cancelled' as const,
          hook,
        }
        return
      }

      // stdout speaks either JSON (structured protocol) or prose (exit-code
      // protocol); the parser decides which lane this run took.
      const { json, plainText, validationError } = parseHookOutput(
        result.stdout,
      )

      if (validationError) {
        // The one health owner counts an extension hook's failures.
        if (extensionId) recordHookFailure(extensionId, hookCommand, 'unparseable output')
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: `JSON validation failed: ${validationError}`,
          exitCode: 1,
          outcome: 'error',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID,
            hookEvent,
            stderr: `JSON validation failed: ${validationError}`,
            stdout: result.stdout,
            exitCode: 1,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'non_blocking_error' as const,
          hook,
        }
        return
      }

      if (json) {
        // An async acknowledgement was already backgrounded during
        // execution — nothing further to project.
        if (isAsyncHookJSONOutput(json)) {
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        const processed = processHookJSONOutput({
          json,
          command: hookCommand,
          hookName,
          toolUseID,
          hookEvent,
          expectedHookEvent: hookEvent,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          durationMs,
        })

        // JSON runs that ALSO printed prose keep that prose visible unless
        // the hook asked for suppression — a completed marker attachment
        // fills in when the projection produced none of its own.
        if (
          isSyncHookJSONOutput(json) &&
          !json.suppressOutput &&
          plainText &&
          result.status === 0
        ) {
          const content = `${chalk.bold(hookName)} completed`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: result.output,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            outcome: 'success',
          })
          yield {
            ...processed,
            message:
              processed.message ||
              createAttachmentMessage({
                type: 'hook_success',
                hookName,
                toolUseID,
                hookEvent,
                content,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.status,
                command: hookCommand,
                durationMs,
              }),
            outcome: 'success' as const,
            hook,
          }
          return
        }

        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: result.status === 0 ? 'success' : 'error',
        })
        yield {
          ...processed,
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // The exit-code protocol: 0 succeeds with stdout as content…
      if (result.status === 0) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'success',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_success',
            hookName,
            toolUseID,
            hookEvent,
            content: result.stdout.trim(),
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // …2 blocks, with stderr as the model-facing feedback…
      if (result.status === 2) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'error',
        })
        yield {
          blockingError: {
            blockingError: `[${hook.command}]: ${result.stderr || 'No stderr output'}`,
            command: hook.command,
          },
          outcome: 'blocking' as const,
          hook,
        }
        return
      }

      // …and any other exit code is a non-blocking error, shown but never
      // in the model's way.
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        outcome: 'error',
      })
      if (extensionId) recordHookFailure(extensionId, hookCommand, `exit ${result.status}`)
      // The headless report (FC-083): the /hooks browser promises a
      // non-zero exit "shows stderr to the user only and continues" — the
      // interactive road renders the attachment below, but a -p run's
      // attachment reaches no stream, so the promise was kept nowhere a
      // headless operator looks. One stderr line IS the promise there.
      if (getIsNonInteractiveSession()) {
        try {
          process.stderr.write(
            `hook ${hookName} (${hookEvent}) failed with exit ${result.status ?? '?'}: ${result.stderr.trim() || 'no stderr output'}\n`,
          )
        } catch {
          /* a dead stderr must not break the turn */
        }
      }
      yield {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed with non-blocking status code: ${result.stderr.trim() || 'No stderr output'}`,
          stdout: result.stdout,
          exitCode: result.status,
          command: hookCommand,
          durationMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    } catch (error) {
      cleanup?.()

      const errorMessage =
        error instanceof Error ? error.message : String(error)
      if (extensionId) recordHookFailure(extensionId, hookCommand, /abort|time/i.test(errorMessage) ? 'timeout' : errorMessage.slice(0, 80))
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: `Failed to run: ${errorMessage}`,
        stdout: '',
        stderr: `Failed to run: ${errorMessage}`,
        exitCode: 1,
        outcome: 'error',
      })
      yield {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed to run: ${errorMessage}`,
          stdout: '',
          exitCode: 1,
          command: hookCommand,
          durationMs: Date.now() - hookStartMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    }
  })

  const outcomes = {
    success: 0,
    blocking: 0,
    non_blocking_error: 0,
    cancelled: 0,
  }

  let permissionBehavior: PermissionResult['behavior'] | undefined

  // The aggregation loop: results land in completion order (all() races the
  // per-hook generators), and each result is decomposed into the aggregate
  // slices the wrappers understand. Yield granularity is one field-set per
  // yield — consumers merge, and never see a half-built aggregate.
  for await (const result of all(hookPromises)) {
    outcomes[result.outcome]++

    if (result.preventContinuation) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) requested preventContinuation`,
      )
      yield {
        preventContinuation: true,
        stopReason: result.stopReason,
      }
    }

    if (result.blockingError) {
      yield {
        blockingError: result.blockingError,
      }
    }

    if (result.message) {
      yield { message: result.message }
    }

    if (result.systemMessage) {
      yield {
        message: createAttachmentMessage({
          type: 'hook_system_message',
          content: result.systemMessage,
          hookName,
          toolUseID,
          hookEvent,
        }),
      }
    }

    if (result.additionalContext) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided additionalContext (${result.additionalContext.length} chars)`,
      )
      yield {
        additionalContexts: [result.additionalContext],
      }
    }

    if (result.initialUserMessage) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided initialUserMessage (${result.initialUserMessage.length} chars)`,
      )
      yield {
        initialUserMessage: result.initialUserMessage,
      }
    }

    if (result.watchPaths && result.watchPaths.length > 0) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided ${result.watchPaths.length} watchPaths`,
      )
      yield {
        watchPaths: result.watchPaths,
      }
    }

    if (result.updatedMCPToolOutput) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) replaced MCP tool output`,
      )
      yield {
        updatedMCPToolOutput: result.updatedMCPToolOutput,
      }
    }

    // Permission verdicts aggregate under fixed precedence — deny > ask >
    // allow, with passthrough contributing nothing. A later allow can never
    // soften an earlier deny.
    if (result.permissionBehavior) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) returned permissionDecision: ${result.permissionBehavior}${result.hookPermissionDecisionReason ? ` (reason: ${result.hookPermissionDecisionReason})` : ''}`,
      )
      switch (result.permissionBehavior) {
        case 'deny':
          permissionBehavior = 'deny'
          break
        case 'ask':
          if (permissionBehavior !== 'deny') {
            permissionBehavior = 'ask'
          }
          break
        case 'allow':
          if (!permissionBehavior) {
            permissionBehavior = 'allow'
          }
          break
        case 'passthrough':
          break
      }
    }

    // Re-yield the running aggregate whenever it exists; updatedInput rides
    // along only when THIS hook decided allow/ask (a denying hook's rewrite
    // must not survive its own deny).
    if (permissionBehavior !== undefined) {
      const updatedInput =
        result.updatedInput &&
        (result.permissionBehavior === 'allow' ||
          result.permissionBehavior === 'ask')
          ? result.updatedInput
          : undefined
      if (updatedInput) {
        logForDebugging(
          `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(updatedInput).join(', ')}]`,
        )
      }
      yield {
        permissionBehavior,
        hookPermissionDecisionReason: result.hookPermissionDecisionReason,
        hookSource: matchingHooks.find(m => m.hook === result.hook)?.hookSource,
        updatedInput,
      }
    }

    // A hook may rewrite input without ruling on permission (this hook's own
    // behavior undefined — the aggregate is irrelevant here): the rewrite
    // still flows.
    if (result.updatedInput && result.permissionBehavior === undefined) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(result.updatedInput).join(', ')}]`,
      )
      yield {
        updatedInput: result.updatedInput,
      }
    }
    if (result.permissionRequestResult) {
      yield {
        permissionRequestResult: result.permissionRequestResult,
      }
    }
    if (result.retry) {
      yield {
        retry: result.retry,
      }
    }
    if (result.elicitationResponse) {
      yield {
        elicitationResponse: result.elicitationResponse,
      }
    }
    if (result.elicitationResultResponse) {
      yield {
        elicitationResultResponse: result.elicitationResultResponse,
      }
    }

    // Session-registered hooks may carry an onHookSuccess observer
    // (matched by event + matcher + hook identity; '' when the event has no
    // match dimension, e.g. Stop). Callback hooks are excluded — they ARE
    // the observer. Observer failures are logged, never propagated.
    if (appState && result.hook.type !== 'callback') {
      const sessionId = getSessionId()
      const matcher = matchQuery ?? ''
      const hookEntry = getSessionHookCallback(
        appState,
        sessionId,
        hookEvent,
        matcher,
        result.hook,
      )
      if (hookEntry?.onHookSuccess && result.outcome === 'success') {
        try {
          hookEntry.onHookSuccess(result.hook, result as AggregatedHookResult)
        } catch (error) {
          logError(
            Error('Session hook success callback failed', { cause: error }),
          )
        }
      }
    }
  }

  const totalDurationMs = Date.now() - batchStartTime
  getStatsStore()?.observe('hook_duration_ms', totalDurationMs)
  addToTurnHookDuration(totalDurationMs)


}

/**
 * Run one function hook: a live closure over the conversation that answers
 * `true` (pass), `false` (block with its registration-time errorMessage), or
 * a string (block with that string as the dynamic re-prompt). Runs under the
 * batch signal plus its own timeout; cancellation is an outcome, not an
 * error.
 */
export async function executeFunctionHook({
  hook,
  messages,
  hookName,
  toolUseID,
  hookEvent,
  timeoutMs,
  signal,
  hookInput,
}: {
  hook: FunctionHook
  messages: Message[]
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  timeoutMs: number
  signal?: AbortSignal
  hookInput?: HookInput
}): Promise<HookResult> {
  const callbackTimeoutMs = hook.timeout ?? timeoutMs
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: callbackTimeoutMs,
  })

  try {
    if (abortSignal.aborted) {
      cleanup()
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // The race: the callback settles, or the abort listener rejects first.
    // The listener is removed on either outcome so a settled hook cannot
    // leak a rejection later.
    const passed = await new Promise<boolean | string>((resolve, reject) => {
      const onAbort = () => reject(new Error('Function hook cancelled'))
      abortSignal.addEventListener('abort', onAbort)

      // The 3rd arg carries the raw event payload (e.g. the PreToolUse
      // tool_input) so a function hook can inspect the pending call.
      Promise.resolve(hook.callback(messages, abortSignal, { hookInput }))
        .then(result => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(result)
        })
        .catch(error => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(error)
        })
    })

    cleanup()

    if (passed === true) {
      return {
        outcome: 'success',
        hook,
      }
    }
    return {
      blockingError: {
        blockingError:
          typeof passed === 'string' && passed.length > 0
            ? passed
            : hook.errorMessage,
        command: 'function',
        // Carry the hook's silent flag onto the blocking error so the Stop-hook
        // consumer can inject the model-facing re-prompt while suppressing the
        // visible summary/notification. Undefined for ordinary hooks.
        silent: hook.silent,
      },
      outcome: 'blocking',
      hook,
    }
  } catch (error) {
    cleanup()

    if (
      error instanceof Error &&
      (error.message === 'Function hook cancelled' ||
        error.name === 'AbortError')
    ) {
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    logError(error)
    return {
      message: createAttachmentMessage({
        type: 'hook_error_during_execution',
        hookName,
        toolUseID,
        hookEvent,
        content:
          error instanceof Error
            ? error.message
            : 'Function hook execution error',
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }
}

/**
 * Run one SDK callback hook and project its JSON answer through the shared
 * output processor. Callbacks are in-process: no stdout/stderr/exit code,
 * and an async acknowledgement is simply success.
 */
export async function executeHookCallback({
  toolUseID,
  hook,
  hookEvent,
  hookInput,
  signal,
  hookIndex,
  toolUseContext,
}: {
  toolUseID: string
  hook: HookCallback
  hookEvent: HookEvent
  hookInput: HookInput
  signal: AbortSignal
  hookIndex?: number
  toolUseContext?: ToolUseContext
}): Promise<HookResult> {
  // Callbacks that read or write app state get a narrow context, not the
  // whole ToolUseContext.
  const context = toolUseContext
    ? {
        getAppState: toolUseContext.getAppState,
        updateAttributionState: toolUseContext.updateAttributionState,
      }
    : undefined
  const json = await hook.callback(
    hookInput,
    toolUseID,
    signal,
    hookIndex,
    context,
  )
  if (isAsyncHookJSONOutput(json)) {
    return {
      outcome: 'success',
      hook,
    }
  }

  const processed = processHookJSONOutput({
    json,
    command: 'callback',
    hookName: `${hookEvent}:Callback`,
    toolUseID,
    hookEvent,
    expectedHookEvent: hookEvent,
    stdout: undefined,
    stderr: undefined,
    exitCode: undefined,
  })
  return {
    ...processed,
    outcome: 'success',
    hook,
  }
}

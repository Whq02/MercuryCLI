
import type { HookEvent, HookInput } from './contract.js'

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { runHookEvent } from './engine.js'
import type { HookCommand } from '../settings/types.js'
import type { HookLifecycleResult, HookResult } from './types.js'

export async function executeLifecycleHooks({
  getAppState,
  hookInput,
  matchQuery,
  signal,
  timeoutMs,
}: {
  getAppState?: () => AppState
  hookInput: HookInput
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<HookLifecycleResult[]> {
  if (isEnvTruthy(process.env.MERCURY_BARE)) {
    return []
  }

  void timeoutMs

  const event = hookInput.hook_event_name
  const {
    hook_event_name: _eventName,
    session_id: _sessionId,
    transcript_path: _transcriptPath,
    cwd: _cwd,
    ...fields
  } = hookInput as Record<string, unknown>
  void _eventName
  void _sessionId
  void _transcriptPath
  void _cwd

  const rows: HookLifecycleResult[] = []
  for await (const result of runHookEvent({
    event,
    fields: fields as never,
    matchQuery,
    signal,
    timeoutMs,
    getAppState,
    perHook: true,
  })) {
    rows.push(lifecycleRowOf(event, result as HookResult))
  }
  return rows
}

function lifecycleRowOf(event: HookEvent, result: HookResult): HookLifecycleResult {
  const hook = result.hook
  const command =
    hook.type === 'callback'
      ? 'callback'
      : hook.type === 'function'
        ? 'function'
        : hook.type === 'http'
          ? hook.url
          : hook.type === 'prompt' || hook.type === 'agent'
            ? hook.prompt
            : (hook as HookCommand & { command: string }).command

  if (hook.type === 'prompt') {
    return {
      command,
      succeeded: false,
      output: 'Prompt stop hooks are not yet supported outside chat',
      blocked: false,
    }
  }
  if (hook.type === 'agent') {
    return {
      command,
      succeeded: false,
      output: 'Agent stop hooks are not yet supported outside chat',
      blocked: false,
    }
  }

  if (hook.type === 'http') {
    return httpRowOf(event, result, command)
  }

  if (hook.type === 'callback') {
    return callbackRowOf(event, result, command)
  }

  if (hook.type === 'function') {
    logForDebugging(
      `Function hook reached the lifecycle road for ${event}. Function hooks should only be used in chat context (Stop hooks).`,
      { level: 'error' },
    )
    return {
      command,
      succeeded: false,
      output: 'Internal error: function hook executed outside chat context',
      blocked: false,
    }
  }

  return commandRowOf(event, result, command)
}

function commandRowOf(event: HookEvent, result: HookResult, command: string): HookLifecycleResult {
  void event
  const message = result.message
  if (message !== undefined && message !== null && typeof message === 'object' && 'attachment' in (message as Record<string, unknown>)) {
    const att = (message as { attachment: { type?: string; stderr?: string; stdout?: string; exitCode?: number } }).attachment
    if (att.type === 'hook_non_blocking_error') {
      return {
        command,
        succeeded: false,
        output: att.stderr ?? '',
        blocked: false,
      }
    }
    if (att.type === 'hook_cancelled') {
      return {
        command,
        succeeded: false,
        output: 'Hook cancelled',
        blocked: false,
      }
    }
  }
  if (result.blockingError) {
    return {
      command,
      succeeded: false,
      output: result.blockingError.blockingError,
      blocked: true,
    }
  }
  const succeeded = result.outcome === 'success'
  const output = resultJsonOutput(result, command)
  return {
    command,
    succeeded,
    output,
    blocked: !succeeded && result.outcome === 'blocking',
  }
}

function httpRowOf(event: HookEvent, result: HookResult, command: string): HookLifecycleResult {
  void event
  if (result.blockingError) {
    return {
      command,
      succeeded: false,
      output: result.blockingError.blockingError,
      blocked: true,
    }
  }
  const succeeded = result.outcome === 'success'
  return {
    command,
    succeeded,
    output: resultJsonOutput(result, command),
    blocked: !succeeded && result.outcome === 'blocking',
  }
}

function callbackRowOf(event: HookEvent, result: HookResult, command: string): HookLifecycleResult {
  void event
  if (result.blockingError) {
    return {
      command,
      succeeded: false,
      output: result.blockingError.blockingError,
      blocked: true,
    }
  }
  const succeeded = result.outcome === 'success'
  return {
    command,
    succeeded,
    output: resultJsonOutput(result, command),
    blocked: !succeeded && result.outcome === 'blocking',
  }
}

function resultJsonOutput(result: HookResult, command: string): string {
  const message = result.message
  if (
    message !== undefined &&
    message !== null &&
    typeof message === 'object' &&
    'attachment' in (message as Record<string, unknown>)
  ) {
    const att = (message as { attachment: { type?: string; content?: string; stdout?: string } }).attachment
    if (att.type === 'hook_success') {
      return att.content ?? att.stdout ?? ''
    }
  }
  if (result.systemMessage) return result.systemMessage
  void command
  return ''
}

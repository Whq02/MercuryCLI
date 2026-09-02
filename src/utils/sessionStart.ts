import { logForDebugging } from './debug.js'
import { withDiagnosticsTiming } from './diagLogs.js'
import { getMainThreadAgentType } from '../bootstrap/state.js'
import { isBareMode } from './envUtils.js'
import { logError } from './log.js'
import { createAttachmentMessage } from './attachments/orchestrator.js'
import { executeSessionStartHooks, executeSetupHooks } from './hooks.js'
import { shouldAllowManagedHooksOnly } from './hooks/hooksConfigSnapshot.js'
import { updateWatchPaths } from './hooks/fileChangedWatcher.js'
import { ensureExtensionsLoaded } from '../extensions/boot.js'
import type { HookResultMessage } from '../types/message.js'


export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

let initialUserMessage: string | undefined

export function takeInitialUserMessage(): string | undefined {
  const taken = initialUserMessage
  initialUserMessage = undefined
  return taken
}

async function loadExtensionHooksGuarded(source: SessionStartSource): Promise<void> {
  try {
    await withDiagnosticsTiming('session_start_extension_hooks_load', () => ensureExtensionsLoaded())
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err))
    const wrapped = new Error(`Extension hook loading failed during SessionStart (${source}): ${original.message}`)
    if (original.stack) wrapped.stack = original.stack
    logError(wrapped)
    logForDebugging(`WARNING: extension SessionStart hooks will not execute. ${original.message}`)
  }
}

export async function processSessionStartHooks(
  source: SessionStartSource,
  options: { sessionId?: string; agentType?: string; model?: string; forceSyncExecution?: boolean } = {},
): Promise<HookResultMessage[]> {
  if (isBareMode()) return []
  if (shouldAllowManagedHooksOnly()) {
    logForDebugging('sessionStart: extension hook load skipped (managed hooks only)')
  } else {
    await loadExtensionHooksGuarded(source)
  }
  const agentType = options.agentType ?? getMainThreadAgentType()
  const messages: HookResultMessage[] = []
  const additionalContexts: string[] = []
  const watchPaths: string[] = []
  for await (const result of executeSessionStartHooks(
    source,
    options.sessionId,
    agentType,
    options.model,
    undefined,
    undefined,
    options.forceSyncExecution,
  )) {
    if (result.message) messages.push(result.message)
    if (result.additionalContexts) additionalContexts.push(...result.additionalContexts)
    if (result.initialUserMessage !== undefined) initialUserMessage = result.initialUserMessage
    if (result.watchPaths) watchPaths.push(...result.watchPaths)
  }
  if (watchPaths.length > 0) updateWatchPaths(watchPaths)
  if (additionalContexts.length > 0) {
    messages.push(
      createAttachmentMessage({
        type: 'hook_additional_context',
        content: additionalContexts,
        hookName: 'SessionStart',
        toolUseID: 'SessionStart',
        hookEvent: 'SessionStart',
      }) as HookResultMessage,
    )
  }
  return messages
}

export async function processSetupHooks(
  trigger: 'init' | 'maintenance',
  options: { forceSyncExecution?: boolean } = {},
): Promise<HookResultMessage[]> {
  if (isBareMode()) return []
  if (shouldAllowManagedHooksOnly()) {
    logForDebugging('setup: extension hook load skipped (managed hooks only)')
  } else {
    try {
      await ensureExtensionsLoaded()
    } catch (err) {
      logForDebugging(`WARNING: extension Setup hooks will not execute: ${String(err)}`)
    }
  }
  const messages: HookResultMessage[] = []
  const additionalContexts: string[] = []
  for await (const result of executeSetupHooks(trigger, undefined, undefined, options.forceSyncExecution)) {
    if (result.message) messages.push(result.message)
    if (result.additionalContexts) additionalContexts.push(...result.additionalContexts)
  }
  if (additionalContexts.length > 0) {
    messages.push(
      createAttachmentMessage({
        type: 'hook_additional_context',
        content: additionalContexts,
        hookName: 'Setup',
        toolUseID: 'Setup',
        hookEvent: 'Setup',
      }) as HookResultMessage,
    )
  }
  return messages
}

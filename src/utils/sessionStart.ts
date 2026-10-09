import { ensureExtensionsLoaded } from '../extensions/boot.js'
import { getSessionId } from '../bootstrap/state.js'
import type { HookResultMessage } from '../types/message.js'
import { createAttachmentMessage } from './attachments/orchestrator.js'
import { logForDebugging } from './debug.js'
import { withDiagnosticsTiming } from './diagLogs.js'
import { isBareMode } from './envUtils.js'
import { fireHooks } from './hooks/fire.js'
import { managedHooksOnly } from './hooks/hooksConfigSnapshot.js'
import { hookRowsOfResult } from './hooks/rows.js'
import { updateWatchPaths } from './hooks/fileChangedWatcher.js'
import { logError } from './log.js'
import { getEngineModel } from './model/model.js'

export type SessionStartReason = 'new' | 'resumed'

let firstPrompt: string | undefined

export function takeFirstPrompt(): string | undefined {
  const taken = firstPrompt
  firstPrompt = undefined
  return taken
}

async function loadExtensionHooksGuarded(reason: SessionStartReason): Promise<void> {
  try {
    await withDiagnosticsTiming('session_start_extension_hooks_load', () => ensureExtensionsLoaded())
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err))
    const wrapped = new Error(`Extension hook loading failed at session.start (${reason}): ${original.message}`)
    if (original.stack) wrapped.stack = original.stack
    logError(wrapped)
    logForDebugging(`WARNING: extension session.start hooks will not run. ${original.message}`)
  }
}

export async function runSessionStartHooks(
  reason: SessionStartReason,
  options: { sessionId?: string; model?: string } = {},
): Promise<HookResultMessage[]> {
  if (isBareMode()) return []
  if (managedHooksOnly()) {
    logForDebugging('session.start: extension hook load skipped (managed hooks only)')
  } else {
    await loadExtensionHooksGuarded(reason)
  }
  const sessionId = options.sessionId ?? String(getSessionId())
  const result = await fireHooks('session.start', { reason, model: options.model ?? getEngineModel() }, { scope: { sessionId } })
  const messages: HookResultMessage[] = hookRowsOfResult(result).map(row => createAttachmentMessage(row) as HookResultMessage)
  if (reason === 'new' && result.answer.prompt !== undefined) firstPrompt = result.answer.prompt
  if (result.answer.watch !== undefined && result.answer.watch.length > 0) updateWatchPaths(result.answer.watch)
  return messages
}

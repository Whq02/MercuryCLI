import { ensureExtensionsLoaded } from '../../integrations/extensions/boot.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import type { HookResultMessage } from '../../engine/message-shapes/message.js'
import { createAttachmentMessage } from '../../engine/attachments/turnAttachments.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isBareMode } from '../../platform/environment/envUtils.js'
import { fireHooks } from '../../integrations/event-hooks/fire.js'
import { managedHooksOnly } from '../../integrations/event-hooks/hooksConfigSnapshot.js'
import { hookRowsOfResult } from '../../integrations/event-hooks/rows.js'
import { updateWatchPaths } from '../../integrations/event-hooks/fileChangedWatcher.js'
import { logError } from '../../platform/logs/errorLog.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'

type SessionStartReason = 'new' | 'resumed'

let firstPrompt: string | undefined

export function takeFirstPrompt(): string | undefined {
  const taken = firstPrompt
  firstPrompt = undefined
  return taken
}

async function loadExtensionHooksGuarded(reason: SessionStartReason): Promise<void> {
  try {
    await ensureExtensionsLoaded()
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

// Task + async-hook status — the unified Task-framework attachment feed
// (offsets/evictions applied back to AppState) and delivered async-hook
// responses (registry-cleared after delivery). Owned Mercury module
//

import type { ToolUseContext } from '../../Tool.js'
import {
  checkForAsyncHookResponses,
  removeDeliveredAsyncHooks,
} from '../hooks/AsyncHookRegistry.js'
import { logForDebugging } from '../debug.js'
import { jsonStringify } from '../slowOperations.js'
import { getTaskOutputPath } from '../task/diskOutput.js'
import {
  applyTaskOffsetsAndEvictions,
  generateTaskAttachments,
} from '../task/framework.js'
import type { Attachment } from './types.js'

/**
 * One feed for every tracked task kind — background shells, remote
 * sessions, async agents — through the unified Task framework: generate
 * the per-task attachments, then write the advanced offsets and evictions
 * straight back to AppState so the next turn diffs from here.
 */
export async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(appState)

  applyTaskOffsetsAndEvictions(
    toolUseContext.setAppState,
    updatedTaskOffsets,
    evictedTaskIds,
  )

  // Project the framework's TaskAttachment rows into the attachment union.
  return attachments.map(taskAttachment => ({
    type: 'task_status' as const,
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId),
  }))
}

export async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const responses = await checkForAsyncHookResponses()

  if (responses.length === 0) {
    return []
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${responses.length} responses`,
  )

  const attachments = responses.map(
    ({
      processId,
      response,
      hookName,
      hookEvent,
      toolName,
      extensionId,
      stdout,
      stderr,
      exitCode,
    }) => {
      logForDebugging(
        `Hooks: Creating attachment for ${processId} (${hookName}): ${jsonStringify(response)}`,
      )
      return {
        type: 'async_hook_response' as const,
        processId,
        hookName,
        hookEvent,
        toolName,
        response,
        stdout,
        stderr,
        exitCode,
      }
    },
  )

  // Delivery consumes: dropped from the registry now, or the same response
  // re-attaches every turn.
  if (responses.length > 0) {
    const processIds = responses.map(r => r.processId)
    removeDeliveredAsyncHooks(processIds)
    logForDebugging(
      `Hooks: Removed ${processIds.length} delivered hooks from registry`,
    )
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${attachments.length} attachments`,
  )

  return attachments
}

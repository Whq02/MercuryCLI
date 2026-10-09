import type { ToolUseContext } from '../../Tool.js'
import {
  checkForAsyncHookResponses,
  removeDeliveredAsyncHooks,
} from '../hooks/AsyncHookRegistry.js'
import {
  applyTaskOffsetsAndEvictions,
  generateTaskAttachments,
} from '../task/framework.js'
import type { Attachment } from './types.js'

export async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const { updatedTaskOffsets, evictedTaskIds } = await generateTaskAttachments(toolUseContext.getAppState())
  applyTaskOffsetsAndEvictions(toolUseContext.setAppState, updatedTaskOffsets, evictedTaskIds)
  return []
}

type AsyncHookResponse = Awaited<ReturnType<typeof checkForAsyncHookResponses>>[number]

const asyncHookAttachment = (delivered: AsyncHookResponse): Attachment => ({
  type: 'async_hook_response',
  processId: delivered.processId,
  hookName: delivered.hookName,
  hookEvent: delivered.hookEvent,
  toolName: delivered.toolName,
  response: delivered.response,
  stdout: delivered.stdout,
  stderr: delivered.stderr,
  exitCode: delivered.exitCode,
})

export async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const finished = await checkForAsyncHookResponses()
  if (finished.length === 0) return []
  const attachments = finished.map(asyncHookAttachment)
  removeDeliveredAsyncHooks(finished.map(response => response.processId))
  return attachments
}

import type { ToolUseContext } from '../../Tool.js'
import {
  applyTaskOffsetsAndEvictions,
  generateTaskAttachments,
} from '../task/framework.js'
import type { Attachment } from './types.js'
import { takeBackgroundHookOutcomes } from '../hooks/background.js'
import { hookRowsOf } from '../hooks/rows.js'

export async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const { updatedTaskOffsets, evictedTaskIds } = await generateTaskAttachments(toolUseContext.getAppState())
  applyTaskOffsetsAndEvictions(toolUseContext.setAppState, updatedTaskOffsets, evictedTaskIds)
  return []
}

export function getBackgroundHookAttachments(): Attachment[] {
  return hookRowsOf(takeBackgroundHookOutcomes(), { background: true })
}

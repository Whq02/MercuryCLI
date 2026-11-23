import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { Attachment } from './attachmentTypes.js'
import { takeBackgroundHookOutcomes } from '../../integrations/event-hooks/background.js'
import { hookRowsOf } from '../../integrations/event-hooks/rows.js'
import { applyTaskOffsetsAndEvictions, generateTaskAttachments } from '../task-framework/taskRegistry.js'

export function getBackgroundHookAttachments(): Attachment[] {
  return hookRowsOf(takeBackgroundHookOutcomes(), { background: true })
}

export async function getUnifiedTaskAttachments(context: ToolUseContext): Promise<Attachment[]> {
  return generateTaskAttachments(context.getAppState()).then(sweep => {
    applyTaskOffsetsAndEvictions(context.setAppState, sweep.updatedTaskOffsets, sweep.evictedTaskIds)
    return []
  })
}

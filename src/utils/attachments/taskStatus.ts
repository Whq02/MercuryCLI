import type { ToolUseContext } from '../../Tool.js'
import type { Attachment } from './types.js'
import { takeBackgroundHookOutcomes } from '../hooks/background.js'
import { hookRowsOf } from '../hooks/rows.js'
import { applyTaskOffsetsAndEvictions, generateTaskAttachments } from '../task/framework.js'

export function getBackgroundHookAttachments(): Attachment[] {
  return hookRowsOf(takeBackgroundHookOutcomes(), { background: true })
}

export async function getUnifiedTaskAttachments(context: ToolUseContext): Promise<Attachment[]> {
  return generateTaskAttachments(context.getAppState()).then(sweep => {
    applyTaskOffsetsAndEvictions(context.setAppState, sweep.updatedTaskOffsets, sweep.evictedTaskIds)
    return []
  })
}

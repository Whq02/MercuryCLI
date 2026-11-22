import type { ToolUseContext } from '../../Tool.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { extractDiscoveredToolNames } from '../messages/toolSearch.js'
import { notBuilt } from '../../pi/holes.js'

export async function getToolManualAttachments(context: ToolUseContext, selected?: readonly string[]): Promise<Attachment[]> {
  return notBuilt('src/services/attachments/toolManuals.ts:5')
}

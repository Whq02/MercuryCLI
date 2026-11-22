import { formatFileSize } from '../../../utils/format.js'
import { mapNotebookCellsToToolResult } from '../../../utils/notebook.js'
import { FILE_UNCHANGED_STUB } from '../../../constants/tools/fileRead.js'
import { cyberRiskReminderForCurrentModel } from './reminder.js'
import type { Output } from './schema.js'
import { serializeTextResult } from './serialize.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

export function mapToolResultToToolResultBlockParam(data: Output, toolUseID: string): Unbuilt {
  return notBuilt('src/tools/FileReadTool/read/resultBlock.ts:8')
}

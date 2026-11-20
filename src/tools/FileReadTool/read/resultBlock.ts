import { formatFileSize } from '../../../utils/format.js'
import { mapNotebookCellsToToolResult } from '../../../utils/notebook.js'
import { FILE_UNCHANGED_STUB } from '../prompt.js'
import { cyberRiskReminderForCurrentModel } from './reminder.js'
import type { Output } from './schema.js'
import { serializeTextResult } from './serialize.js'

export function mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
  switch (data.type) {
    case 'image':
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          ...(data.file.caption ? [{ type: 'text' as const, text: data.file.caption }] : []),
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: data.file.type,
              data: data.file.base64,
            },
          },
        ],
      }
    case 'notebook':
      return mapNotebookCellsToToolResult(data.file.cells, toolUseID)
    case 'pdf':
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `PDF file: ${data.file.filePath} (${formatFileSize(data.file.originalSize)}). The document content was provided alongside this result.`,
      }
    case 'parts':
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Extracted ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)}) as images.`,
      }
    case 'file_unchanged':
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `${FILE_UNCHANGED_STUB}${data.file.anchor !== undefined ? `\n(anchor: ${data.file.anchor})` : ''}`,
      }
    case 'text': {
      const body = serializeTextResult(data.file, data)
      if (data.file.content === '') {
        return { tool_use_id: toolUseID, type: 'tool_result' as const, content: body }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `${body}${data.file.reminder ?? cyberRiskReminderForCurrentModel()}`,
      }
    }
  }
}

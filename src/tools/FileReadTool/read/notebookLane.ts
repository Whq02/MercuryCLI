import type { ToolUseContext } from '../../../Tool.js'
import { isRemotePath, remoteShellPath } from '../../../utils/remoteFiles/target.js'
import { getFileModificationTime } from '../../../utils/file.js'
import { formatFileSize } from '../../../utils/format.js'
import { readNotebook } from '../../../utils/notebook.js'
import type { FileReadingLimits } from '../../../utils/fileReadLimits.js'
import type { Input, LaneResult } from './schema.js'
import { MaxFileReadTokenExceededError, tokensOverCap } from './window.js'

function notebookSliceRemedy(notebookPath: string): string {
  const far = remoteShellPath(notebookPath)
  const resolvedPath = far?.path ?? notebookPath
  return `Read a slice of the notebook from ${far === null ? 'the shell' : `a shell on ${far.host}`} instead, e.g.:
- first 10 cells: jq '.cells[:10]' "${resolvedPath}"
- a cell range: jq '.cells[10:20]' "${resolvedPath}"
- the cell count: jq '.cells | length' "${resolvedPath}"
- all code sources: jq -r '.cells[] | select(.cell_type=="code") | .source[]' "${resolvedPath}"`
}

export async function readNotebookLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  context: ToolUseContext,
  declared: FileReadingLimits,
  reserve?: () => FileReadingLimits,
): Promise<LaneResult> {
  const cells = await readNotebook(resolvedPath)
  const content = JSON.stringify(cells)
  const sizeBytes = Buffer.byteLength(content, 'utf8')
  if (sizeBytes > declared.maxSizeBytes) {
    throw new Error(
      `File content (${formatFileSize(sizeBytes)}) exceeds maximum allowed size (${formatFileSize(declared.maxSizeBytes)}). ${notebookSliceRemedy(keyPath)}`,
    )
  }
  const limits = reserve ? reserve() : declared
  const tokens = await tokensOverCap(content, 'json', limits.maxTokens, limits.room !== true)
  if (tokens !== undefined) {
    throw new MaxFileReadTokenExceededError(
      tokens,
      limits.maxTokens,
      `notebook reads have no line window. ${notebookSliceRemedy(keyPath)}`,
    )
  }
  context.readFileState.set(keyPath, {
    content,
    timestamp: getFileModificationTime(resolvedPath),
    offset: input.offset ?? 0,
    limit: input.limit,
  })
  if (!isRemotePath(keyPath)) context.nestedMemoryAttachmentTriggers?.add(keyPath)
  return {
    data: {
      type: 'notebook',
      file: {
        filePath: resolvedPath,
        cells,
      },
    },
  }
}

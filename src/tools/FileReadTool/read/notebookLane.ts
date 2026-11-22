import type { ToolUseContext } from '../../../Tool.js'
import { isRemotePath, remoteShellPath } from '../../../utils/remoteFiles/target.js'
import { getFileModificationTime } from '../../../utils/file.js'
import { formatFileSize } from '../../../utils/format.js'
import { readNotebook } from '../../../utils/notebook.js'
import type { FileReadingLimits } from '../../../utils/fileReadLimits.js'
import type { Input, LaneResult } from './schema.js'
import { MaxFileReadTokenExceededError, tokensOverCap } from './window.js'
import { notBuilt } from '../../../pi/holes.js'

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
  return notBuilt('src/tools/FileReadTool/read/notebookLane.ts:20')
}

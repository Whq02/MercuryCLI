import { buildTool, type ToolUseContext } from '../../Tool.js'
import { isRemotePath, remoteIdentity } from '../../utils/remoteFiles/target.js'
import { getCwd } from '../../utils/cwd.js'
import { hasControlCharacter } from '../../utils/path.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { expandStructuredTargetPath, hostPathOfWriteTarget, isSqliteRowTarget, sqliteRowRewindNote } from '../FileWriteTool/structuredTargets.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools/fileEdit.js'
import { getEditToolDescription } from './prompt.js'
import { inputSchema, outputSchema, type FileEditInput } from './types.js'
import { areFileEditsInputsEquivalent, locateActualString } from '../../utils/fileEditUtils.js'
import { EDIT_RESULT_CLOSE, editResultHead } from './editResult.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import { HUNK_SPAN_ELISION, type Output, type FarHeld, hasText, editMode } from './edit/fileFacts.js'
import { validateEditInput } from './edit/validate.js'
import { editFileCall, type EditToolSelf } from './edit/call.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'
export { isFullReadEntry } from './edit/fileFacts.js'
export { readKnowledgeRefusal } from './edit/readKnowledge.js'
export { matchExactEdit, linesOfHunks } from './edit/exactMatch.js'

export type { Output }

export const APPLIED_NO_REREAD_NOTE =
  'The change is applied and its lines count as read (a failed call would have errored); no Read is needed before the next edit.'

function editToolItself(): EditToolSelf {
  return FileEditTool
}

export const FileEditTool: Unbuilt = unbuilt('src/tools/FileEditTool/FileEditTool.ts:38')

import { buildTool, type Tool, type ToolUseContext } from '../../Tool.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { isRemotePath, remoteIdentity } from '../../utils/remoteFiles/target.js'
import { getCwd } from '../../utils/cwd.js'
import { controlCharacterPathRefusal, hasControlCharacter } from '../../utils/path.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import { memoryWriteRefusal } from '../../utils/memoryFileDetection.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { APPLIED_NO_REREAD_NOTE } from '../FileEditTool/FileEditTool.js'
import {
  expandStructuredTargetPath,
  hostPathOfWriteTarget,
  isSqliteRowTarget,
  parseStructuredWriteTarget,
  prepareSqliteDeletion,
  sqliteRowReadRefusal,
  sqliteRowRewindNote,
  structuredTargetRefusal,
} from './structuredTargets.js'
import { DESCRIPTION, FILE_WRITE_TOOL_NAME, getWriteToolDescription } from '../../constants/tools/fileWrite.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import { writeFileCall } from './write/call.js'
import { inputSchema, outputSchema, type Input, type Output } from './write/schema.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export type { FileWriteToolInput, Output } from './write/schema.js'

function writeToolItself(): Tool {
  return FileWriteTool
}

export const FileWriteTool: Unbuilt = unbuilt('src/tools/FileWriteTool/FileWriteTool.ts:41')

export { DESCRIPTION }

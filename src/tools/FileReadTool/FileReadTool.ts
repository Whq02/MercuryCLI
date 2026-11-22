import { buildTool, type CanUseToolFn, type Tool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { isRemotePath, remoteIdentity } from '../../utils/remoteFiles/target.js'
import { displayAddressedTarget } from '../../utils/file.js'
import { getCwd } from '../../utils/cwd.js'
import { referenceReadDecision } from '../../services/resources/referencePaths.js'
import { getEngineModel } from '../../services/model/model.js'
import { expandPath, hasControlCharacter } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { resolveModelCapabilities } from '../../utils/model/capabilities.js'
import { DESCRIPTION, FILE_READ_TOOL_NAME, LINE_FORMAT_INSTRUCTION, renderPromptTemplate } from '../../constants/tools/fileRead.js'
import { parseRichFormatTarget } from './readRichFormats.js'
import { parseReadQueryTarget } from './readQueryTarget.js'
import { classifyReadTarget, readTargetPromptLines, readTargetsEnabled } from './readTarget.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'
import { inputSchema, type Input, outputSchema } from './read/schema.js'
import { remoteAlso, splitPathRangeSelector } from './read/target.js'
import { validateReadInput } from './read/validate.js'
import { readFileCall } from './read/call.js'

export type { Input, Output } from './read/schema.js'
export { hasImageSignature } from './read/target.js'
export { imageReadCaptions, readImageWithTokenBudget } from './read/image.js'
export { MaxFileReadTokenExceededError } from './read/window.js'
export { registerFileReadListener, resultResolvedNames } from './read/results.js'
export { unresolvedConflictBlocks } from './read/serialize.js'
import { mapToolResultToToolResultBlockParam } from './read/resultBlock.js'
import { passedOver } from '../../utils/passedOver.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


export const FileReadTool: Unbuilt = unbuilt('src/tools/FileReadTool/FileReadTool.ts:41')

function readToolItself(): Tool {
  return FileReadTool
}


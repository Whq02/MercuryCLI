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

export type { FileWriteToolInput, Output } from './write/schema.js'

function writeToolItself(): Tool {
  return FileWriteTool
}

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  strict: true,
  straightQuoteInputs: ['file_path'],
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  async description() {
    return 'Writes a file to the local filesystem.'
  },
  async prompt() {
    return getWriteToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input?: Partial<Input>) {
    return input?.file_path ? `Writing ${input.file_path}` : 'Writing a file'
  },
  isResultTruncated,
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  extractSearchText: () => '',
  getPath(input?: { file_path?: string }): string {
    const filePath = input?.file_path
    if (!filePath) return getCwd()
    return isRemotePath(filePath) ? filePath : hostPathOfWriteTarget(filePath)
  },
  backfillObservableInput(input: Input) {
    if (hasControlCharacter(input.file_path) || windowsPathNeedsPermission(input.file_path)) return
    input.file_path = isRemotePath(input.file_path)
      ? remoteIdentity(input.file_path)
      : expandStructuredTargetPath(input.file_path)
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(FILE_WRITE_TOOL_NAME, input.file_path, null, input, context, 'edit')
    }
    return checkWritePermissionForTool(
      writeToolItself(),
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  async validateInput(input: Input, context: ToolUseContext) {
    const pathRefusal = controlCharacterPathRefusal(input.file_path)
    if (pathRefusal !== null) {
      return { result: false, message: pathRefusal, errorCode: 1 }
    }
    if (isRemotePath(input.file_path)) {
      const { remoteEntryRefusal, remoteValidation } = await import('../../services/remoteFiles/bridge.js')
      const entryRefusal = remoteEntryRefusal(input.file_path.trim())
      if (entryRefusal !== null) {
        return { result: false, message: entryRefusal, errorCode: 1 }
      }
      return remoteValidation(input.file_path, null, 'edit', 'Writing to', context)
    }
    const structuredTarget = parseStructuredWriteTarget(input.file_path)
    const expandedHostPath =
      structuredTarget !== null ? structuredTarget.hostPath : hostPathOfWriteTarget(input.file_path)
    const permissionContext = context.getAppState().toolPermissionContext
    if (structuredTarget !== null && structuredTarget.kind === 'sqlite-row' && structuredTarget.deleting) {
      const writeCheck = checkWritePermissionForTool(
        { name: FILE_WRITE_TOOL_NAME, getPath: () => structuredTarget.hostPath },
        input,
        permissionContext,
      )
      if (writeCheck.behavior === 'deny') {
        return { result: false, message: writeCheck.message, errorCode: 1 }
      }
    }
    const editDeny = matchingRuleForInput(expandedHostPath, permissionContext, 'edit', 'deny')
    if (editDeny) {
      return {
        result: false,
        message: ruleSentence(`Writing to ${input.file_path}`, 'deny', editDeny),
        errorCode: 1,
      }
    }
    const memoryRefusal = memoryWriteRefusal(expandedHostPath)
    if (memoryRefusal) {
      return { result: false, message: memoryRefusal, errorCode: 3 }
    }
    if (structuredTarget !== null) {
      const readRefusal = sqliteRowReadRefusal(structuredTarget, input, context)
      if (readRefusal !== null) return readRefusal
      const targetRefusal = structuredTargetRefusal(structuredTarget, 'write')
      if (targetRefusal !== null) return targetRefusal
      if (structuredTarget.kind === 'sqlite-row' && structuredTarget.deleting) {
        try {
          prepareSqliteDeletion(structuredTarget, input.content, context)
        } catch (error) {
          return {
            result: false,
            message: error instanceof Error ? error.message : String(error),
            errorCode: 4,
          }
        }
      }
      return { result: true }
    }
    if (windowsPathNeedsPermission(expandedHostPath)) {
      return { result: true }
    }
    try {
      const stats = await getFsImplementation().stat(expandedHostPath)
      if (stats.isDirectory()) {
        return {
          result: false,
          message: `The path is a directory, not a file: ${input.file_path}`,
          errorCode: 2,
        }
      }
    } catch {
      return { result: true }
    }
    return { result: true }
  },
  call(input: Input, context: ToolUseContext, canUseTool, parentAssistantMessage) {
    return writeFileCall(input, context, canUseTool, parentAssistantMessage, writeToolItself)
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (output.type === 'not-found') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Row not found at ${output.filePath}; nothing was deleted.`,
      }
    }
    if (output.type === 'delete') {
      let content = `Deleted one SQLite row at ${output.filePath}; the row is absent on read-back.`
      if (output.content !== '') {
        content += ` ${output.content} through foreign keys or triggers.`
      }
      content += ` ${sqliteRowRewindNote(output.originalFile)}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content,
      }
    }
    if (output.type === 'no-change') {
      const content =
        `No changes were made to ${output.filePath}: the file content already matches what was provided, so nothing was written. ${output.noChange?.guidance ?? ''}`.trimEnd()
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content,
        ...(output.noChange?.stop ? { is_error: true } : {}),
      }
    }
    let content =
      output.type === 'create'
        ? `File created successfully at: ${output.filePath}\n${APPLIED_NO_REREAD_NOTE}`
        : `The file ${output.filePath} has been updated successfully. ${APPLIED_NO_REREAD_NOTE}`
    if (isSqliteRowTarget(output.filePath)) {
      content += ` ${sqliteRowRewindNote(output.type === 'create' ? null : output.originalFile)}`
    }
    if (output.diverged === true) {
      content += `\nThe file as read back right after the write differs from what was written (formatted on save); its current content counts as read:\n\n${output.content}`
    }
    content += `\n(anchor: ${mintFileAnchor(output.content)})`
    if (output.parseError !== undefined) {
      content += `\n${output.parseError}`
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
})

export { DESCRIPTION }

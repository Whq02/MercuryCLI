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
import { DESCRIPTION, FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
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
  async description(): Promise<string> {
    return 'Writes a file to the local filesystem.'
  },
  async prompt(): Promise<string> {
    return getWriteToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  isResultTruncated,
  getActivityDescription(input: Partial<Input> | undefined): string {
    return input?.file_path ? `Writing ${input.file_path}` : 'Writing a file'
  },
  getPath(input: Partial<Input> | undefined): string {
    if (isRemotePath(input?.file_path)) return input!.file_path!
    return input?.file_path ? hostPathOfWriteTarget(input.file_path) : getCwd()
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(FILE_WRITE_TOOL_NAME, input.file_path, null, input, context, 'edit')
    }
    return checkWritePermissionForTool(
      {
        name: FILE_WRITE_TOOL_NAME,
        getPath: (i: Partial<Input> | undefined) => (i?.file_path ? hostPathOfWriteTarget(i.file_path) : getCwd()),
      },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  backfillObservableInput(input: Input): void {
    if (hasControlCharacter(input.file_path) || windowsPathNeedsPermission(input.file_path)) return
    input.file_path = isRemotePath(input.file_path) ? remoteIdentity(input.file_path) : expandStructuredTargetPath(input.file_path)
  },
  async validateInput(input: Input, context: ToolUseContext) {
    const pathRefusal = controlCharacterPathRefusal(input.file_path)
    if (pathRefusal !== null) {
      return { result: false as const, message: pathRefusal, errorCode: 1 }
    }
    if (isRemotePath(input.file_path)) {
      const { remoteEntryRefusal, remoteValidation } = await import('../../services/remoteFiles/bridge.js')
      const entry = remoteEntryRefusal(input.file_path.trim())
      if (entry !== null) return { result: false as const, message: entry, errorCode: 1 }
      return remoteValidation(input.file_path, null, 'edit', 'Writing to', context)
    }
    const structuredTarget = parseStructuredWriteTarget(input.file_path)
    const permissionContext = context.getAppState().toolPermissionContext
    if (structuredTarget?.kind === 'sqlite-row' && structuredTarget.deleting) {
      const decision = checkWritePermissionForTool({ name: FILE_WRITE_TOOL_NAME, getPath: () => structuredTarget.hostPath }, input, permissionContext)
      if (decision.behavior === 'deny') return { result: false as const, message: decision.message, errorCode: 1 }
    }
    const expandedPath = hostPathOfWriteTarget(input.file_path)
    const writeDeny = matchingRuleForInput(expandedPath, permissionContext, 'edit', 'deny')
    if (writeDeny) {
      return {
        result: false as const,
        message: ruleSentence(`Writing to ${input.file_path}`, 'deny', writeDeny),
        errorCode: 1,
      }
    }
    const memoryRefusal = memoryWriteRefusal(expandedPath)
    if (memoryRefusal) {
      return { result: false as const, message: memoryRefusal, errorCode: 3 }
    }
    if (structuredTarget !== null) {
      const unreadable = sqliteRowReadRefusal(structuredTarget, input, context)
      if (unreadable !== null) return { result: false as const, message: unreadable.message, errorCode: unreadable.errorCode }
      const refusal = structuredTargetRefusal(structuredTarget, 'write')
      if (refusal !== null) return { result: false as const, message: refusal.message, errorCode: refusal.errorCode }
      if (structuredTarget.kind === 'sqlite-row' && structuredTarget.deleting) {
        try { prepareSqliteDeletion(structuredTarget, input.content, context) }
        catch (error) { return { result: false as const, message: error instanceof Error ? error.message : String(error), errorCode: 4 } }
      }
      return { result: true as const }
    }
    if (windowsPathNeedsPermission(input.file_path)) return { result: true as const }
    let isDirectory = false
    try {
      isDirectory = getFsImplementation().statSync(expandedPath).isDirectory()
    } catch {
      isDirectory = false
    }
    if (isDirectory) {
      return {
        result: false as const,
        message: `The path is a directory, not a file: ${input.file_path}`,
        errorCode: 2,
      }
    }
    return { result: true as const }
  },
  call(input: Input, context: ToolUseContext, canUseTool, parentMessage) {
    return writeFileCall(input, context, canUseTool, parentMessage, writeToolItself)
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    if (data.type === 'delete' || data.type === 'not-found') return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: data.type === 'delete' ? `Deleted one SQLite row at ${data.filePath}; the row is absent on read-back.${data.content === '' ? '' : ` ${data.content} through foreign keys or triggers.`} ${sqliteRowRewindNote(data.originalFile)}` : `Row not found at ${data.filePath}; nothing was deleted.`,
    }
    if (data.type === 'no-change') {
      const guidance = data.noChange?.guidance ?? ''
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content:
          `No changes were made to ${data.filePath}: the file content already matches what was provided, so nothing was written. ${guidance}`.trimEnd(),
        ...(data.noChange?.stop ? { is_error: true } : {}),
      }
    }
    const parseSuffix = data.parseError !== undefined ? `\n${data.parseError}` : ''
    const divergedSuffix = data.diverged === true ? `\nThe file as read back right after the write differs from what was written (formatted on save); its current content counts as read:\n\n${data.content}` : ''
    const anchorSuffix = `\n(anchor: ${mintFileAnchor(data.content)})`
    const rowSuffix = isSqliteRowTarget(data.filePath) ? ` ${sqliteRowRewindNote(data.type === 'create' ? null : data.originalFile)}` : ''
    if (data.type === 'create') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `File created successfully at: ${data.filePath}\n${APPLIED_NO_REREAD_NOTE}${rowSuffix}${divergedSuffix}${anchorSuffix}${parseSuffix}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `The file ${data.filePath} has been updated successfully. ${APPLIED_NO_REREAD_NOTE}${rowSuffix}${divergedSuffix}${anchorSuffix}${parseSuffix}`,
    }
  },
  extractSearchText(): string {
    return ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
})

export { DESCRIPTION }

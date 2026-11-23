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
export { isFullReadEntry } from './edit/fileFacts.js'
export { readKnowledgeRefusal } from './edit/readKnowledge.js'
export { matchExactEdit, linesOfHunks } from './edit/exactMatch.js'

export type { Output }

export const APPLIED_NO_REREAD_NOTE =
  'The change is applied and its lines count as read (a failed call would have errored); no Read is needed before the next edit.'

function editToolItself(): EditToolSelf {
  return FileEditTool
}

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  strict: true,
  keepEmptyInputs: ['old_string', 'new_string'],
  straightQuoteInputs: ['file_path'],
  maxResultSizeChars: 100_000,
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  async description() {
    return 'A tool for editing files'
  },
  async prompt(options) {
    return getEditToolDescription(
      new Set((options?.tools ?? []).map(tool => tool.name)),
      options?.model,
    )
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input?: Partial<FileEditInput>) {
    return input?.file_path ? `Editing ${input.file_path}` : 'Editing a file'
  },
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  getPath(input?: { file_path?: string }) {
    const filePath = input?.file_path
    if (!filePath) return getCwd()
    return isRemotePath(filePath) ? filePath : hostPathOfWriteTarget(filePath)
  },
  async checkPermissions(input: FileEditInput, context: ToolUseContext) {
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(FILE_EDIT_TOOL_NAME, input.file_path, null, input, context, 'edit')
    }
    return checkWritePermissionForTool(editToolItself(), input, context.getAppState().toolPermissionContext)
  },
  backfillObservableInput(input: FileEditInput) {
    if (hasControlCharacter(input.file_path) || windowsPathNeedsPermission(input.file_path)) return
    input.file_path = isRemotePath(input.file_path)
      ? remoteIdentity(input.file_path)
      : expandStructuredTargetPath(input.file_path)
  },
  inputsEquivalent(a: FileEditInput, b: FileEditInput): boolean {
    const modeA = editMode(a)
    const modeB = editMode(b)
    if (modeA !== modeB) return false
    const anchorA = hasText(a.expected_anchor) ? a.expected_anchor : ''
    const anchorB = hasText(b.expected_anchor) ? b.expected_anchor : ''
    if (anchorA !== anchorB) return false
    if (modeA === 'hunks') {
      return a.file_path === b.file_path && JSON.stringify(a.hunks) === JSON.stringify(b.hunks)
    }
    if (modeA === 'append' || modeA === 'section') {
      if (a.file_path !== b.file_path) return false
      const sectionA = hasText(a.section) ? a.section : ''
      const sectionB = hasText(b.section) ? b.section : ''
      if (sectionA !== sectionB) return false
      const appendA = hasText(a.append) ? a.append : ''
      const appendB = hasText(b.append) ? b.append : ''
      if (appendA !== appendB) return false
      if (appendA === '') {
        return (a.new_string ?? '') === (b.new_string ?? '')
      }
      return true
    }
    return areFileEditsInputsEquivalent(
      {
        file_path: a.file_path,
        edits: [
          {
            old_string: a.old_string ?? '',
            new_string: a.new_string ?? '',
            replace_all: a.replace_all ?? false,
          },
        ],
      },
      {
        file_path: b.file_path,
        edits: [
          {
            old_string: b.old_string ?? '',
            new_string: b.new_string ?? '',
            replace_all: b.replace_all ?? false,
          },
        ],
      },
    )
  },
  validateInput(input: FileEditInput, context: ToolUseContext, held?: FarHeld) {
    return validateEditInput(input, context, held)
  },
  call(input: FileEditInput, context: ToolUseContext, canUseTool, parentAssistantMessage) {
    return editFileCall(input, context, canUseTool, parentAssistantMessage, editToolItself)
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (output.noChange !== undefined) {
      let content = `No changes made to ${output.filePath}: the computed result is byte-identical to the current file content, so nothing was written. ${output.noChange.guidance}`
      if (output.readThrough) content += `\n\n${output.readThrough}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content,
        ...(output.noChange.stop ? { is_error: true } : {}),
      }
    }
    const modifiedClause = output.userModified ? ' (the user modified the change before accepting it)' : ''
    let feedback = ''
    if (output.oldString !== '' && !output.oldString.includes(HUNK_SPAN_ELISION)) {
      const match = locateActualString(output.originalFile, output.oldString)
      if (match.kind === 'found' && match.feedback !== null) {
        feedback = ` ${match.feedback}`
      }
    }
    const relocation =
      output.staleRecovery !== undefined
        ? `Your hunks were relocated because the file changed since your read (${output.staleRecovery}) — re-read before further anchored edits.`
        : undefined
    if (output.editedLines === undefined) {
      let content = `The file ${output.filePath} has been updated successfully${modifiedClause}.${feedback}`
      if (relocation !== undefined) content += ` ${relocation}`
      if (output.freshLineAnchors) content += `\n\n${output.freshLineAnchors}`
      if (output.readThrough) content += `\n\n${output.readThrough}`
      if (isSqliteRowTarget(output.filePath)) content += `\n${sqliteRowRewindNote(output.originalFile)}`
      if (output.parseError) content += `\n${output.parseError}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content,
      }
    }
    const parts: string[] = [
      `${editResultHead(output.filePath, modifiedClause, output.editedLines)}${feedback}`,
    ]
    if (output.editedLines.body) parts.push(output.editedLines.body)
    if (relocation !== undefined) parts.push(relocation)
    else if (output.editedLines.readBack === 'same') parts.push(EDIT_RESULT_CLOSE)
    if (isSqliteRowTarget(output.filePath)) parts.push(sqliteRowRewindNote(output.originalFile))
    if (output.parseError) parts.push(output.parseError)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: parts.join('\n'),
    }
  },
  extractSearchText(output: Output): string {
    if (output.noChange !== undefined) return ''
    return output.structuredPatch
      .flatMap(hunk => hunk.lines.map(line => line.replace(/^[ +-]/, '')))
      .join('\n')
  },
})


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
  async description(): Promise<string> {
    return 'A tool for editing files'
  },
  async prompt({ tools, model }): Promise<string> {
    return getEditToolDescription(new Set(tools.map(tool => tool.name)), model)
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input: Partial<FileEditInput> | undefined): string {
    return input?.file_path ? `Editing ${input.file_path}` : 'Editing a file'
  },
  getPath(input: Partial<FileEditInput> | undefined): string {
    if (isRemotePath(input?.file_path)) return input!.file_path!
    return input?.file_path ? hostPathOfWriteTarget(input.file_path) : getCwd()
  },
  async checkPermissions(input: FileEditInput, context: ToolUseContext) {
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(FILE_EDIT_TOOL_NAME, input.file_path, null, input, context, 'edit')
    }
    return checkWritePermissionForTool(
      {
        name: FILE_EDIT_TOOL_NAME,
        getPath: (i: Partial<FileEditInput> | undefined) => (i?.file_path ? hostPathOfWriteTarget(i.file_path) : getCwd()),
      },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  backfillObservableInput(input: FileEditInput): void {
    if (hasControlCharacter(input.file_path) || windowsPathNeedsPermission(input.file_path)) return
    input.file_path = isRemotePath(input.file_path) ? remoteIdentity(input.file_path) : expandStructuredTargetPath(input.file_path)
  },
  inputsEquivalent(a: FileEditInput, b: FileEditInput): boolean {
    const mode = editMode(a)
    if (mode !== editMode(b)) return false
    if ((hasText(a.expected_anchor) ? a.expected_anchor : undefined) !== (hasText(b.expected_anchor) ? b.expected_anchor : undefined)) return false
    if (mode === 'hunks') {
      return a.file_path === b.file_path && JSON.stringify(a.hunks) === JSON.stringify(b.hunks)
    }
    if (mode === 'append' || mode === 'section') {
      return a.file_path === b.file_path &&
        (hasText(a.section) ? a.section : undefined) === (hasText(b.section) ? b.section : undefined) &&
        (hasText(a.append) ? a.append : undefined) === (hasText(b.append) ? b.append : undefined) &&
        (hasText(a.append) ? undefined : a.new_string) === (hasText(b.append) ? undefined : b.new_string)
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
  call(input: FileEditInput, context: ToolUseContext, canUseTool, parentMessage) {
    return editFileCall(input, context, canUseTool, parentMessage, editToolItself)
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    if (data.noChange) {
      const text =
        `No changes made to ${data.filePath}: the computed result is byte-identical to the current file content, so nothing was written. ` +
        data.noChange.guidance
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: data.readThrough !== undefined ? `${text}\n\n${data.readThrough}` : text,
        ...(data.noChange.stop ? { is_error: true } : {}),
      }
    }
    const modifiedClause = data.userModified ? ' (the user modified the change before accepting it)' : ''
    const located = data.oldString === '' || data.oldString.includes(HUNK_SPAN_ELISION) ? null : locateActualString(data.originalFile, data.oldString)
    const forgivenClause = located !== null && located.kind === 'found' && located.feedback !== null ? ` ${located.feedback}` : ''
    const relocated = data.staleRecovery !== undefined ? `Your hunks were relocated because the file changed since your read (${data.staleRecovery}) — re-read before further anchored edits.` : null
    const parseSuffix = `${isSqliteRowTarget(data.filePath) ? `\n${sqliteRowRewindNote(data.originalFile)}` : ''}${data.parseError !== undefined ? `\n${data.parseError}` : ''}`
    if (data.editedLines === undefined) {
      const text = `The file ${data.filePath} has been updated successfully${modifiedClause}.${forgivenClause}${relocated === null ? '' : ` ${relocated}`}`
      const anchored = data.freshLineAnchors !== undefined ? `${text}\n\n${data.freshLineAnchors}` : text
      const content = `${data.readThrough !== undefined ? `${anchored}\n\n${data.readThrough}` : anchored}${parseSuffix}`
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content }
    }
    const head = `${editResultHead(data.filePath, modifiedClause, data.editedLines)}${forgivenClause}`
    const close = relocated ?? (data.editedLines.readBack === 'same' ? EDIT_RESULT_CLOSE : null)
    const content = [head, ...(data.editedLines.body === '' ? [] : [data.editedLines.body]), ...(close === null ? [] : [close]), ...(isSqliteRowTarget(data.filePath) ? [sqliteRowRewindNote(data.originalFile)] : []), ...(data.parseError !== undefined ? [data.parseError] : [])].join('\n')
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content }
  },
  extractSearchText(data: Output): string {
    if (data.noChange) return ''
    return data.structuredPatch
      .flatMap(hunk => hunk.lines)
      .map(line => (/^[+\- ]/.test(line) ? line.slice(1) : line))
      .join('\n')
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
})

import { type UUID } from 'node:crypto'
import { extname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolEffect, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type { NotebookCell, NotebookCellType, NotebookContent } from '../../types/notebook.js'
import type { AssistantMessage } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { getDisplayPath, getFileModificationTime, writeTextContent } from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseCellId } from '../../utils/notebook.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * The one tool that mutates Jupyter notebook cells: replace / insert /
 * delete, with read-before-edit and staleness guards, the team-memory
 * secret guard, and typed effect receipts on every terminal path.
 */

const EDIT_MODES = ['replace', 'insert', 'delete'] as const
type EditMode = (typeof EDIT_MODES)[number]

export const inputSchema = lazySchema(() =>
  z.strictObject({
    notebook_path: z
      .string()
      .describe('Absolute path of the .ipynb file to modify (relative paths are rejected)'),
    cell_id: z
      .string()
      .optional()
      .describe(
        'Which cell to target, by id. For inserts the new cell lands just after this cell — or at the very beginning when no id is given.',
      ),
    new_source: z.string().describe('The content the cell will hold'),
    cell_type: z
      .enum(['code', 'markdown'])
      .optional()
      .describe(
        'Whether the cell is code or markdown; omitted, the existing cell keeps its type. Required for edit_mode=insert.',
      ),
    edit_mode: z
      .enum(EDIT_MODES)
      .optional()
      .describe('The operation: replace, insert, or delete (replace when omitted).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    new_source: z.string().describe('The source written into the cell'),
    cell_id: z.string().optional().describe('The id of the edited or inserted cell'),
    cell_type: z.enum(['code', 'markdown']).describe('The cell type reported for the edit'),
    language: z.string().describe('The notebook\'s language'),
    edit_mode: z.string().describe('The edit mode actually applied'),
    error: z.string().optional().describe('The error message when the edit failed'),
    notebook_path: z.string().describe('The resolved notebook path'),
    original_file: z.string().describe('The notebook content before the edit'),
    updated_file: z.string().describe('The notebook content after the edit'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const DEFAULT_LANGUAGE = 'python'

/** The RAW input value, not the resolved path (lease/permission machinery reads it). */
function notebookPathOf(input: Input): string {
  return input.notebook_path
}

function resolveNotebookPath(notebookPath: string): string {
  return isAbsolute(notebookPath) ? notebookPath : resolve(getCwd(), notebookPath)
}

/** A path beginning with `\\` or `//` — never touched, not even to stat it. */
function isUncShaped(resolvedPath: string): boolean {
  return resolvedPath.startsWith('\\\\') || resolvedPath.startsWith('//')
}

/** Cell ids are supported from nbformat 4.5 upwards. */
function supportsCellIds(notebook: NotebookContent): boolean {
  const major = notebook.nbformat ?? 0
  const minor = notebook.nbformat_minor ?? 0
  return major > 4 || (major === 4 && minor >= 5)
}

function notebookLanguage(notebook: NotebookContent): string {
  return notebook.metadata?.language_info?.name ?? DEFAULT_LANGUAGE
}

function refuse(message: string, errorCode: number): ValidationResult {
  return { result: false, message, errorCode }
}

function effectFor(
  outcome: 'succeeded' | 'failed',
  startedAt: number,
  changedPaths: string[],
  evidence: string,
): ToolEffect {
  return {
    outcome,
    operation: 'notebook.edit',
    changedPaths,
    evidence,
    startedAt,
    completedAt: Date.now(),
  }
}

/** The failure payload every caught error returns (empty before/after, python, replace). */
function failurePayload(input: Input, resolvedPath: string, error: string): Output {
  return {
    new_source: input.new_source,
    cell_id: input.cell_id,
    cell_type: input.cell_type ?? 'code',
    language: DEFAULT_LANGUAGE,
    edit_mode: 'replace',
    error,
    notebook_path: resolvedPath,
    original_file: '',
    updated_file: '',
  }
}

export const NotebookEditTool = buildTool({
  name: NOTEBOOK_EDIT_TOOL_NAME,
  searchHint: 'edit Jupyter notebook .ipynb cells',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName: () => 'Edit Notebook',
  // A deliberate opt-out (unmarked), not the framework default: the
  // classifier never sees notebook content.
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  /** The RAW input value, not the resolved path (lease/permission machinery reads it). */
  getPath: notebookPathOf,
  getToolUseSummary,
  getActivityDescription(input?: Partial<Input>): string {
    return input?.notebook_path
      ? `editing notebook ${getDisplayPath(input.notebook_path)}`
      : 'editing notebook'
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    // The checker reads only the tool's name and path accessor; naming them
    // directly avoids a self-referential initializer.
    return checkWritePermissionForTool(
      { name: NOTEBOOK_EDIT_TOOL_NAME, getPath: notebookPathOf },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  async validateInput(input: Input, context: ToolUseContext): Promise<ValidationResult> {
    const { notebook_path, cell_id, new_source, cell_type, edit_mode } = input
    const resolvedPath = resolveNotebookPath(notebook_path)

    // 1. UNC short-circuit — no filesystem access at all: letting the OS
    //    resolve a network path can make it authenticate to a remote host.
    if (isUncShaped(resolvedPath)) return { result: true }

    // 2. Team-memory secret guard.
    // 3. Extension.
    if (extname(resolvedPath) !== '.ipynb') {
      return refuse(
        `File must be a Jupyter notebook (.ipynb file). For other file types, use the ${FILE_EDIT_TOOL_NAME} tool.`,
        2,
      )
    }

    // 4. Edit mode.
    if (edit_mode !== undefined && !EDIT_MODES.includes(edit_mode)) {
      return refuse('Edit mode must be replace, insert, or delete.', 4)
    }

    // 5. Insert requires a cell type.
    if (edit_mode === 'insert' && !cell_type) {
      return refuse('Cell type is required when using edit_mode=insert.', 5)
    }

    // 6. Read-before-edit.
    const readState = context.readFileState.get(resolvedPath)
    if (!readState) {
      return refuse('File has not been read yet. Read it first before editing it.', 9)
    }

    // 7. Staleness.
    if (getFileModificationTime(resolvedPath) > readState.timestamp) {
      return refuse(
        'The notebook has been modified since it was last read, either by the user or by a linter or formatter. Read it again before attempting to edit it.',
        10,
      )
    }

    // 8. Read (encoding-detected through the metadata-aware reader).
    let content: string
    try {
      content = readFileSyncWithMetadata(resolvedPath).content
    } catch (error) {
      if (isENOENT(error)) return refuse('Notebook does not exist.', 1)
      throw error
    }

    // 9. Parse.
    const parsed = safeParseJSON(content, false) as NotebookContent | null
    if (parsed === null || typeof parsed !== 'object') {
      return refuse('Notebook is not valid JSON.', 6)
    }

    // 10. A cell id is required except for insert.
    if (!cell_id && edit_mode !== 'insert') {
      return refuse('cell_id is required for edit_mode=replace and edit_mode=delete.', 7)
    }

    // 11. The cell must exist: by id, else by positional index.
    if (cell_id) {
      const cells = Array.isArray(parsed.cells) ? parsed.cells : []
      const byId = cells.findIndex(cell => cell.id === cell_id)
      if (byId === -1) {
        const index = parseCellId(cell_id)
        if (index !== undefined) {
          if (index < 0 || index >= cells.length) {
            return refuse(`Cell index ${index} is out of range for this notebook.`, 7)
          }
        } else {
          return refuse(`Cell with ID "${cell_id}" not found in notebook.`, 8)
        }
      }
    }

    return { result: true }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool, parentMessage: AssistantMessage) {
    const startedAt = Date.now()
    const { notebook_path, cell_id, new_source, cell_type, edit_mode } = input
    const resolvedPath = resolveNotebookPath(notebook_path)

    // Outside the error-trapping block: a failure here propagates as a
    // thrown tool error rather than an error-carrying payload.
    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(context.updateFileHistoryState, resolvedPath, parentMessage.uuid as UUID)
    }

    try {
      const { content: originalFile, encoding, lineEndings } = readFileSyncWithMetadata(resolvedPath)

      // The notebook object is mutated in place after parsing.
      let notebook: NotebookContent
      try {
        notebook = jsonParse(originalFile) as NotebookContent
      } catch {
        const payload: Output = {
          new_source,
          cell_id,
          cell_type: cell_type ?? 'code',
          language: DEFAULT_LANGUAGE,
          edit_mode: 'replace',
          error: 'Notebook is not valid JSON.',
          notebook_path: resolvedPath,
          original_file: '',
          updated_file: '',
        }
        return {
          data: payload,
          effect: effectFor('failed', startedAt, [], 'notebook is not valid JSON'),
        }
      }

      const cells: NotebookCell[] = Array.isArray(notebook.cells) ? notebook.cells : (notebook.cells = [])
      const language = notebookLanguage(notebook)

      // Target index: no cell id ⇒ 0 (insert lands at the BEGINNING); else
      // the id match, else the parsed positional index. The insert-after
      // bump applies only when a cell id was supplied.
      let mode: EditMode = edit_mode ?? 'replace'
      let effectiveCellType = cell_type
      let index = 0
      if (cell_id) {
        const byId = cells.findIndex(cell => cell.id === cell_id)
        index = byId !== -1 ? byId : (parseCellId(cell_id) ?? 0)
        if (mode === 'insert') index += 1
      }

      // Replace past the end is promoted to an insert of a code cell.
      if (mode === 'replace' && index === cells.length) {
        mode = 'insert'
        if (!effectiveCellType) effectiveCellType = 'code'
      }

      // Cell ids only when the notebook format supports them.
      let newCellId: string | undefined
      if (supportsCellIds(notebook)) {
        newCellId =
          mode === 'insert'
            ? Math.random().toString(36).substring(2, 15)
            : cell_id
      }

      if (mode === 'delete') {
        cells.splice(index, 1)
      } else if (mode === 'insert') {
        const cellType: NotebookCellType = effectiveCellType ?? 'code'
        const newCell: NotebookCell =
          cellType === 'markdown'
            ? ({
                cell_type: 'markdown',
                ...(newCellId !== undefined ? { id: newCellId } : {}),
                source: new_source,
                metadata: {},
              } as NotebookCell)
            : ({
                cell_type: 'code',
                ...(newCellId !== undefined ? { id: newCellId } : {}),
                source: new_source,
                metadata: {},
                execution_count: null,
                outputs: [],
              } as NotebookCell)
        cells.splice(index, 0, newCell)
      } else {
        const target = cells[index] as NotebookCell & {
          execution_count?: number | null
          outputs?: unknown[]
        }
        target.source = new_source
        // The cell changed, so prior results are invalid.
        if (target.cell_type === 'code') {
          target.execution_count = null
          target.outputs = []
        }
        if (effectiveCellType && effectiveCellType !== target.cell_type) {
          target.cell_type = effectiveCellType
        }
      }

      // The .ipynb convention: indent 1, original encoding and line endings.
      const updatedFile = jsonStringify(notebook, null, 1)
      writeTextContent(resolvedPath, updatedFile, encoding, lineEndings)

      // Cleared offset/limit are load-bearing: the reader dedupes against the
      // recorded window, and a stale window would return an "unchanged" stub
      // while the model's context still holds the pre-edit text.
      context.readFileState.set(resolvedPath, {
        content: updatedFile,
        timestamp: getFileModificationTime(resolvedPath),
        offset: undefined,
        limit: undefined,
      })

      const payload: Output = {
        new_source,
        cell_id: newCellId || undefined,
        // The supplied value or `code` — a replace that omitted cell_type
        // reports `code` even when the edited cell was markdown (observable).
        cell_type: cell_type ?? 'code',
        language,
        edit_mode: mode,
        error: '',
        notebook_path: resolvedPath,
        original_file: originalFile,
        updated_file: updatedFile,
      }
      return {
        data: payload,
        effect: effectFor('succeeded', startedAt, [resolvedPath], `${mode} cell in ${notebook_path}`),
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred while editing notebook'
      return {
        data: failurePayload(input, resolvedPath, message),
        effect: effectFor('failed', startedAt, [], message),
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    if (output.error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: output.error,
        is_error: true,
      }
    }
    let content: string
    switch (output.edit_mode) {
      case 'replace':
        content = `Updated cell ${output.cell_id} with ${output.new_source}`
        break
      case 'insert':
        content = `Inserted cell ${output.cell_id} with ${output.new_source}`
        break
      case 'delete':
        content = `Deleted cell ${output.cell_id}`
        break
      default:
        content = 'Unknown edit mode'
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)

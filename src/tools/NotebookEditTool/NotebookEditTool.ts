import { extname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolEffect, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type { NotebookCell, NotebookCellType, NotebookContent } from '../../types/notebook.js'
import type { AssistantMessage } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { getCheckedFileModificationTime, getDisplayPath, getFileModificationTime, writeTextContent } from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../services/changeTransaction/fileHistory.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseCellId } from '../../utils/notebook.js'
import { controlCharacterPathRefusal } from '../../utils/path.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools/fileEdit.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from './constants.js'
import { notebookTextAfterEdit, sourceInCellShape } from './notebookText.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'


const EDIT_MODES = ['replace', 'insert', 'delete'] as const
type EditMode = (typeof EDIT_MODES)[number]

export const inputSchema = lazySchema(() =>
  z.strictObject({
    notebook_path: z
      .string()
      .describe('.ipynb path (relative paths resolve against working directory)'),
    cell_id: z
      .string()
      .optional()
      .describe(
        'Target cell id; insert places after this cell (omit to insert at start)',
      ),
    new_source: z.string().describe('New cell source'),
    cell_type: z
      .enum(['code', 'markdown'])
      .optional()
      .describe(
        'Required for insert; omitted keeps existing cell type',
      ),
    edit_mode: z
      .enum(EDIT_MODES)
      .optional()
      .describe('Default replace'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    new_source: z.string().describe('The source written into the cell'),
    cell_id: z.string().optional().describe('The id of the edited or inserted cell'),
    cell_type: z.enum(['code', 'markdown']).describe('The cell type reported for the edit'),
    language: z.string().describe("The notebook's language"),
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

function resolveNotebookPath(notebookPath: string): string {
  return isAbsolute(notebookPath) ? notebookPath : resolve(getCwd(), notebookPath)
}

function isUncShaped(resolvedPath: string): boolean {
  return resolvedPath.startsWith('\\\\') || resolvedPath.startsWith('//')
}

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

function cellRefusal(cells: NotebookCell[], cellId: string | undefined, editMode: EditMode | undefined): { message: string; errorCode: number } | null {
  if (!cellId) return editMode === 'insert' ? null : { message: 'cell_id is required for edit_mode=replace and edit_mode=delete.', errorCode: 7 }
  if (cells.some(cell => cell.id === cellId)) return null
  const index = parseCellId(cellId)
  if (index === undefined) return { message: `Cell with ID "${cellId}" not found in notebook.`, errorCode: 8 }
  return index < 0 || index >= cells.length ? { message: `Cell index ${index} is out of range for this notebook.`, errorCode: 7 } : null
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

function isNotebookContent(value: unknown): value is NotebookContent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNotebookContent(content: string, mutable = false): NotebookContent | null {
  const parsed = safeParseJSON(content, false)
  if (!isNotebookContent(parsed)) return null
  return mutable ? structuredClone(parsed) : parsed
}

function failedCall(
  input: Input,
  resolvedPath: string,
  startedAt: number,
  error: string,
  evidence: string = error,
): { data: Output; effect: ToolEffect } {
  return {
    data: {
      new_source: input.new_source,
      cell_id: input.cell_id,
      cell_type: input.cell_type ?? 'code',
      language: DEFAULT_LANGUAGE,
      edit_mode: 'replace',
      error,
      notebook_path: resolvedPath,
      original_file: '',
      updated_file: '',
    },
    effect: effectFor('failed', startedAt, [], evidence),
  }
}

export const NotebookEditTool = buildTool({
  name: NOTEBOOK_EDIT_TOOL_NAME,
  userFacingName: () => 'Edit Notebook',
  searchHint: 'edit Jupyter notebook .ipynb cells',
  shouldDefer: true,
  maxResultSizeChars: 100_000,
  straightQuoteInputs: ['notebook_path'],
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  getToolUseSummary,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  getPath(input?: Partial<Input>) {
    return input?.notebook_path
  },
  getActivityDescription(input?: Partial<Input>) {
    return input?.notebook_path
      ? `editing notebook ${getDisplayPath(input.notebook_path)}`
      : 'editing notebook'
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    return checkWritePermissionForTool(
      { name: NOTEBOOK_EDIT_TOOL_NAME, getPath: () => input.notebook_path },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  async validateInput(input: Input, context: ToolUseContext): Promise<ValidationResult> {
    const control = controlCharacterPathRefusal(input.notebook_path)
    if (control !== null) return refuse(control, 1)

    const resolvedPath = resolveNotebookPath(input.notebook_path)
    if (isUncShaped(resolvedPath)) return { result: true }

    if (extname(resolvedPath) !== '.ipynb') {
      return refuse(
        `File must be a Jupyter notebook (.ipynb file). For other file types, use the ${FILE_EDIT_TOOL_NAME} tool.`,
        2,
      )
    }

    if (input.edit_mode !== undefined && !EDIT_MODES.includes(input.edit_mode)) {
      return refuse('Edit mode must be replace, insert, or delete.', 4)
    }

    if (input.edit_mode === 'insert' && !input.cell_type) {
      return refuse('Cell type is required when using edit_mode=insert.', 5)
    }

    const readState = context.readFileState.get(resolvedPath)
    if (!readState) {
      return refuse('File has not been read yet. Read it first before editing it.', 9)
    }
    const currentMtime = getCheckedFileModificationTime(resolvedPath)
    if (currentMtime > readState.timestamp) {
      return refuse(
        'The notebook has been modified since it was last read, either by the user or by a linter or formatter. Read it again before attempting to edit it.',
        10,
      )
    }

    let content: string
    try {
      content = readFileSyncWithMetadata(resolvedPath).content
    } catch (error) {
      if (isENOENT(error)) return refuse('Notebook does not exist.', 1)
      throw error
    }

    const notebook = readNotebookContent(content)
    if (notebook === null) {
      return refuse('Notebook is not valid JSON.', 6)
    }
    const cells = Array.isArray(notebook.cells) ? notebook.cells : []
    const refusal = cellRefusal(cells, input.cell_id, input.edit_mode)
    if (refusal !== null) return refuse(refusal.message, refusal.errorCode)

    return { result: true }
  },
  async call(
    input: Input,
    context: ToolUseContext,
    _canUseTool,
    parentMessage: AssistantMessage,
  ): Promise<{ data: Output; effect: ToolEffect }> {
    const startedAt = Date.now()
    const resolvedPath = resolveNotebookPath(input.notebook_path)
    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(
        context.updateFileHistoryState,
        resolvedPath,
        parentMessage.uuid,
      )
    }

    try {
      const { content, encoding, lineEndings } = readFileSyncWithMetadata(resolvedPath)
      const notebook = readNotebookContent(content, true)
      if (notebook === null) {
        return failedCall(
          input,
          resolvedPath,
          startedAt,
          'Notebook is not valid JSON.',
          'notebook is not valid JSON',
        )
      }
      if (!Array.isArray(notebook.cells)) {
        notebook.cells = []
      }

      const editMode: EditMode = input.edit_mode ?? 'replace'
      const refusal = cellRefusal(notebook.cells, input.cell_id, editMode)
      if (refusal !== null) {
        return failedCall(input, resolvedPath, startedAt, refusal.message)
      }

      const language = notebookLanguage(notebook)

      let cellIndex: number
      if (!input.cell_id) {
        cellIndex = 0
      } else {
        const byId = notebook.cells.findIndex(cell => cell.id === input.cell_id)
        if (byId !== -1) {
          cellIndex = byId
        } else {
          const parsedIndex = parseCellId(input.cell_id)
          cellIndex = parsedIndex ?? 0
        }
        if (editMode === 'insert') {
          cellIndex += 1
        }
      }

      let effectiveMode: EditMode = editMode
      if (effectiveMode === 'replace' && cellIndex === notebook.cells.length) {
        effectiveMode = 'insert'
      }

      const hasCellIds = supportsCellIds(notebook)
      let resultCellId: string | undefined
      if (hasCellIds) {
        resultCellId =
          effectiveMode === 'insert'
            ? Math.random().toString(36).substring(2, 15)
            : input.cell_id || undefined
      }

      if (effectiveMode === 'delete') {
        notebook.cells.splice(cellIndex, 1)
      } else if (effectiveMode === 'insert') {
        const neighborShape =
          cellIndex > 0
            ? notebook.cells[cellIndex - 1]?.source
            : notebook.cells[0]?.source
        const cellType: NotebookCellType = input.cell_type ?? 'code'
        const newCell: NotebookCell = {
          cell_type: cellType,
          ...(hasCellIds && resultCellId !== undefined ? { id: resultCellId } : {}),
          source: sourceInCellShape(input.new_source, neighborShape),
          metadata: {},
          ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {}),
        }
        notebook.cells.splice(cellIndex, 0, newCell)
      } else {
        const target = notebook.cells[cellIndex]!
        target.source = sourceInCellShape(input.new_source, target.source)
        if (input.cell_type !== undefined) {
          target.cell_type = input.cell_type
        }
        if (target.cell_type === 'code') {
          target.execution_count = null
          target.outputs = []
        } else if (target.cell_type === 'markdown') {
          delete target.execution_count
          delete target.outputs
        }
      }

      const updatedFile = notebookTextAfterEdit(content, notebook, {
        mode: effectiveMode,
        index: cellIndex,
      })
      writeTextContent(resolvedPath, updatedFile, encoding, lineEndings)
      context.readFileState.set(resolvedPath, {
        content: updatedFile,
        timestamp: getFileModificationTime(resolvedPath),
        offset: undefined,
        limit: undefined,
      })

      return {
        data: {
          new_source: input.new_source,
          cell_id: resultCellId,
          cell_type: input.cell_type ?? 'code',
          language,
          edit_mode: effectiveMode,
          error: '',
          notebook_path: resolvedPath,
          original_file: content,
          updated_file: updatedFile,
        },
        effect: effectFor(
          'succeeded',
          startedAt,
          [resolvedPath],
          `${effectiveMode} cell in ${input.notebook_path}`,
        ),
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error occurred while editing notebook'
      return failedCall(input, resolvedPath, startedAt, message)
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
} satisfies ToolDef<InputSchema, Output>)

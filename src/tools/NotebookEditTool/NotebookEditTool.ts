import { type UUID } from 'node:crypto'
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
import { jsonParse } from '../../utils/slowOperations.js'
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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


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

export const outputSchema: Unbuilt = unbuilt('src/tools/NotebookEditTool/NotebookEditTool.ts:62')
export type Output = Unbuilt

const DEFAULT_LANGUAGE: Unbuilt = unbuilt('src/tools/NotebookEditTool/NotebookEditTool.ts:78')

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

export const NotebookEditTool: Unbuilt = unbuilt('src/tools/NotebookEditTool/NotebookEditTool.ts:144')

import * as React from 'react'
import { useMemo } from 'react'
import { basename, relative } from 'node:path'
import { Text } from '../../../screen/themedRenderer.js'
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { NotebookEditTool } from '../../../tools/notebook-edit/NotebookEditTool.js'
import { FilePermissionDialog } from '../file-dialog/FilePermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { NotebookEditDiff } from './NotebookEditDiff.js'

type NotebookEditInput = {
  notebook_path: string
  cell_id?: string
  new_source: string
  cell_type?: string
  edit_mode?: string
}

function parseNotebookInput(input: unknown): NotebookEditInput {
  const result = NotebookEditTool.inputSchema.safeParse(input)
  if (result.success) return result.data as NotebookEditInput
  logError(result.error)
  return { notebook_path: '', cell_id: '', new_source: '' }
}

export function NotebookEditPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
}: PermissionRequestProps): React.ReactNode {
  const parsed = useMemo(
    () => parseNotebookInput(toolUseConfirm.input),
    [toolUseConfirm.input],
  )

  const verb =
    parsed.edit_mode === 'insert'
      ? 'insert this cell into'
      : parsed.edit_mode === 'delete'
        ? 'delete this cell from'
        : 'make this edit to'

  return (
    <FilePermissionDialog<NotebookEditInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title="Edit notebook"
      subtitle={
        parsed.notebook_path === '' ? undefined : relative(getFocusedSessionConnector().workspace().cwd, parsed.notebook_path)
      }
      question={
        <Text bold>
          Do you want to {verb} <Text bold>{basename(parsed.notebook_path)}</Text>?
        </Text>
      }
      content={
        <NotebookEditDiff
          notebook_path={parsed.notebook_path}
          cell_id={parsed.cell_id}
          new_source={parsed.new_source}
          cell_type={parsed.cell_type}
          edit_mode={parsed.edit_mode}
          verbose={verbose}
        />
      }
      path={parsed.notebook_path === '' ? null : parsed.notebook_path}
      parseInput={parseNotebookInput}
    />
  )
}

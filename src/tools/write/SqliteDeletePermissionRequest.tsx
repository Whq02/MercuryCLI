import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { FilePermissionDialog } from '../../permissions/cards/file-dialog/FilePermissionDialog.js'
import { WriteDiff } from '../../permissions/cards/file-write/FileWriteToolDiff.js'
import type { PermissionRequestProps } from '../../permissions/cards/PermissionRequest.js'
import { getDisplayPath } from '../../platform/files/file.js'
import type { FileWriteInput } from './WriteTool.js'
import { hostPathOfWriteTarget, previewSqliteDeletion, SQLITE_ROW_NOT_CHECKPOINTED } from './structuredTargets.js'

const parseInput = (input: unknown): FileWriteInput => input as FileWriteInput

export function SqliteDeletePermissionRequest({ toolUseConfirm, onDone, onReject }: PermissionRequestProps): React.ReactNode {
  const input = parseInput(toolUseConfirm.input)
  const state = useMemo(() => {
    try { return { preview: previewSqliteDeletion(input.file_path), error: null } }
    catch (error) { return { preview: null, error: error instanceof Error ? error.message : String(error) } }
  }, [input.file_path])
  return (
    <FilePermissionDialog<FileWriteInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title="Delete SQLite row"
      subtitle={getDisplayPath(input.file_path)}
      question="Delete this row?"
      content={state.error !== null ? <Text>{state.error}</Text> : state.preview?.exists ? (
        <Box flexDirection="column">
          <WriteDiff file_path={state.preview.path} content="" fileExists={true} oldContent={state.preview.content} />
          {state.preview.reach === '' ? null : <Text>{state.preview.reach}</Text>}
          <Text>{SQLITE_ROW_NOT_CHECKPOINTED}</Text>
        </Box>
      ) : <Text>Row not found; nothing will be deleted.</Text>}
      path={hostPathOfWriteTarget(input.file_path)}
      parseInput={parseInput}
      canApprove={state.error === null}
    />
  )
}

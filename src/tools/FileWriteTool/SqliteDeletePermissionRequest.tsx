import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { FilePermissionDialog } from '../../components/permissions/FilePermissionDialog/FilePermissionDialog.js'
import { FileWriteToolDiff } from '../../components/permissions/FileWritePermissionRequest/FileWriteToolDiff.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { getDisplayPath } from '../../utils/file.js'
import type { FileWriteToolInput } from './FileWriteTool.js'
import { hostPathOfWriteTarget, previewSqliteDeletion, SQLITE_ROW_NOT_CHECKPOINTED } from './structuredTargets.js'

const parseInput = (input: unknown): FileWriteToolInput => input as FileWriteToolInput

export function SqliteDeletePermissionRequest({ toolUseConfirm, onDone, onReject, workerBadge }: PermissionRequestProps): React.ReactNode {
  const input = parseInput(toolUseConfirm.input)
  const state = useMemo(() => {
    try { return { preview: previewSqliteDeletion(input.file_path), error: null } }
    catch (error) { return { preview: null, error: error instanceof Error ? error.message : String(error) } }
  }, [input.file_path])
  return (
    <FilePermissionDialog<FileWriteToolInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title="Delete SQLite row"
      subtitle={getDisplayPath(input.file_path)}
      question="Delete this row?"
      content={state.error !== null ? <Text>{state.error}</Text> : state.preview?.exists ? (
        <Box flexDirection="column">
          <FileWriteToolDiff file_path={state.preview.path} content="" fileExists={true} oldContent={state.preview.content} />
          {state.preview.reach === '' ? null : <Text>{state.preview.reach}</Text>}
          <Text>{SQLITE_ROW_NOT_CHECKPOINTED}</Text>
        </Box>
      ) : <Text>Row not found; nothing will be deleted.</Text>}
      path={hostPathOfWriteTarget(input.file_path)}
      parseInput={parseInput}
      workerBadge={workerBadge}
      canApprove={state.error === null}
    />
  )
}

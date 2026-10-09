import * as React from 'react'
import { useMemo } from 'react'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { isENOENT } from '../../../utils/errors.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { FileWriteToolDiff } from './FileWriteToolDiff.js'

type WriteToolInput = {
  file_path: string
  content: string
}

function parseWriteInput(input: unknown): WriteToolInput {
  return input as WriteToolInput
}

function readExisting(filePath: string): { exists: boolean; content: string } {
  try {
    return { exists: true, content: readFileSync(filePath, 'utf8') }
  } catch (error) {
    if (isENOENT(error)) return { exists: false, content: '' }
    throw error
  }
}

export function FileWritePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const parsed = useMemo(
    () => parseWriteInput(toolUseConfirm.input),
    [toolUseConfirm.input],
  )

  const existing = useMemo(() => readExisting(parsed.file_path), [parsed.file_path])

  const verb = existing.exists ? 'overwrite' : 'create'
  return (
    <FilePermissionDialog<WriteToolInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title={existing.exists ? 'Overwrite file' : 'Create file'}
      subtitle={relative(getFocusedSessionConnector().workspace().cwd, parsed.file_path)}
      question={
        <Text bold>
          Do you want to {verb} <Text bold>{basename(parsed.file_path)}</Text>?
        </Text>
      }
      content={
        <FileWriteToolDiff
          file_path={parsed.file_path}
          content={parsed.content}
          fileExists={existing.exists}
          oldContent={existing.content}
        />
      }
      path={parsed.file_path}
      parseInput={parseWriteInput}
      workerBadge={workerBadge}
    />
  )
}

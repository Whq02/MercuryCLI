import * as React from 'react'
import { useMemo } from 'react'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { isRemotePath, remoteLastRead } from '../../../services/remoteFiles/target.js'
import { isENOENT } from '../../../utils/errors.js'
import { displayAddressedTarget } from '../../../utils/file.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { RemotePathSubtitle } from '../RemotePathSubtitle.js'
import { FileWriteToolDiff } from './FileWriteToolDiff.js'
import { parseStructuredWriteTarget } from '../../../tools/FileWriteTool/structuredTargets.js'
import { SqliteDeletePermissionRequest } from '../../../tools/FileWriteTool/SqliteDeletePermissionRequest.js'

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

export function FileWritePermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const input = parseWriteInput(props.toolUseConfirm.input)
  const target = input.file_path.endsWith('#delete') ? parseStructuredWriteTarget(input.file_path) : null
  return target?.kind === 'sqlite-row' && target.deleting ? <SqliteDeletePermissionRequest {...props} /> : <PlainFileWritePermissionRequest {...props} />
}

function PlainFileWritePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const parsed = useMemo(
    () => parseWriteInput(toolUseConfirm.input),
    [toolUseConfirm.input],
  )

  const remote = isRemotePath(parsed.file_path)
  const lastRead = remoteLastRead(toolUseConfirm.toolUseContext.readFileState, parsed.file_path)
  const existing = useMemo(
    () => (remote ? { exists: lastRead !== null, content: lastRead ?? '' } : readExisting(parsed.file_path)),
    [parsed.file_path, remote, lastRead],
  )

  const row = useMemo(() => !remote && parseStructuredWriteTarget(parsed.file_path)?.kind === 'sqlite-row', [parsed.file_path, remote])
  const verb = existing.exists ? 'overwrite' : 'create'
  return (
    <FilePermissionDialog<WriteToolInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title={remote ? 'Edit file' : row ? 'Write SQLite row' : existing.exists ? 'Overwrite file' : 'Create file'}
      subtitle={remote ? <RemotePathSubtitle path={parsed.file_path} /> : displayAddressedTarget(parsed.file_path, container => relative(getFocusedSessionConnector().workspace().cwd, container))}
      question={
        remote ? undefined : row ? 'Write this row?' : (
          <Text bold>
            Do you want to {verb} <Text bold>{basename(parsed.file_path)}</Text>?
          </Text>
        )
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

import * as React from 'react'
import { useMemo } from 'react'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../screen/themedRenderer.js'
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js'
import { isRemotePath, remoteLastRead } from '../../../platform/remote-file-target/target.js'
import { isENOENT } from '../../../platform/errors/errors.js'
import { displayAddressedTarget } from '../../../platform/files/file.js'
import { FilePermissionDialog } from '../file-dialog/FilePermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { RemotePathSubtitle } from '../RemotePathSubtitle.js'
import { WriteDiff } from './FileWriteToolDiff.js'
import { parseStructuredWriteTarget } from '../../../tools/write/structuredTargets.js'
import { SqliteDeletePermissionRequest } from '../../../tools/write/SqliteDeletePermissionRequest.js'

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
        <WriteDiff
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

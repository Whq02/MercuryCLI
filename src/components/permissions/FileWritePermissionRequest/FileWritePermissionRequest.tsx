import * as React from 'react'
import { useMemo } from 'react'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { isENOENT } from '../../../utils/errors.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import {
  createSingleEditDiffConfig,
  type FileEdit,
  type IDEDiffSupport,
} from '../FilePermissionDialog/ideDiffConfig.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { FileWriteToolDiff } from './FileWriteToolDiff.js'

type WriteToolInput = {
  file_path: string
  content: string
}

function parseWriteInput(input: unknown): WriteToolInput {
  return input as WriteToolInput
}

/** A missing file (ENOENT ONLY) means create; any other read error
 *  propagates rather than masquerading as "file missing". */
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
  toolUseContext,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const parsed = useMemo(
    () => parseWriteInput(toolUseConfirm.input),
    [toolUseConfirm.input],
  )

  // ONE read per target: the card re-renders on every keystroke, and an
  // unmemoized read would be unbounded in the file's size.
  const existing = useMemo(() => readExisting(parsed.file_path), [parsed.file_path])

  const ideDiffSupport = useMemo<IDEDiffSupport<WriteToolInput>>(
    () => ({
      getConfig: input => {
        const before = readExisting(input.file_path)
        return createSingleEditDiffConfig(input.file_path, before.content, input.content)
      },
      applyChanges: (input, modifiedEdits: FileEdit[]) => {
        const first = modifiedEdits[0]
        if (!first) return input
        return { ...input, content: first.new_string }
      },
    }),
    [],
  )

  const verb = existing.exists ? 'overwrite' : 'create'
  return (
    <FilePermissionDialog<WriteToolInput>
      toolUseConfirm={toolUseConfirm}
      toolUseContext={toolUseContext}
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
      completionType="write_file_single"
      ideDiffSupport={ideDiffSupport}
      path={parsed.file_path}
      parseInput={parseWriteInput}
      workerBadge={workerBadge}
    />
  )
}

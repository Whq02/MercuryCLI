import * as React from 'react'
import { useMemo } from 'react'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../ink.js'
import { ConsentFileEditDiff } from '../ConsentFileEditDiff.js'
import {
  hunksToEdits,
  planHunks,
  type EditHunkInput,
} from '../../../services/changeTransaction/hunks.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { FileEdit } from '../../../tools/FileEditTool/types.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type EditToolInput = {
  file_path: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  hunks?: EditHunkInput[]
  expected_anchor?: string
}

function parseEditInput(input: unknown): EditToolInput {
  return input as EditToolInput
}

function previewEditsFor(input: EditToolInput): FileEdit[] {
  if (input.hunks && input.hunks.length > 0) {
    try {
      const content = readFileSync(input.file_path, 'utf8').replaceAll('\r\n', '\n')
      const plan = planHunks(content, input.hunks, input.expected_anchor)
      if (plan.ok) return hunksToEdits(content, plan)
    } catch {
    }
    return input.hunks.map(hunk => ({
      old_string: `lines ${hunk.lines}`,
      new_string: hunk.replace,
      replace_all: false,
    }))
  }
  return [
    {
      old_string: input.old_string ?? '',
      new_string: input.new_string ?? '',
      replace_all: input.replace_all ?? false,
    },
  ]
}

export function FileEditPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const parsed = useMemo(
    () => parseEditInput(toolUseConfirm.input),
    [toolUseConfirm.input],
  )
  const previewEdits = useMemo(() => previewEditsFor(parsed), [parsed])

  return (
    <FilePermissionDialog<EditToolInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title="Edit file"
      subtitle={relative(getFocusedSessionConnector().workspace().cwd, parsed.file_path)}
      question={
        <Text bold>
          Do you want to make this edit to <Text bold>{basename(parsed.file_path)}</Text>?
        </Text>
      }
      content={<ConsentFileEditDiff file_path={parsed.file_path} edits={previewEdits} />}
      completionType="str_replace_single"
      path={parsed.file_path}
      parseInput={parseEditInput}
      workerBadge={workerBadge}
    />
  )
}

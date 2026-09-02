import * as React from 'react'
import { useCallback, useMemo } from 'react'
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
import type { FileEdit, IDEDiffSupport } from '../FilePermissionDialog/ideDiffConfig.js'
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

/**
 * The TRUTHFUL preview: hunks are planned against the file's current bytes
 * (CRLF normalised to LF, the input's expected anchor honoured) and become
 * exact old/new pairs; when the file is unreadable or the plan fails, a
 * structural per-hunk representation stands in. Classic old/new input is one
 * edit with both sides defaulted to empty and replace-all defaulted false.
 */
function previewEditsFor(input: EditToolInput): FileEdit[] {
  if (input.hunks && input.hunks.length > 0) {
    try {
      const content = readFileSync(input.file_path, 'utf8').replaceAll('\r\n', '\n')
      const plan = planHunks(content, input.hunks, input.expected_anchor)
      if (plan.ok) return hunksToEdits(content, plan)
    } catch {
      // unreadable — fall through to the structural form
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
  toolUseContext,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const parsed = useMemo(
    () => parseEditInput(toolUseConfirm.input),
    [toolUseConfirm.input],
  )
  const previewEdits = useMemo(() => previewEditsFor(parsed), [parsed])

  const getConfig = useCallback(
    (input: EditToolInput) => ({
      filePath: input.file_path,
      edits: previewEditsFor(input),
      editMode:
        input.hunks && input.hunks.length > 0 ? ('multiple' as const) : ('single' as const),
    }),
    [],
  )
  const applyChanges = useCallback((input: EditToolInput, modifiedEdits: FileEdit[]) => {
    // Hunks mode returns the input unchanged — hunk addresses would drift if
    // a modified edit list were mapped back onto them.
    if (input.hunks && input.hunks.length > 0) return input
    const first = modifiedEdits[0]
    if (!first) return input
    return {
      ...input,
      old_string: first.old_string,
      new_string: first.new_string,
      replace_all: first.replace_all,
    }
  }, [])
  const ideDiffSupport = useMemo<IDEDiffSupport<EditToolInput>>(
    () => ({ getConfig, applyChanges }),
    [getConfig, applyChanges],
  )

  return (
    <FilePermissionDialog<EditToolInput>
      toolUseConfirm={toolUseConfirm}
      toolUseContext={toolUseContext}
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
      ideDiffSupport={ideDiffSupport}
      path={parsed.file_path}
      parseInput={parseEditInput}
      workerBadge={workerBadge}
    />
  )
}

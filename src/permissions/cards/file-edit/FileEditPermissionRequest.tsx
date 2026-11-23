import * as React from 'react'
import { useMemo } from 'react'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { Text } from '../../../screen/themedRenderer.js'
import { ConsentFileEditDiff } from '../ConsentFileEditDiff.js'
import {
  applyHunks,
  hunksToEdits,
  planHunks,
  type EditHunkInput,
} from '../../../tools/engines/change-transaction/hunks.js'
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js'
import { isRemotePath, remoteLastRead } from '../../../platform/remote-file-target/target.js'
import { isENOENT } from '../../../platform/errors/errors.js'
import { displayAddressedTarget } from '../../../platform/files/file.js'
import { FilePermissionDialog } from '../file-dialog/FilePermissionDialog.js'
import { planAppend, planSectionEdit } from '../../../tools/edit/sectionEdit.js'
import { getPatchForEdits, type FileEdit } from '../../../tools/edit/call/editMatching.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { RemotePathSubtitle } from '../RemotePathSubtitle.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

type EditToolInput = {
  file_path: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  hunks?: EditHunkInput[]
  expected_anchor?: string
  append?: string
  section?: string
}

function parseEditInput(input: unknown): EditToolInput {
  return input as EditToolInput
}

function currentContentOf(path: string): { ok: true; content: string } | { ok: false; reason: string } {
  try {
    return { ok: true, content: readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n') }
  } catch (error) {
    if (isENOENT(error)) return { ok: true, content: '' }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export type PreviewEditOutcome =
  | { kind: 'edits'; edits: FileEdit[] }
  | { kind: 'unreadable'; message: string }

function previewAppendOrSection(input: EditToolInput): PreviewEditOutcome {
  const read = currentContentOf(input.file_path)
  if (!read.ok) {
    return { kind: 'unreadable', message: `Could not read ${basename(input.file_path)} to preview this edit (${read.reason})` }
  }
  const content = read.content
  const hasAppend = typeof input.append === 'string' && input.append.length > 0
  const hasSection = typeof input.section === 'string' && input.section.length > 0
  let updated: string
  if (hasSection) {
    const plan = planSectionEdit(content, input.section ?? '', hasAppend ? { append: input.append ?? '' } : { replace: input.new_string ?? '' })
    if (!plan.ok) return { kind: 'edits', edits: [{ old_string: content, new_string: content, replace_all: false }] }
    updated = plan.updated
  } else {
    updated = planAppend(content, input.append ?? '')
  }
  return { kind: 'edits', edits: [{ old_string: content, new_string: updated, replace_all: false }] }
}

function remotePreviewEditsFor(input: EditToolInput): FileEdit[] {
  const closed = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`)
  const appended = typeof input.append === 'string' && input.append.length > 0 ? input.append : null
  if (typeof input.section === 'string' && input.section.length > 0) {
    const heading = closed(input.section)
    return [{ old_string: heading, new_string: appended === null ? (input.new_string ?? '') : `${heading}${appended}`, replace_all: false }]
  }
  if (appended !== null) return [{ old_string: '', new_string: appended, replace_all: false }]
  if (input.hunks && input.hunks.length > 0) {
    return input.hunks.map(hunk => {
      const lines = `lines ${hunk.lines}\n`
      const body = closed(hunk.replace)
      return { old_string: lines, new_string: hunk.insert === 'before' ? `${body}${lines}` : hunk.insert === 'after' ? `${lines}${body}` : body, replace_all: false }
    })
  }
  return [{ old_string: input.old_string ?? '', new_string: input.new_string ?? '', replace_all: input.replace_all ?? false }]
}

function lastReadPreviewEditsFor(input: EditToolInput, content: string): FileEdit[] | null {
  const appended = typeof input.append === 'string' && input.append.length > 0 ? input.append : null
  let updated: string | null = null
  try {
    if (typeof input.section === 'string' && input.section.length > 0) {
      const plan = planSectionEdit(content, input.section, appended === null ? { replace: input.new_string ?? '' } : { append: appended })
      if (plan.ok) updated = plan.updated
    } else if (appended !== null) {
      updated = planAppend(content, appended)
    } else if (input.hunks && input.hunks.length > 0) {
      const plan = planHunks(content, input.hunks, input.expected_anchor)
      if (plan.ok) updated = applyHunks(content, plan)
    } else {
      const edits = [{ old_string: input.old_string ?? '', new_string: input.new_string ?? '', replace_all: input.replace_all ?? false }]
      updated = getPatchForEdits({ filePath: input.file_path, fileContents: content, edits }).updatedFile
    }
  } catch (error) {
    passedOver(error)
  }
  return updated === null || updated === content ? null : [{ old_string: content, new_string: updated, replace_all: false }]
}

export function previewEditOutcome(input: EditToolInput, lastRead: string | null): PreviewEditOutcome {
  if (isRemotePath(input.file_path)) {
    return { kind: 'edits', edits: (lastRead === null ? null : lastReadPreviewEditsFor(input, lastRead)) ?? remotePreviewEditsFor(input) }
  }
  if ((typeof input.append === 'string' && input.append.length > 0) || (typeof input.section === 'string' && input.section.length > 0)) {
    return previewAppendOrSection(input)
  }
  if (input.hunks && input.hunks.length > 0) {
    try {
      const content = readFileSync(input.file_path, 'utf8').replaceAll('\r\n', '\n')
      const plan = planHunks(content, input.hunks, input.expected_anchor)
      if (plan.ok) return { kind: 'edits', edits: hunksToEdits(content, plan) }
    } catch (error) {
      passedOver(error)
    }
    return {
      kind: 'edits',
      edits: input.hunks.map(hunk => ({
        old_string: `lines ${hunk.lines}`,
        new_string: hunk.replace,
        replace_all: false,
      })),
    }
  }
  return {
    kind: 'edits',
    edits: [
      {
        old_string: input.old_string ?? '',
        new_string: input.new_string ?? '',
        replace_all: input.replace_all ?? false,
      },
    ],
  }
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
  const lastRead = remoteLastRead(toolUseConfirm.toolUseContext.readFileState, parsed.file_path)
  const preview = useMemo(() => previewEditOutcome(parsed, lastRead), [parsed, lastRead])

  return (
    <FilePermissionDialog<EditToolInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title="Edit file"
      subtitle={
        isRemotePath(parsed.file_path) ? <RemotePathSubtitle path={parsed.file_path} /> : displayAddressedTarget(parsed.file_path, container => relative(getFocusedSessionConnector().workspace().cwd, container))
      }
      question={
        <Text bold>
          Do you want to make this edit to <Text bold>{basename(parsed.file_path)}</Text>?
        </Text>
      }
      content={
        preview.kind === 'edits' ? (
          <ConsentFileEditDiff file_path={parsed.file_path} edits={preview.edits} />
        ) : (
          <Text color="warning">{preview.message}</Text>
        )
      }
      path={parsed.file_path}
      parseInput={parseEditInput}
      workerBadge={workerBadge}
    />
  )
}

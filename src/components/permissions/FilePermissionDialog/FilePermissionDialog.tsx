import * as React from 'react'
import { useMemo } from 'react'
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { isRemotePath } from '../../../utils/remoteFiles/target.js'
import { expandPath } from '../../../utils/path.js'
import { isSqliteRowTarget, SQLITE_ROW_NOT_CHECKPOINTED } from '../../../tools/FileWriteTool/structuredTargets.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type { WorkerBadgeProps } from '../WorkerBadge.js'
import type { FileOperationType, ToolInput } from './permissionOptions.js'
import { useFilePermissionDialog } from './useFilePermissionDialog.js'
import { passedOver } from '../../../utils/passedOver.js'

type FilePermissionDialogProps<T extends ToolInput> = {
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
  title: string
  subtitle?: React.ReactNode
  question?: React.ReactNode
  content: React.ReactNode
  path: string | null
  parseInput: (input: unknown) => T
  operationType?: FileOperationType
  workerBadge?: WorkerBadgeProps
  canApprove?: boolean
}

export function resolveSymlinkTarget(path: string | null): string | undefined {
  if (path === null || isRemotePath(path)) return undefined
  try {
    const expanded = expandPath(path)
    if (!lstatSync(expanded).isSymbolicLink()) return undefined
    try {
      return realpathSync(expanded)
    } catch {
      return resolve(dirname(expanded), readlinkSync(expanded))
    }
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function FilePermissionDialog<T extends ToolInput>({
  toolUseConfirm,
  onDone,
  onReject,
  title,
  subtitle,
  question = 'Do you want to proceed?',
  content,
  path,
  parseInput,
  operationType = 'write',
  workerBadge,
  canApprove = true,
}: FilePermissionDialogProps<T>): React.ReactNode {
  const {
    options,
    onChange,
    acceptFeedback,
    rejectFeedback,
    focusedOption,
    setFocusedOption,
    handleInputModeToggle,
    yesInputMode,
    noInputMode,
  } = useFilePermissionDialog({
    filePath: path,
    toolUseConfirm,
    onDone,
    onReject,
    parseInput,
    operationType,
    canApprove,
  })

  const parsedInput = useMemo(
    () => parseInput(toolUseConfirm.input),
    [parseInput, toolUseConfirm.input],
  )

  const rawFilePath =
    typeof toolUseConfirm.input === 'object' && toolUseConfirm.input !== null
      ? toolUseConfirm.input.file_path
      : undefined
  const showSqliteNote =
    operationType === 'write' &&
    typeof rawFilePath === 'string' &&
    !rawFilePath.endsWith('#delete') &&
    isSqliteRowTarget(rawFilePath)

  const symlinkTarget = useMemo(() => resolveSymlinkTarget(path), [path])
  const symlinkOutside = useMemo(() => {
    if (symlinkTarget === undefined) return false
    const cwd = getFocusedSessionConnector().workspace().cwd
    return relative(cwd, symlinkTarget).startsWith('..')
  }, [symlinkTarget])

  const handleChange = (value: string): void => {
    const selected = options.find(candidate => candidate.value === value)
    if (!selected) return
    let feedback: string | undefined
    if (selected.option.type === 'accept-once') {
      feedback = acceptFeedback.trim() || undefined
    } else if (selected.option.type === 'reject') {
      feedback = rejectFeedback.trim() || undefined
    }
    onChange(selected.option, parsedInput, feedback)
  }

  const handleCancel = (): void => {
    onChange({ type: 'reject' }, parsedInput)
  }

  const showTabAmend =
    (focusedOption === 'accept-once' && !yesInputMode) ||
    (focusedOption === 'reject' && !noInputMode)
  const footerText = showTabAmend
    ? '↑↓ move · pgup/pgdn page · ↵ confirm · esc cancel · tab amend'
    : '↑↓ move · pgup/pgdn page · ↵ confirm · esc cancel'

  return (
    <PermissionDialog
      title={title}
      subtitle={subtitle}
      crewmate={toolUseConfirm.crewmate}
      workerBadge={workerBadge}
    >
      {content}
      {showSqliteNote ? <Text dimColor>{SQLITE_ROW_NOT_CHECKPOINTED}</Text> : null}
      {symlinkTarget !== undefined ? (
        <Text color="warning">
          {symlinkOutside
            ? `This operation will modify ${symlinkTarget} — outside the working directory via a symlink`
            : `Symlink target: ${symlinkTarget}`}
        </Text>
      ) : null}
      <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />
      {typeof question === 'string' ? <Text bold>{question}</Text> : question}
      <Select
        scrollMovesFocus={false}
        options={options}
        onChange={handleChange}
        onCancel={handleCancel}
        onFocus={setFocusedOption}
        onInputModeToggle={handleInputModeToggle}
      />
      <Box marginTop={1}>
        <Text color="subtle">{footerText}</Text>
      </Box>
    </PermissionDialog>
  )
}

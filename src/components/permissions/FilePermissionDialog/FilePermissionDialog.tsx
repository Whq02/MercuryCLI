import * as React from 'react'
import { useMemo } from 'react'
import { lstatSync, realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { expandPath } from '../../../utils/path.js'
import type { CompletionType } from '../../../utils/unaryLogging.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type { WorkerBadgeProps } from '../WorkerBadge.js'
import type { FileOperationType, ToolInput } from './permissionOptions.js'
import { useFilePermissionDialog } from './useFilePermissionDialog.js'

export type FilePermissionDialogProps<T extends ToolInput> = {
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
  title: string
  subtitle?: React.ReactNode
  question?: React.ReactNode
  content: React.ReactNode
  completionType?: CompletionType
  languageName?: string | Promise<string>
  operationType?: FileOperationType
  path: string | null
  parseInput: (input: unknown) => T
  workerBadge?: WorkerBadgeProps
}

export function FilePermissionDialog<T extends ToolInput>({
  toolUseConfirm,
  onDone,
  onReject,
  title,
  subtitle,
  question = 'Do you want to proceed?',
  content,
  completionType = 'tool_use_single',
  languageName,
  operationType = 'write',
  path,
  parseInput,
  workerBadge,
}: FilePermissionDialogProps<T>): React.ReactNode {
  const dialog = useFilePermissionDialog<T>({
    filePath: path,
    completionType,
    languageName,
    toolUseConfirm,
    onDone,
    onReject,
    parseInput,
    operationType,
  })

  const parsedInput = useMemo(
    () => parseInput(toolUseConfirm.input),
    [parseInput, toolUseConfirm.input],
  )

  const symlinkTarget = useMemo(() => {
    if (operationType === 'read' || path === null) return undefined
    try {
      const expanded = expandPath(path)
      if (!lstatSync(expanded).isSymbolicLink()) return undefined
      return realpathSync(expanded)
    } catch {
      return undefined
    }
  }, [operationType, path])
  const symlinkEscapes =
    symlinkTarget !== undefined && relative(getFocusedSessionConnector().workspace().cwd, symlinkTarget).startsWith('..')

  const focused = dialog.options.find(option => option.value === dialog.focusedOption)
  const showAmendHint =
    (focused?.option.type === 'accept-once' && !dialog.yesInputMode) ||
    (focused?.option.type === 'reject' && !dialog.noInputMode)

  return (
    <Box flexDirection="column">
      <PermissionDialog title={title} subtitle={subtitle} workerBadge={workerBadge}>
        <Box flexDirection="column">
          {content}
          {symlinkTarget !== undefined ? (
            <Text color="warning">
              {symlinkEscapes
                ? `This operation will modify ${symlinkTarget} — outside the working directory via a symlink`
                : `Symlink target: ${symlinkTarget}`}
            </Text>
          ) : null}
          <PermissionRuleExplanation
            permissionResult={toolUseConfirm.permissionResult}
            toolType={operationType === 'read' ? 'read' : 'edit'}
          />
          {typeof question === 'string' ? <Text bold>{question}</Text> : question}
          <Select
            options={dialog.options}
            onChange={value => {
              const option = dialog.options.find(candidate => candidate.value === value)
              if (!option) return
              const feedback =
                option.option.type === 'accept-once'
                  ? dialog.acceptFeedback.trim() || undefined
                  : option.option.type === 'reject'
                    ? dialog.rejectFeedback.trim() || undefined
                    : undefined
              dialog.onChange(option.option, parsedInput, feedback)
            }}
            onCancel={() => dialog.onChange({ type: 'reject' }, parsedInput)}
            onFocus={dialog.setFocusedOption}
            onInputModeToggle={dialog.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box marginTop={1}>
        <Text color="subtle">
          {'esc cancel'}
          {showAmendHint ? ' · tab amend' : ''}
        </Text>
      </Box>
    </Box>
  )
}

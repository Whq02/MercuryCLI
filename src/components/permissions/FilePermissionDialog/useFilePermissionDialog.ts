import { useCallback, useState } from 'react'
import { useAppState } from '../../../state/AppState.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import {
  getFilePermissionOptions,
  type FileOperationType,
  type PermissionOption,
  type PermissionOptionWithLabel,
} from './permissionOptions.js'
import { PERMISSION_HANDLERS, type PermissionHandlerParams } from './usePermissionHandler.js'

type UseFilePermissionDialogResult<T> = {
  options: PermissionOptionWithLabel[]
  onChange: (option: PermissionOption, input: T, feedback?: string) => void
  acceptFeedback: string
  rejectFeedback: string
  focusedOption: string
  setFocusedOption: (value: string) => void
  handleInputModeToggle: (value: string) => void
  yesInputMode: boolean
  noInputMode: boolean
}

export function cycleModeMayApprove(state: { yesInputMode: boolean; noInputMode: boolean }): boolean {
  return !state.yesInputMode && !state.noInputMode
}

export function useFilePermissionDialog<T extends Record<string, unknown>>({
  filePath,
  toolUseConfirm,
  onDone,
  onReject,
  parseInput,
  operationType = 'write',
}: {
  filePath: string | null
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
  parseInput: (input: unknown) => T
  operationType?: FileOperationType
}): UseFilePermissionDialogResult<T> {
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)
  const [acceptFeedback, setAcceptFeedback] = useState('')
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [yesInputMode, setYesInputMode] = useState(false)
  const [noInputMode, setNoInputMode] = useState(false)
  const [focusedOption, setFocusedOptionState] = useState('accept-once')

  usePermissionRequestLogging(toolUseConfirm)

  const options = getFilePermissionOptions({
    filePath,
    toolPermissionContext,
    operationType,
    onAcceptFeedbackChange: setAcceptFeedback,
    onRejectFeedbackChange: setRejectFeedback,
    yesInputMode,
    noInputMode,
  })

  const handleInputModeToggle = useCallback((value: string) => {
    if (value === 'accept-once') {
      setYesInputMode(current => !current)
    } else if (value === 'reject') {
      setNoInputMode(current => !current)
    }
  }, [])

  const setFocusedOption = useCallback(
    (value: string) => {
      if (value !== 'accept-once' && yesInputMode && acceptFeedback.trim() === '') {
        setYesInputMode(false)
      }
      if (value !== 'reject' && noInputMode && rejectFeedback.trim() === '') {
        setNoInputMode(false)
      }
      setFocusedOptionState(value)
    },
    [yesInputMode, noInputMode, acceptFeedback, rejectFeedback],
  )

  const onChange = useCallback(
    (option: PermissionOption, input: T, feedback?: string) => {
      const trimmed = feedback?.trim() || undefined
      const wrapped: ToolUseConfirm = { ...toolUseConfirm, input }
      const params: PermissionHandlerParams = {
        path: filePath,
        toolUseConfirm: wrapped,
        toolPermissionContext,
        onDone,
        onReject,
        operationType,
      }
      PERMISSION_HANDLERS[option.type](params, {
        feedback: trimmed,
        ...(option.type === 'accept-session'
          ? { scope: option.scope, pattern: option.pattern }
          : {}),
      })
    },
    [
      toolUseConfirm,
      filePath,
      toolPermissionContext,
      onDone,
      onReject,
      operationType,
    ],
  )

  const cycleModeArmed = cycleModeMayApprove({ yesInputMode, noInputMode })
  useKeybinding(
    'confirm:cycleMode',
    () => {
      if (!cycleModeArmed) return
      const session = options.find(candidate => candidate.option.type === 'accept-session')
      if (!session) return
      onChange(session.option, parseInput(toolUseConfirm.input))
    },
    { context: 'Confirmation' },
  )

  return {
    options,
    onChange,
    acceptFeedback,
    rejectFeedback,
    focusedOption,
    setFocusedOption,
    handleInputModeToggle,
    yesInputMode,
    noInputMode,
  }
}

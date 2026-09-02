import { useCallback, useState } from 'react'
import { useSetAppState } from '../../state/AppState.js'
import { logUnaryPermissionEvent } from './utils.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

export function useShellPermissionFeedback({
  toolUseConfirm,
  onDone,
  onReject,
  explainerVisible: _explainerVisible,
}: {
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
  explainerVisible?: boolean
}) {
  const setAppState = useSetAppState()
  const [yesInputMode, setYesInputMode] = useState(false)
  const [noInputMode, setNoInputMode] = useState(false)
  const [yesFeedbackModeEntered, setYesFeedbackModeEntered] = useState(false)
  const [noFeedbackModeEntered, setNoFeedbackModeEntered] = useState(false)
  const [acceptFeedback, setAcceptFeedback] = useState('')
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [focusedOption, setFocusedOption] = useState<string>('yes')

  const handleInputModeToggle = useCallback(
    (option: string) => {
      toolUseConfirm.onUserInteraction()
      if (option === 'yes') {
        setYesInputMode(current => !current)
        setYesFeedbackModeEntered(true)
      } else if (option === 'no') {
        setNoInputMode(current => !current)
        setNoFeedbackModeEntered(true)
      }
    },
    [toolUseConfirm],
  )

  const handleFocus = useCallback(
    (value: string) => {
      if (value !== focusedOption) toolUseConfirm.onUserInteraction()
      if (value !== 'yes' && yesInputMode && acceptFeedback.trim() === '') {
        setYesInputMode(false)
      }
      if (value !== 'no' && noInputMode && rejectFeedback.trim() === '') {
        setNoInputMode(false)
      }
      setFocusedOption(value)
    },
    [focusedOption, yesInputMode, noInputMode, acceptFeedback, rejectFeedback, toolUseConfirm],
  )

  const handleReject = useCallback(
    (feedback?: string) => {
      const trimmed = feedback?.trim()
      if (!trimmed) {
        setAppState(prev => ({
          ...prev,
          attribution: {
            ...prev.attribution,
            escapeCount: prev.attribution.escapeCount + 1,
          },
        }))
      }
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject', !!trimmed)
      toolUseConfirm.onReject(trimmed || undefined)
      onReject()
      onDone()
    },
    [toolUseConfirm, onReject, onDone, setAppState],
  )

  return {
    yesInputMode,
    noInputMode,
    yesFeedbackModeEntered,
    noFeedbackModeEntered,
    acceptFeedback,
    rejectFeedback,
    setAcceptFeedback,
    setRejectFeedback,
    focusedOption,
    handleInputModeToggle,
    handleReject,
    handleFocus,
  }
}

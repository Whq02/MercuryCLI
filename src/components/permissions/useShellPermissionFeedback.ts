import { useCallback, useState } from 'react'
import { useSetAppState } from '../../state/AppState.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { useOptionAmendments } from './useOptionAmendments.js'

const AMENDABLE = ['yes', 'no'] as const

type ShellCardArgs = { toolUseConfirm: ToolUseConfirm; onDone: () => void; onReject: () => void }

export function useShellPermissionFeedback({ toolUseConfirm, onDone, onReject }: ShellCardArgs) {
  const setAppState = useSetAppState()
  const { amendments, isRole, setText, toggle, collapseAwayFrom } = useOptionAmendments(AMENDABLE)
  const [focusedOption, setFocusedOption] = useState<string>('yes')

  const setAcceptFeedback = useCallback((text: string) => setText('yes', text), [setText])
  const setRejectFeedback = useCallback((text: string) => setText('no', text), [setText])

  const handleInputModeToggle = useCallback(
    (option: string) => {
      toolUseConfirm.onUserInteraction()
      if (isRole(option)) toggle(option)
    },
    [toolUseConfirm, isRole, toggle],
  )

  const handleFocus = useCallback(
    (value: string) => {
      if (value !== focusedOption) toolUseConfirm.onUserInteraction()
      collapseAwayFrom(value)
      setFocusedOption(value)
    },
    [focusedOption, toolUseConfirm, collapseAwayFrom],
  )

  const countEscape = useCallback(
    () =>
      setAppState(prev => ({
        ...prev,
        attribution: { ...prev.attribution, escapeCount: prev.attribution.escapeCount + 1 },
      })),
    [setAppState],
  )

  const handleReject = useCallback(
    (feedback?: string) => {
      const text = feedback?.trim() || undefined
      if (text === undefined) countEscape()
      toolUseConfirm.onReject(text)
      onReject()
      onDone()
    },
    [toolUseConfirm, onReject, onDone, countEscape],
  )

  const { yes, no } = amendments
  return { yesInputMode: yes.open, noInputMode: no.open, acceptFeedback: yes.text, rejectFeedback: no.text, setAcceptFeedback, setRejectFeedback, focusedOption, handleInputModeToggle, handleReject, handleFocus }
}

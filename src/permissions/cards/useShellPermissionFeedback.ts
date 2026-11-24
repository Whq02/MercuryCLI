import { useCallback, useState } from 'react'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { useOptionAmendments } from './useOptionAmendments.js'

const AMENDABLE = ['yes', 'no'] as const

type ShellCardArgs = { toolUseConfirm: ToolUseConfirm; onDone: () => void; onReject: () => void }

type ShellPermissionFeedback = {
  yesInputMode: boolean
  noInputMode: boolean
  acceptFeedback: string
  rejectFeedback: string
  setAcceptFeedback: (value: string) => void
  setRejectFeedback: (value: string) => void
  focusedOption: string
  handleInputModeToggle: (value: string) => void
  handleReject: (feedback?: string) => void
  handleFocus: (value: string) => void
}

export function useShellPermissionFeedback({
  toolUseConfirm,
  onDone,
  onReject,
}: ShellCardArgs): ShellPermissionFeedback {
  const { amendments, isRole, setText, toggle, collapseAwayFrom } = useOptionAmendments(AMENDABLE)
  const [focusedOption, setFocusedOption] = useState<string>('yes')

  const setAcceptFeedback = useCallback(
    (value: string) => {
      setText('yes', value)
    },
    [setText],
  )

  const setRejectFeedback = useCallback(
    (value: string) => {
      setText('no', value)
    },
    [setText],
  )

  const handleInputModeToggle = useCallback(
    (value: string) => {
      toolUseConfirm.onUserInteraction()
      if (isRole(value)) {
        toggle(value)
      }
    },
    [toolUseConfirm, isRole, toggle],
  )

  const handleFocus = useCallback(
    (value: string) => {
      if (value === focusedOption) return
      toolUseConfirm.onUserInteraction()
      collapseAwayFrom(value)
      setFocusedOption(value)
    },
    [focusedOption, toolUseConfirm, collapseAwayFrom],
  )

  const handleReject = useCallback(
    (feedback?: string) => {
      const trimmed = feedback?.trim()
      const normalized = trimmed && trimmed.length > 0 ? trimmed : undefined
      toolUseConfirm.onReject(normalized)
      onReject()
      onDone()
    },
    [toolUseConfirm, onReject, onDone],
  )

  return {
    yesInputMode: amendments.yes.open,
    noInputMode: amendments.no.open,
    acceptFeedback: amendments.yes.text,
    rejectFeedback: amendments.no.text,
    setAcceptFeedback,
    setRejectFeedback,
    focusedOption,
    handleInputModeToggle,
    handleReject,
    handleFocus,
  }
}

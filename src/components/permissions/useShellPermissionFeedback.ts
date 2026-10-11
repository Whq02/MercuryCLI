import { useCallback, useState } from 'react'
import { useSetAppState } from '../../state/AppState.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

type AmendableRole = 'yes' | 'no'

type Amendment = { open: boolean; text: string }

type Amendments = Record<AmendableRole, Amendment>

const ROLES: readonly AmendableRole[] = ['yes', 'no']

const CLOSED: Amendment = { open: false, text: '' }

const isAmendableRole = (option: string): option is AmendableRole => ROLES.includes(option as AmendableRole)

const blank = (text: string): boolean => text.trim() === ''

function withRole(
  amendments: Amendments,
  role: AmendableRole,
  change: (current: Amendment) => Amendment,
): Amendments {
  return { ...amendments, [role]: change(amendments[role]) }
}

function collapsedAwayFrom(amendments: Amendments, kept: string): Amendments {
  return ROLES.reduce((state, role) => {
    const amendment = state[role]
    const leaves = role !== kept && amendment.open && blank(amendment.text)
    return leaves ? withRole(state, role, current => ({ ...current, open: false })) : state
  }, amendments)
}

export function useShellPermissionFeedback({
  toolUseConfirm,
  onDone,
  onReject,
}: {
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
}) {
  const setAppState = useSetAppState()
  const [amendments, setAmendments] = useState<Amendments>({ yes: CLOSED, no: CLOSED })
  const [focusedOption, setFocusedOption] = useState<string>('yes')

  const setText = useCallback(
    (role: AmendableRole, text: string) =>
      setAmendments(current => withRole(current, role, amendment => ({ ...amendment, text }))),
    [],
  )
  const setAcceptFeedback = useCallback((text: string) => setText('yes', text), [setText])
  const setRejectFeedback = useCallback((text: string) => setText('no', text), [setText])

  const handleInputModeToggle = useCallback(
    (option: string) => {
      toolUseConfirm.onUserInteraction()
      if (!isAmendableRole(option)) return
      setAmendments(current => withRole(current, option, amendment => ({ ...amendment, open: !amendment.open })))
    },
    [toolUseConfirm],
  )

  const handleFocus = useCallback(
    (value: string) => {
      if (value !== focusedOption) toolUseConfirm.onUserInteraction()
      setAmendments(current => collapsedAwayFrom(current, value))
      setFocusedOption(value)
    },
    [focusedOption, toolUseConfirm],
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

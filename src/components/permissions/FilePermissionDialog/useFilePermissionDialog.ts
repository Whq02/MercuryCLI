/**
 * State + options + dispatch behind the shared file-operation consent dialog.
 * The dispatch hands the handlers a LOCAL copy of the request whose `input`
 * is the parsed (or IDE-modified) input — the shared request object is never
 * mutated, and each dispatch wraps the original afresh.
 */
import { useCallback, useMemo, useState } from 'react'
import { useAppState } from '../../../state/AppState.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { getLanguageName } from '../../../utils/cliHighlight.js'
import type { CompletionType } from '../../../utils/unaryLogging.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import {
  getFilePermissionOptions,
  type FileOperationType,
  type PermissionOption,
  type PermissionOptionWithLabel,
} from './permissionOptions.js'
import { PERMISSION_HANDLERS, type PermissionHandlerParams } from './usePermissionHandler.js'

export type UseFilePermissionDialogResult<T> = {
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

/**
 * May the mode-cycle chord (shift+tab by default) select the session-wide
 * accept? Never while a feedback field is open: reverse-tab inside a text
 * field is navigation muscle memory, and a session-wide grant must never
 * ride it (sweep #2 item 29 — law 3, the user's intent is the block).
 * Pure; exported for the parity prover.
 */
export function cycleModeMayApprove(state: { yesInputMode: boolean; noInputMode: boolean }): boolean {
  return !state.yesInputMode && !state.noInputMode
}

export function useFilePermissionDialog<T extends Record<string, unknown>>({
  filePath,
  completionType,
  languageName,
  toolUseConfirm,
  onDone,
  onReject,
  parseInput,
  operationType = 'write',
}: {
  filePath: string | null
  completionType: CompletionType
  languageName?: string | Promise<string>
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
  const [yesFeedbackModeEntered, setYesFeedbackModeEntered] = useState(false)
  const [noFeedbackModeEntered, setNoFeedbackModeEntered] = useState(false)
  const [focusedOption, setFocusedOptionState] = useState('accept-once')

  // The derived language promise must stay STABLE across renders; the caller
  // override wins, and no path means no language.
  const derivedLanguage = useMemo<string | Promise<string>>(
    () => languageName ?? (filePath !== null ? getLanguageName(filePath) : 'none'),
    [languageName, filePath],
  )

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(
      () => ({ completion_type: completionType, language_name: derivedLanguage }),
      [completionType, derivedLanguage],
    ),
  )

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
      setYesFeedbackModeEntered(true)
    } else if (value === 'reject') {
      setNoInputMode(current => !current)
      setNoFeedbackModeEntered(true)
    }
  }, [])

  const setFocusedOption = useCallback(
    (value: string) => {
      // Navigating away from a role's option collapses its input only when
      // its text is empty after trimming.
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
      // A fresh local wrapper per dispatch, always over the ORIGINAL request:
      // the allowed input is the parsed/modified one, and a second dispatch
      // cannot double-wrap.
      const wrapped: ToolUseConfirm = { ...toolUseConfirm, input }
      const params: PermissionHandlerParams = {
        messageId: toolUseConfirm.assistantMessage.message.id,
        path: filePath,
        toolUseConfirm: wrapped,
        toolPermissionContext,
        onDone,
        onReject,
        completionType,
        languageName: derivedLanguage,
        operationType,
      }
      PERMISSION_HANDLERS[option.type](params, {
        feedback: trimmed,
        hasFeedback: trimmed !== undefined,
        enteredFeedbackMode:
          option.type === 'reject' ? noFeedbackModeEntered : yesFeedbackModeEntered,
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
      completionType,
      derivedLanguage,
      operationType,
      yesFeedbackModeEntered,
      noFeedbackModeEntered,
    ],
  )

  // The mode-cycle shortcut immediately selects the session option when one
  // exists, RE-PARSING the request input at dispatch time; no-op otherwise.
  // Inert while a feedback field is open — the chord is consumed (never
  // falls through to the composer) but grants nothing.
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

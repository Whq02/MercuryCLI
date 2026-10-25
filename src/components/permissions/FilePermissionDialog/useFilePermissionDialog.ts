import { useCallback, useState } from 'react'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { useAppState } from '../../../state/AppState.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import { useOptionAmendments } from '../useOptionAmendments.js'
import { getFilePermissionOptions, type FileOperationType, type PermissionOption, type PermissionOptionWithLabel } from './permissionOptions.js'
import { PERMISSION_HANDLERS, type PermissionHandlerParams } from './usePermissionHandler.js'

const AMENDABLE = ['accept-once', 'reject'] as const

type HandlerOptions = Parameters<(typeof PERMISSION_HANDLERS)['accept-session']>[1]

type DialogArgs<T> = { filePath: string | null; toolUseConfirm: ToolUseConfirm; onDone: () => void; onReject: () => void; parseInput: (input: unknown) => T; operationType?: FileOperationType; canApprove?: boolean }

export function cycleModeMayApprove(state: { yesInputMode: boolean; noInputMode: boolean }): boolean {
  return !(state.yesInputMode || state.noInputMode)
}

function handlerOptionsFor(option: PermissionOption, feedback: string | undefined): HandlerOptions {
  const grant = option.type === 'accept-session' ? { scope: option.scope, pattern: option.pattern } : {}
  return { feedback, ...grant }
}

const sessionOptionOf = (options: PermissionOptionWithLabel[]): PermissionOption | undefined =>
  options.find(candidate => candidate.option.type === 'accept-session')?.option

export function useFilePermissionDialog<T extends Record<string, unknown>>(args: DialogArgs<T>) {
  const { filePath, toolUseConfirm, onDone, onReject, parseInput, operationType = 'write', canApprove = true } = args
  const toolPermissionContext = useAppState(state => state.toolPermissionContext)
  const { amendments, isRole, setText, toggle, collapseAwayFrom } = useOptionAmendments(AMENDABLE)
  const [focusedOption, setFocused] = useState<string>('accept-once')
  usePermissionRequestLogging(toolUseConfirm)

  const yesInputMode = amendments['accept-once'].open
  const noInputMode = amendments.reject.open
  const setAcceptText = useCallback((text: string) => setText('accept-once', text), [setText])
  const setRejectText = useCallback((text: string) => setText('reject', text), [setText])
  const options = getFilePermissionOptions({ filePath, toolPermissionContext, operationType, onAcceptFeedbackChange: setAcceptText, onRejectFeedbackChange: setRejectText, yesInputMode, noInputMode })

  const handleInputModeToggle = useCallback((value: string) => { if (isRole(value)) toggle(value) }, [isRole, toggle])
  const setFocusedOption = useCallback((value: string) => { collapseAwayFrom(value); setFocused(value) }, [collapseAwayFrom])

  const onChange = useCallback(
    (option: PermissionOption, input: T, feedback?: string) => {
      if (option.type !== 'reject' && !canApprove) return
      const request: PermissionHandlerParams = { path: filePath, toolUseConfirm: { ...toolUseConfirm, input }, toolPermissionContext, onDone, onReject, operationType }
      PERMISSION_HANDLERS[option.type](request, handlerOptionsFor(option, feedback?.trim() || undefined))
    },
    [filePath, toolUseConfirm, toolPermissionContext, onDone, onReject, operationType, canApprove],
  )

  useKeybinding('confirm:cycleMode', () => {
    const session = canApprove && cycleModeMayApprove({ yesInputMode, noInputMode }) ? sessionOptionOf(options) : undefined
    if (session) onChange(session, parseInput(toolUseConfirm.input))
  }, { context: 'Confirmation' })

  return { options, onChange, acceptFeedback: amendments['accept-once'].text, rejectFeedback: amendments.reject.text, focusedOption, setFocusedOption, handleInputModeToggle, yesInputMode, noInputMode }
}

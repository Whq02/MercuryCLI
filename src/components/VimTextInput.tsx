// The vim-mode text-field wrapper. Its caret inversion keys on terminal
// focus ONLY — it does not consult accessibility mode, so the caret still
// inverts under accessibility (a preserved inconsistency, kept
// deliberately). It threads a smaller prop set than the plain wrapper (no
// selection-range fork props, no page-key or ghost-text options), adds the
// mode-change and undo callbacks, exposes the current mode, and re-applies
// a supplied initial mode whenever it differs from the current mode.
//
// The caret blinks on the shared clock exactly like TextInput's (one
// useBlink phase — every composer agrees); the accessibility inconsistency
// above carries into the blink gate unchanged.

import chalk from 'chalk'
import React, { useEffect } from 'react'
import { BaseTextInput } from './BaseTextInput.js'
import { useBlink } from '../hooks/useBlink.js'
import { useClipboardImageHint } from '../hooks/useClipboardImageHint.js'
import { useVimInput, type VimMode } from '../hooks/useVimInput.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import type { BaseTextInputProps } from '../types/textInputTypes.js'
import { color } from './design-system/color.js'
import { useTheme } from './design-system/ThemeProvider.js'

export type Props = BaseTextInputProps & {
  onModeChange?: (mode: VimMode) => void
  /** Re-applied whenever it differs from the current mode. */
  initialMode?: VimMode
}

export default function VimTextInput(props: Props): React.ReactNode {
  const [themeName] = useTheme()
  const terminalFocused = useTerminalFocus()
  // (isFocused, enabled) — see TextInput: the swapped order made the hint
  // unreachable.
  useClipboardImageHint(terminalFocused, Boolean(props.onImagePaste))

  const [, caretPhaseOn] = useBlink(
    props.focus !== false && props.showCursor !== false && terminalFocused,
  )
  const inputState = useVimInput({
    value: props.value,
    onChange: props.onChange,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    columns: props.columns,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onExitMessage: props.onExitMessage,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    onHistoryReset: props.onHistoryReset,
    onClearInput: props.onClearInput,
    cursorChar: props.showCursor === false ? '' : ' ',
    mask: props.mask,
    // Terminal focus only — deliberately no accessibility consult here.
    invert:
      terminalFocused && caretPhaseOn
        ? (text: string): string => chalk.inverse(text)
        : (text: string): string => text,
    dim: (text: string): string => chalk.dim(text),
    maxVisibleLines: props.maxVisibleLines,
    multiline: props.multiline,
    disableCursorMovementForUpDownKeys: props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    suppressEnterSubmit: props.suppressEnterSubmit,
    inputFilter: props.inputFilter,
    focus: props.focus,
    highlightPastedText: props.highlightPastedText,
    themeText: color('text', themeName),
    onImagePaste: props.onImagePaste,
    onModeChange: props.onModeChange,
    onUndo: props.onUndo,
  })

  const { mode, setMode } = inputState
  const { initialMode } = props
  useEffect(() => {
    if (initialMode !== undefined && initialMode !== mode) setMode(initialMode)
  }, [initialMode, mode, setMode])

  return (
    <BaseTextInput
      {...props}
      inputState={inputState}
      terminalFocus={terminalFocused}
    />
  )
}

import chalk from 'chalk'
import React, { useEffect } from 'react'
import { useBlink } from '../hooks/useBlink.js'
import { useClipboardImageHint } from '../hooks/useClipboardImageHint.js'
import { useVimInput, type UseVimInputProps, type VimMode } from '../hooks/useVimInput.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import type { BaseTextInputProps, VimInputState } from '../types/textInputTypes.js'
import type { ThemeName } from '../utils/theme.js'
import { BaseTextInput } from './BaseTextInput.js'
import { color } from './design-system/color.js'
import { useTheme } from './design-system/ThemeProvider.js'

export type Props = BaseTextInputProps & {
  onModeChange?: (mode: VimMode) => void
  initialMode?: VimMode
}

type Painter = (text: string) => string

type Paint = Pick<UseVimInputProps, 'cursorChar' | 'invert' | 'dim' | 'themeText'>

const asIs: Painter = text => text

function caretPaint(props: Props, terminalFocused: boolean, caretPhaseOn: boolean, themeName: ThemeName): Paint {
  return {
    cursorChar: props.showCursor === false ? '' : ' ',
    invert: terminalFocused && caretPhaseOn ? chalk.inverse : asIs,
    dim: chalk.dim,
    themeText: color('text', themeName),
  }
}

function vimInputOptions(props: Props, paint: Paint): UseVimInputProps {
  return {
    ...paint,
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
    mask: props.mask,
    maxVisibleLines: props.maxVisibleLines,
    multiline: props.multiline,
    disableCursorMovementForUpDownKeys: props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    suppressEnterSubmit: props.suppressEnterSubmit,
    inputFilter: props.inputFilter,
    focus: props.focus,
    highlightPastedText: props.highlightPastedText,
    onImagePaste: props.onImagePaste,
    onModeChange: props.onModeChange,
    onUndo: props.onUndo,
  }
}

function useFollowedMode(inputState: VimInputState, initialMode: VimMode | undefined): void {
  const { mode, setMode } = inputState
  useEffect(() => {
    if (initialMode !== undefined && initialMode !== mode) setMode(initialMode)
  }, [initialMode, mode, setMode])
}

export default function VimTextInput(props: Props): React.ReactNode {
  const [themeName] = useTheme()
  const terminalFocused = useTerminalFocus()
  useClipboardImageHint(terminalFocused, Boolean(props.onImagePaste))
  const [, caretPhaseOn] = useBlink(props.focus !== false && props.showCursor !== false && terminalFocused)
  const inputState = useVimInput(vimInputOptions(props, caretPaint(props, terminalFocused, caretPhaseOn, themeName)))
  useFollowedMode(inputState, props.initialMode)
  return <BaseTextInput {...props} inputState={inputState} terminalFocus={terminalFocused} />
}

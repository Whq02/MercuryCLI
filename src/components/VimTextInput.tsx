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

export type Props = BaseTextInputProps & { onModeChange?: (mode: VimMode) => void; initialMode?: VimMode }

type Painter = (text: string) => string

type Paint = Pick<UseVimInputProps, 'cursorChar' | 'invert' | 'dim' | 'themeText'>

const asIs: Painter = text => text

const caretPaint = (props: Props, terminalFocused: boolean, caretPhaseOn: boolean, themeName: ThemeName): Paint => ({
  cursorChar: props.showCursor === false ? '' : ' ',
  invert: terminalFocused && caretPhaseOn ? chalk.inverse : asIs,
  dim: chalk.dim,
  themeText: color('text', themeName),
})

const PASSED_THROUGH = [
  'value', 'onChange', 'columns', 'onSubmit', 'onExit', 'onExitMessage', 'onHistoryUp', 'onHistoryDown', 'onHistoryReset', 'onClearInput',
  'maxVisibleLines', 'multiline', 'disableCursorMovementForUpDownKeys', 'disableEscapeDoublePress', 'suppressEnterSubmit', 'inputFilter',
  'focus', 'highlightPastedText', 'onImagePaste', 'onModeChange', 'onUndo',
] as const

type PassedThrough = Pick<Props, (typeof PASSED_THROUGH)[number]>

const passedThrough = (props: Props): PassedThrough =>
  Object.fromEntries(PASSED_THROUGH.map(key => [key, props[key]])) as PassedThrough

function vimInputOptions(props: Props, paint: Paint): UseVimInputProps {
  return { ...paint, ...passedThrough(props), externalOffset: props.cursorOffset, onOffsetChange: props.onChangeCursorOffset, mask: props.mask }
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

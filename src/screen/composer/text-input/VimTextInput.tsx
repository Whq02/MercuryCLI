import chalk from 'chalk'
import React from 'react'
import { useBlink } from '../../effects/useBlink.js'
import { useClipboardImageHint } from '../useClipboardImageHint.js'
import { useVimInput, type UseVimInputProps, type VimMode } from '../vim/useVimInput.js'
import { useTerminalFocus } from '../../renderer/bindings/use-terminal-focus.js'
import type { BaseTextInputProps } from '../input-core/textInput.js'
import type { ThemeName } from '../../theme/theme.js'
import { BaseTextInput } from './BaseTextInput.js'
import { color } from '../../theme/color.js'
import { useTheme } from '../../theme/ThemeProvider.js'

type Props = BaseTextInputProps & { onModeChange?: (mode: VimMode) => void; initialMode?: VimMode }

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
  'focus', 'highlightPastedText', 'onImagePaste', 'onModeChange', 'onUndo', 'initialMode',
] as const

type PassedThrough = Pick<Props, (typeof PASSED_THROUGH)[number]>

const passedThrough = (props: Props): PassedThrough =>
  Object.fromEntries(PASSED_THROUGH.map(key => [key, props[key]])) as PassedThrough

function vimInputOptions(props: Props, paint: Paint): UseVimInputProps {
  return { ...paint, ...passedThrough(props), externalOffset: props.cursorOffset, onOffsetChange: props.onChangeCursorOffset, mask: props.mask }
}

export default function VimTextInput(props: Props): React.ReactNode {
  const [themeName] = useTheme()
  const terminalFocused = useTerminalFocus()
  useClipboardImageHint(terminalFocused, Boolean(props.onImagePaste))
  const [, caretPhaseOn] = useBlink(props.focus !== false && props.showCursor !== false && terminalFocused)
  const inputState = useVimInput(vimInputOptions(props, caretPaint(props, terminalFocused, caretPhaseOn, themeName)))
  return <BaseTextInput {...props} inputState={inputState} terminalFocus={terminalFocused} />
}

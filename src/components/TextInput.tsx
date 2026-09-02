
import chalk from 'chalk'
import React, { useState } from 'react'
import { BaseTextInput } from './BaseTextInput.js'
import { useTextInput } from '../hooks/useTextInput.js'
import { useBlink } from '../hooks/useBlink.js'
import { useClipboardImageHint } from '../hooks/useClipboardImageHint.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js'
import type { BaseTextInputProps } from '../types/textInputTypes.js'
import { color } from './design-system/color.js'
import { useTheme } from './design-system/ThemeProvider.js'

export type Props = BaseTextInputProps & {
  selectionRange?: () => { start: number; end: number } | null | undefined
  onSelectionConsumed?: () => void
  onBeforeRangeEdit?: () => void
  viewportStartRef?: React.MutableRefObject<number | undefined>
}

export default function TextInput(props: Props): React.ReactNode {
  const [themeName] = useTheme()
  const terminalFocused = useTerminalFocus()
  const [accessibility] = useState(
    () => resolveTerminalExperience().accessibility.effective,
  )
  useClipboardImageHint(terminalFocused, Boolean(props.onImagePaste))

  const [, caretPhaseOn] = useBlink(
    props.focus !== false &&
      props.showCursor !== false &&
      terminalFocused &&
      !accessibility,
  )
  const invert =
    !terminalFocused || accessibility || !caretPhaseOn
      ? (text: string): string => text
      : (text: string): string => chalk.inverse(text)

  const inputState = useTextInput({
    value: props.value,
    onChange: props.onChange,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    columns: props.columns,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onEscape: props.onEscape,
    onExitMessage: props.onExitMessage,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    onHistoryReset: props.onHistoryReset,
    onClearInput: props.onClearInput,
    cursorChar: props.showCursor === false ? '' : ' ',
    mask: props.mask,
    invert,
    dim: (text: string): string => chalk.dim(text),
    maxVisibleLines: props.maxVisibleLines,
    viewportStartRef: props.viewportStartRef,
    inlineGhostText: props.inlineGhostText,
    multiline: props.multiline,
    disableCursorMovementForUpDownKeys: props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    disablePageKeyCursorMovement: props.disablePageKeyCursorMovement,
    suppressEnterSubmit: props.suppressEnterSubmit,
    inputFilter: props.inputFilter,
    selectionRange: props.selectionRange,
    onBeforeRangeEdit: props.onBeforeRangeEdit,
    onSelectionConsumed: props.onSelectionConsumed,
    focus: props.focus,
    highlightPastedText: props.highlightPastedText,
    themeText: color('text', themeName),
    onImagePaste: props.onImagePaste,
  })

  return (
    <BaseTextInput
      {...props}
      inputState={inputState}
      terminalFocus={terminalFocused}
      invert={invert}
    />
  )
}

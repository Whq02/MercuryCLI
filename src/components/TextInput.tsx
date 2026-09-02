// The plain text-field wrapper: resolves the theme and terminal focus,
// drives the shared text-input state machine with the caller's props, and
// renders the shared base field. The caret's inversion function is the
// identity when the terminal is unfocused OR accessibility mode is on (no
// visible cursor), and inverse video otherwise; accessibility is resolved
// once at mount because this component re-renders on every keystroke.
//
// THE CARET BLINKS (chat-feel item 1): the inversion additionally rides the
// shared blink phase (useBlink → the ONE animation clock — never a timer of
// its own), so the caret cell alternates inverse/plain at the estate's blink
// cadence. Armed only while this field is focused, shown, in a focused
// terminal, outside accessibility; every other state keeps the historical
// byte-still paint (useBlink(false) never subscribes the clock, and a
// disabled blinker reads VISIBLE — render-identical to the pre-blink field).
// Absolute-bucket sampling phase-locks every composer to the same beat.

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
  /** Screen-selection → text-range fork props: they make drag-selection a
   *  real text range. */
  selectionRange?: () => { start: number; end: number } | null | undefined
  onSelectionConsumed?: () => void
  onBeforeRangeEdit?: () => void
  /** The banded viewport start's shared home — see
   *  UseTextInputProps.viewportStartRef. */
  viewportStartRef?: React.MutableRefObject<number | undefined>
}

export default function TextInput(props: Props): React.ReactNode {
  const [themeName] = useTheme()
  const terminalFocused = useTerminalFocus()
  // Accessibility resolution is computed once at mount: a per-render probe
  // would be paid thousands of times per session.
  const [accessibility] = useState(
    () => resolveTerminalExperience().accessibility.effective,
  )
  // The clipboard image hint arms only when an image-paste callback was
  // supplied and only while the terminal has focus.
  // (isFocused, enabled) — the swapped order made `was` start true and the
  // focus transition never fire, so the hint was unreachable (TASK-017
  // supplement, SURVIVED).
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

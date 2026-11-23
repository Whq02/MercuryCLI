import chalk from 'chalk'
import React, { useContext, useRef, useState } from 'react'
import { useMeasure } from '../../effects/effects.js'
import { Box, measureElement, type DOMElement } from '../../themedRenderer.js'
import { PopupFormContext } from '../../overlays/popupFormContext.js'
import { BaseTextInput } from './BaseTextInput.js'
import { useTextInput } from './useTextInput.js'
import { useBlink } from '../../effects/useBlink.js'
import { useClipboardImageHint } from '../useClipboardImageHint.js'
import { colorize } from '../../renderer/colorize.js'
import { useTerminalFocus } from '../../renderer/bindings/use-terminal-focus.js'
import { resolveTerminalExperience } from '../../renderer/terminal-session/terminalExperience.js'
import type { BaseTextInputProps } from '../input-core/textInput.js'
import { getTheme } from '../../theme/theme.js'
import { color } from '../../theme/color.js'
import { useTheme } from '../../theme/ThemeProvider.js'

type Props = BaseTextInputProps & {
  selectionRange?: () => { start: number; end: number } | null | undefined
  onSelectionConsumed?: () => void
  onBeforeRangeEdit?: () => void
  selectionHighlight?: { start: number; end: number } | null
  viewportStartRef?: React.MutableRefObject<number | undefined>
}

export default function TextInput(props: Props): React.ReactNode {
  const terminalFocus = useTerminalFocus()
  const [theme] = useTheme()
  const [accessibility] = useState(
    () => resolveTerminalExperience().accessibility.effective,
  )

  useClipboardImageHint(terminalFocus, Boolean(props.onImagePaste))

  const isFocused = props.focus !== false
  const showCursor = props.showCursor !== false
  const [, blinkVisible] = useBlink(
    isFocused && showCursor && terminalFocus && !accessibility,
  )

  const invert =
    !terminalFocus || accessibility || !blinkVisible
      ? (text: string) => text
      : chalk.inverse

  const cursorChar = showCursor ? ' ' : ''

  const selectionBg = getTheme(theme).selectionBg
  const selectionPaint =
    props.selectionHighlight &&
    props.selectionHighlight.end > props.selectionHighlight.start
      ? {
          start: props.selectionHighlight.start,
          end: props.selectionHighlight.end,
          paint: (text: string): string => {
            const painted = colorize(text, selectionBg, 'background')
            return painted === text ? chalk.inverse(text) : painted
          },
        }
      : null

  const fitToForm = useContext(PopupFormContext)
  const outerRef = useRef<DOMElement | null>(null)
  const [measuredColumns, setMeasuredColumns] = useState<number | null>(null)

  useMeasure(() => {
    if (!fitToForm || !outerRef.current) return
    const width = Math.max(1, Math.floor(measureElement(outerRef.current).width))
    if (width !== measuredColumns) {
      setMeasuredColumns(width)
    }
  })

  const columns = fitToForm
    ? Math.max(1, Math.min(props.columns, measuredColumns ?? props.columns))
    : props.columns

  const inputState = useTextInput({
    value: props.value,
    onChange: props.onChange,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    columns,
    viewportStartRef: props.viewportStartRef,
    maxVisibleLines: props.maxVisibleLines,
    cursorChar,
    mask: props.mask,
    invert,
    dim: chalk.dim,
    themeText: color('text', theme),
    inlineGhostText: props.inlineGhostText,
    selectionPaint,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onExitMessage: props.onExitMessage,
    onEscape: props.onEscape,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    onHistoryReset: props.onHistoryReset,
    onClearInput: props.onClearInput,
    multiline: props.multiline,
    disableCursorMovementForUpDownKeys: props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    disablePageKeyCursorMovement: props.disablePageKeyCursorMovement,
    suppressEnterSubmit: props.suppressEnterSubmit,
    inputFilter: props.inputFilter,
    selectionRange: props.selectionRange,
    onSelectionConsumed: props.onSelectionConsumed,
    onBeforeRangeEdit: props.onBeforeRangeEdit,
    focus: props.focus,
    highlightPastedText: props.highlightPastedText,
    onImagePaste: props.onImagePaste,
  })

  const inputNode = (
    <BaseTextInput
      {...props}
      columns={columns}
      inputState={inputState}
      terminalFocus={terminalFocus}
      invert={invert}
    />
  )

  if (fitToForm) {
    return (
      <Box ref={outerRef} flexGrow={1} flexShrink={1} minWidth={0}>
        {inputNode}
      </Box>
    )
  }

  return inputNode
}

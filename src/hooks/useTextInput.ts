
import { useRef } from 'react'
import stripAnsi from 'strip-ansi'
import { useNotifications } from '../context/notifications.js'
import type { Key } from '../ink.js'
import { addToHistory } from '../history.js'
import { markBackslashReturnUsed } from '../commands/terminalSetup/terminalSetup.js'
import { isBackslashContinuation } from '../input-core/backslashContinuation.js'
import { isInputModeCharacter } from '../components/PromptInput/inputModes.js'
import type {
  InlineGhostText,
  TextInputState,
} from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  type SelectionPaint,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { spliceInputRange } from '../utils/inputRange.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from './useDoublePress.js'

const ESCAPE_CLEAR_NOTIFICATION_KEY = 'escape-again-to-clear'

export type UseTextInputProps = {
  viewportStartRef?: React.MutableRefObject<number | undefined>
  value: string
  onChange: (value: string) => void
  externalOffset: number
  onOffsetChange: (offset: number) => void
  columns: number
  onSubmit?: (value: string) => void
  onExit?: () => void
  onEscape?: () => void
  onExitMessage?: (show: boolean, chordLabel?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  cursorChar?: string
  mask?: string
  invert?: (text: string) => string
  dim?: (text: string) => string
  maxVisibleLines?: number
  inlineGhostText?: InlineGhostText
  multiline?: boolean
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  disablePageKeyCursorMovement?: boolean
  suppressEnterSubmit?: boolean
  inputFilter?: (input: string, key: Key) => string
  selectionRange?: () => { start: number; end: number } | null | undefined
  onBeforeRangeEdit?: () => void
  onSelectionConsumed?: () => void
  selectionPaint?: SelectionPaint | null
  focus?: boolean
  highlightPastedText?: boolean
  themeText?: (text: string) => string
  onImagePaste?: (base64Image: string, mediaType?: string) => void
}

function isKillKey(input: string, key: Key): boolean {
  if (key.ctrl && (input === 'k' || input === 'u' || input === 'w')) return true
  return Boolean(key.meta && (key.backspace || key.delete))
}

function isYankKey(input: string, key: Key): boolean {
  return Boolean((key.ctrl || key.meta) && input === 'y')
}

export function useTextInput({
  viewportStartRef,
  value,
  onChange,
  externalOffset,
  onOffsetChange,
  columns,
  onSubmit,
  onExit,
  onEscape,
  onExitMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  onClearInput,
  cursorChar,
  mask = '',
  invert,
  dim,
  maxVisibleLines,
  inlineGhostText,
  multiline = false,
  disableCursorMovementForUpDownKeys = false,
  disableEscapeDoublePress = false,
  disablePageKeyCursorMovement = false,
  suppressEnterSubmit = false,
  inputFilter,
  selectionRange,
  onBeforeRangeEdit,
  onSelectionConsumed,
  selectionPaint,
}: UseTextInputProps): TextInputState {
  const { addNotification, removeNotification } = useNotifications()

  if (env.terminal === 'Apple_Terminal') {
  }

  const offset = externalOffset

  const liveRef = useRef({ value, offset })
  liveRef.current = { value, offset }

  const setOffset = (next: number): void => {
    onOffsetChange(next)
  }

  const handleCtrlC = useDoublePress(
    show => onExitMessage?.(show, 'Ctrl-C'),
    () => onExit?.(),
    () => {
      if (value) {
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
    EXIT_CHORD_WINDOW_MS,
  )

  const handleCtrlD = useDoublePress(
    show => onExitMessage?.(show, 'Ctrl-D'),
    () => {
      if (value === '') onExit?.()
    },
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )

  const ESC_CLEAR_WINDOW_MS = 3000
  const handleEscape = useDoublePress(
    pending => {
      if (!pending) removeNotification(ESCAPE_CLEAR_NOTIFICATION_KEY)
    },
    () => {
      removeNotification(ESCAPE_CLEAR_NOTIFICATION_KEY)
      onClearInput?.()
      if (value) {
        if (value.trim() !== '') addToHistory(value)
        onChange('')
        setOffset(0)
        onHistoryReset?.()
        addNotification({
          key: ESCAPE_CLEAR_NOTIFICATION_KEY,
          text: 'draft cleared — ↑ brings it back',
          priority: 'immediate',
          timeoutMs: 1500,
        })
      }
    },
    () => {
      if (value) {
        addNotification({
          key: ESCAPE_CLEAR_NOTIFICATION_KEY,
          text: 'Press escape again to clear the input',
          priority: 'immediate',
          timeoutMs: ESC_CLEAR_WINDOW_MS,
        })
      }
    },
    ESC_CLEAR_WINDOW_MS,
  )

  function upOrHistory(cursor: Cursor): Cursor | null {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.()
      return null
    }
    const visual = cursor.up()
    if (!visual.equals(cursor)) return visual
    if (multiline) {
      const logical = cursor.upLogicalLine()
      if (!logical.equals(cursor)) {
        const noNewlineBefore = !value.slice(0, cursor.offset).includes('\n')
        if (onHistoryUp && logical.offset === 0 && noNewlineBefore) {
          onHistoryUp()
          return null
        }
        return logical
      }
    }
    onHistoryUp?.()
    return null
  }

  function downOrHistory(cursor: Cursor): Cursor | null {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.()
      return null
    }
    const visual = cursor.down()
    if (!visual.equals(cursor)) return visual
    if (multiline) {
      const logical = cursor.downLogicalLine()
      if (!logical.equals(cursor)) return logical
    }
    onHistoryDown?.()
    return null
  }

  function yank(cursor: Cursor): Cursor | null {
    const killed = getLastKill()
    if (!killed) return null
    const next = cursor.insert(killed)
    recordYank(next.offset - killed.length, killed.length)
    return next
  }

  function yankPopRoute(cursor: Cursor): Cursor | null {
    const popped = yankPop()
    if (!popped) return null
    const start = new Cursor(cursor.measuredText, popped.start)
    const end = new Cursor(cursor.measuredText, popped.start + popped.length)
    const next = start.modifyText(end, popped.text)
    updateYankLength(popped.text.length)
    return next
  }


  function handleRawDelBytes(cursor: Cursor, rawInput: string): void {
    resetKillAccumulation()
    resetYankState()
    const delCount = (rawInput.match(/\x7f/g) ?? []).length
    let current = cursor
    for (let i = 0; i < delCount; i++) {
      current = current.deleteTokenBefore() ?? current.backspace()
    }
    const live = liveRef.current
    if (current.offset !== cursor.offset || current.text !== live.value) {
      if (current.text !== live.value) onChange(current.text)
      if (current.offset !== live.offset) setOffset(current.offset)
      liveRef.current = { value: current.text, offset: current.offset }
    }
  }

  function handleEnter(cursor: Cursor, key: Key): Cursor | null {
    if (multiline && isBackslashContinuation(value, cursor.offset)) {
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    if (key.meta || key.shift) return cursor.insert('\n')
    if (suppressEnterSubmit) return null
    onSubmit?.(value)
    return null
  }

  function routeKey(
    cursor: Cursor,
    filtered: string,
    rawInput: string,
    key: Key,
  ): Cursor | null {
    if (key.return) return handleEnter(cursor, key)

    if (key.escape) {
      if (onEscape) {
        onEscape()
        return null
      }
      if (!disableEscapeDoublePress) handleEscape()
      return null
    }

    if (key.tab) return null
    if (key.wheelUp || key.wheelDown) return null

    if (key.upArrow && !key.shift) return upOrHistory(cursor)
    if (key.downArrow && !key.shift) return downOrHistory(cursor)

    if (key.leftArrow) {
      return key.ctrl || key.meta || key.fn ? cursor.prevWord() : cursor.left()
    }
    if (key.rightArrow) {
      return key.ctrl || key.meta || key.fn ? cursor.nextWord() : cursor.right()
    }

    if (key.home) return cursor.startOfLine()
    if (key.end) return cursor.endOfLine()
    if (rawInput === '\x1b[H' || rawInput === '\x1b[1~') return cursor.startOfLine()
    if (rawInput === '\x1b[F' || rawInput === '\x1b[4~') return cursor.endOfLine()

    if (key.backspace) {
      if (key.meta || key.ctrl) {
        const { cursor: next, killed } = cursor.deleteWordBefore()
        if (killed) pushToKillRing(killed, 'prepend')
        return next
      }
      return cursor.deleteTokenBefore() ?? cursor.backspace()
    }
    if (key.delete) {
      if (key.meta) {
        const { cursor: next, killed } = cursor.deleteToLineEnd()
        if (killed) pushToKillRing(killed, 'append')
        return next
      }
      return cursor.del()
    }

    if (key.pageUp || key.pageDown) {
      if (isFullscreenEnvEnabled() || disablePageKeyCursorMovement) return null
      return key.pageUp ? cursor.startOfLine() : cursor.endOfLine()
    }

    if (key.ctrl) {
      switch (filtered) {
        case 'a':
          return cursor.startOfLine()
        case 'b':
          return cursor.left()
        case 'c':
          handleCtrlC()
          return null
        case 'd':
          if (value === '') {
            handleCtrlD()
            return null
          }
          return cursor.del()
        case 'e':
          return cursor.endOfLine()
        case 'h':
          return cursor.deleteTokenBefore() ?? cursor.backspace()
        case 'j':
          return cursor.insert('\n')
        case 'k': {
          const { cursor: next, killed } = cursor.deleteToLineEnd()
          if (killed) pushToKillRing(killed, 'append')
          return next
        }
        case 'n':
          return downOrHistory(cursor)
        case 'p':
          return upOrHistory(cursor)
        case 'u': {
          const { cursor: next, killed } = cursor.deleteToLineStart()
          if (killed) pushToKillRing(killed, 'prepend')
          return next
        }
        case 'w': {
          const { cursor: next, killed } = cursor.deleteWordBefore()
          if (killed) pushToKillRing(killed, 'prepend')
          return next
        }
        case 'y':
          return yank(cursor)
        default:
          return null
      }
    }

    if (key.meta) {
      switch (filtered) {
        case 'b':
          return cursor.prevWord()
        case 'f':
          return cursor.nextWord()
        case 'd':
          return cursor.deleteWordAfter()
        case 'y':
          return yankPopRoute(cursor)
        default:
          return null
      }
    }

    if (cursor.offset === 0 && isInputModeCharacter(rawInput)) {
      return cursor.insert(rawInput).left()
    }

    let insertText = stripAnsi(filtered)
    if (insertText.length >= 2 && insertText.endsWith('\r')) {
      const beforeCR = insertText[insertText.length - 2]
      if (beforeCR !== '\\' && beforeCR !== '\r' && beforeCR !== '\n') {
        insertText = insertText.slice(0, -1)
      }
    }
    insertText = insertText.replaceAll('\r', '\n')
    return cursor.insert(insertText)
  }

  const onInput = (rawInput: string, key: Key): void => {
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
    if (inputFilter && filtered === '' && rawInput !== '') return

    const { value: liveValue, offset: liveOffset } = liveRef.current
    const cursor = Cursor.fromText(liveValue, columns, liveOffset)

    if (selectionRange) {
      const r = selectionRange()
      if (r) {
        const { start, end } = r
        if (start >= 0 && start < end && end <= liveValue.length) {
          const commitRangeEdit = (result: { text: string; cursorOffset: number }): void => {
            liveRef.current = { value: result.text, offset: result.cursorOffset }
            onChange(result.text)
            setOffset(result.cursorOffset)
            onSelectionConsumed?.()
            resetKillAccumulation()
            resetYankState()
          }
          if (key.backspace || key.delete || filtered.includes('\x7f')) {
            onBeforeRangeEdit?.()
            commitRangeEdit(spliceInputRange(liveValue, r, ''))
            return
          }
          const bare = !key.shift && !key.ctrl && !key.meta
          if ((key.leftArrow || key.rightArrow) && bare) {
            setOffset(key.leftArrow ? r.start : r.end)
            onSelectionConsumed?.()
            return
          }
          if (key.escape) {
            onSelectionConsumed?.()
            return
          }
          if (bare && (key.upArrow || key.downArrow || key.home || key.end || key.pageUp || key.pageDown)) {
            onSelectionConsumed?.()
          }
          const printable =
            !key.ctrl &&
            !key.meta &&
            !key.return &&
            !key.tab &&
            !key.upArrow &&
            !key.downArrow &&
            filtered !== '' &&
            !filtered.includes('\x7f') &&
            !filtered.includes('\x1b')
          if (printable) {
            onBeforeRangeEdit?.()
            commitRangeEdit(spliceInputRange(liveValue, r, filtered))
            return
          }
        }
      }
    }

    if (!key.backspace && !key.delete && rawInput.includes('\x7f')) {
      handleRawDelBytes(cursor, rawInput)
      return
    }

    if (!isKillKey(filtered, key)) resetKillAccumulation()
    if (!isYankKey(filtered, key)) resetYankState()

    const next = routeKey(cursor, filtered, rawInput, key)
    if (!next) return

    if (next.text !== liveValue) onChange(next.text)
    if (next.offset !== liveOffset) setOffset(next.offset)
    liveRef.current = { value: next.text, offset: next.offset }

    if (
      !key.isPasted &&
      filtered.length > 1 &&
      filtered.endsWith('\r') &&
      !filtered.slice(0, -1).includes('\r') &&
      !isBackslashContinuation(filtered, filtered.length - 1)
    ) {
      onSubmit?.(next.text)
    }
  }

  const renderCursor = Cursor.fromText(value, columns, offset)
  const ghost =
    inlineGhostText && dim && inlineGhostText.insertPosition === offset
      ? { text: inlineGhostText.text, dim }
      : undefined
  const renderedValue = renderCursor.render(
    cursorChar ?? '',
    mask,
    invert ?? (text => text),
    ghost,
    maxVisibleLines,
    selectionPaint ?? undefined,
  )
  const position = renderCursor.getPosition()
  const localViewportStartRef = useRef<number | undefined>(undefined)
  const bandRef = viewportStartRef ?? localViewportStartRef
  const viewportStartLine = renderCursor.getViewportStartLine(maxVisibleLines, bandRef.current)
  bandRef.current = viewportStartLine

  return {
    onInput,
    renderedValue,
    offset,
    setOffset: setOffset,
    cursorLine: position.line - viewportStartLine,
    cursorColumn: position.column,
    viewportCharOffset: renderCursor.getViewportCharOffset(maxVisibleLines, viewportStartLine),
    viewportCharEnd: renderCursor.getViewportCharEnd(maxVisibleLines, viewportStartLine),
  }
}


import { useRef } from 'react'
import 'strip-ansi'
import { useNotifications } from '../context/notifications.js'
import type { Key } from '../ink.js'
import { addToHistory } from '../history.js'
import { markBackslashReturnUsed } from '../commands/keysetup/keysetup.js'
import { isBackslashContinuation } from '../input-core/backslashContinuation.js'
import '../components/PromptInput/inputModes.js'
import type {
  InlineGhostText,
  TextInputState,
} from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  type SelectionPaint,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import '../utils/fullscreen.js'
import '../utils/inputRange.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from './useDoublePress.js'
import { onInputOf, routeKeyOf, upOrHistoryOf } from './textInput/keys.js'

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

export type LiveInputState = { value: string; offset: number }

const liveStateReaders = new WeakMap<(value: string) => void, () => LiveInputState>()

export function bindLiveInputState(
  onChange: (value: string) => void,
  readLiveState: () => LiveInputState,
): void {
  liveStateReaders.set(onChange, readLiveState)
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
  const externalLiveReader = liveStateReaders.get(onChange)
  const readLive = (): LiveInputState => (externalLiveReader ? externalLiveReader() : liveRef.current)

  const setOffset = (next: number): void => {
    onOffsetChange(next)
  }

  const handleCtrlC = useDoublePress(
    show => onExitMessage?.(show, 'Ctrl-C'),
    () => onExit?.(),
    () => {
      if (readLive().value) {
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
      if (readLive().value === '') onExit?.()
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
      const current = readLive().value
      if (current) {
        if (current.trim() !== '') addToHistory(current)
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
      if (readLive().value) {
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
    return upOrHistoryOf({ disableCursorMovementForUpDownKeys, onHistoryUp, multiline }, cursor)
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
    const live = readLive()
    if (current.offset !== cursor.offset || current.text !== live.value) {
      if (current.text !== live.value) onChange(current.text)
      if (current.offset !== live.offset) setOffset(current.offset)
      if (!externalLiveReader) liveRef.current = { value: current.text, offset: current.offset }
    }
  }

  function handleEnter(cursor: Cursor, key: Key): Cursor | null {
    if (multiline && isBackslashContinuation(cursor.text, cursor.offset)) {
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    if (key.meta || key.shift) return cursor.insert('\n')
    if (suppressEnterSubmit) return null
    onSubmit?.(cursor.text)
    return null
  }

  function routeKey(
    cursor: Cursor,
    filtered: string,
    rawInput: string,
    key: Key,
  ): Cursor | null {
    return routeKeyOf({ handleEnter, onEscape, disableEscapeDoublePress, handleEscape, upOrHistory, downOrHistory, disablePageKeyCursorMovement, handleCtrlC, handleCtrlD, yank, yankPopRoute }, cursor, filtered, rawInput, key)
  }

  const onInput = (rawInput: string, key: Key): void => onInputOf({ inputFilter, readLive, columns, selectionRange, externalLiveReader, liveRef, onClearInput, onChange, setOffset, onSelectionConsumed, onBeforeRangeEdit, handleRawDelBytes, routeKey, onSubmit, isKillKey, isYankKey }, rawInput, key)

  const renderCursor = Cursor.fromText(value, columns, offset)
  const ghost =
    inlineGhostText && dim && inlineGhostText.insertPosition === offset
      ? { text: inlineGhostText.text, dim }
      : undefined
  const localViewportStartRef = useRef<number | undefined>(undefined)
  const bandRef = viewportStartRef ?? localViewportStartRef
  const viewportStartLine = renderCursor.getViewportStartLine(maxVisibleLines, bandRef.current)
  bandRef.current = viewportStartLine
  const renderedValue = renderCursor.render(
    cursorChar ?? '',
    mask,
    invert ?? (text => text),
    ghost,
    maxVisibleLines,
    selectionPaint ?? undefined,
    viewportStartLine,
  )
  const position = renderCursor.getPosition()

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

import { useRef, type MutableRefObject } from 'react'
import { useNotifications } from '../../notifications/notifications.js'
import type { Key } from '../../themedRenderer.js'
import { addToHistory } from '../../../sessions/promptHistory.js'
import { markBackslashReturnUsed } from '../../../commands/keysetup/keysetup.js'
import { isBackslashContinuation } from '../input-core/backslashContinuation.js'
import type {
  BaseTextInputProps,
  InlineGhostText,
  TextInputState,
} from '../input-core/textInput.js'
import {
  Cursor,
  getLastKill,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  type SelectionPaint,
  updateYankLength,
  yankPop,
} from '../vim/textCursor.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from '../../keys/useDoublePress.js'
import { onInputOf, routeKeyOf, upOrHistoryOf } from './keys.js'

const ESCAPE_CLEAR_NOTIFICATION_KEY = 'escape-again-to-clear'
const ESC_CLEAR_WINDOW_MS = EXIT_CHORD_WINDOW_MS
const CLEARED_NOTIFICATION_MS = 1500

export type UseTextInputProps = {
  value: string
  onChange: (value: string) => void
  externalOffset: number
  onOffsetChange: (offset: number) => void
  columns: number
  viewportStartRef?: MutableRefObject<number | undefined>
  maxVisibleLines?: number
  cursorChar?: string
  mask?: string
  invert?: (text: string) => string
  dim?: (text: string) => string
  inlineGhostText?: InlineGhostText
  selectionPaint?: SelectionPaint | null
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onEscape?: () => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  multiline?: boolean
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  disablePageKeyCursorMovement?: boolean
  suppressEnterSubmit?: boolean
  inputFilter?: (input: string, key: Key) => string
  selectionRange?: () => { start: number; end: number } | null | undefined
  onSelectionConsumed?: () => void
  onBeforeRangeEdit?: () => void
  focus?: boolean
  themeText?: (text: string) => string
  highlightPastedText?: boolean
  onImagePaste?: BaseTextInputProps['onImagePaste']
}

function isKillKey(input: string, key: Key): boolean {
  if (key.ctrl && (input === 'k' || input === 'u' || input === 'w')) return true
  if (key.meta && (key.backspace || key.delete)) return true
  return false
}

function isYankKey(input: string, key: Key): boolean {
  return Boolean((key.ctrl || key.meta) && input === 'y')
}

function identity(text: string): string {
  return text
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
  value,
  onChange,
  externalOffset,
  onOffsetChange,
  columns,
  viewportStartRef,
  maxVisibleLines,
  cursorChar = '',
  mask = '',
  invert,
  dim,
  inlineGhostText,
  selectionPaint,
  onSubmit,
  onExit,
  onExitMessage,
  onEscape,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  onClearInput,
  multiline = false,
  disableCursorMovementForUpDownKeys = false,
  disableEscapeDoublePress = false,
  disablePageKeyCursorMovement = false,
  suppressEnterSubmit = false,
  inputFilter,
  selectionRange,
  onSelectionConsumed,
  onBeforeRangeEdit,
}: UseTextInputProps): TextInputState {
  const { addNotification, removeNotification } = useNotifications()
  const offset = externalOffset
  const setOffset = onOffsetChange
  const externalLiveReader = liveStateReaders.get(onChange)
  const liveRef = useRef<LiveInputState>({ value, offset })
  liveRef.current = { value, offset }
  const readLive = (): LiveInputState =>
    externalLiveReader ? externalLiveReader() : liveRef.current

  const fallbackViewportStartRef = useRef<number | undefined>(undefined)
  const effectiveViewportStartRef = viewportStartRef ?? fallbackViewportStartRef

  const handleCtrlC = useDoublePress(
    pending => onExitMessage?.(pending, 'Ctrl-C'),
    () => onExit?.(),
    () => {
      const live = readLive()
      if (live.value !== '') {
        if (!externalLiveReader) liveRef.current = { value: '', offset: 0 }
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
    EXIT_CHORD_WINDOW_MS,
  )

  const handleCtrlD = useDoublePress(
    pending => onExitMessage?.(pending, 'Ctrl-D'),
    () => {
      if (readLive().value === '') onExit?.()
    },
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )

  const handleEscape = useDoublePress(
    pending => {
      if (pending) {
        if (readLive().value !== '') {
          addNotification({
            key: ESCAPE_CLEAR_NOTIFICATION_KEY,
            text: 'Press escape again to clear the input',
            priority: 'immediate',
            timeoutMs: ESC_CLEAR_WINDOW_MS,
          })
        }
      } else {
        removeNotification(ESCAPE_CLEAR_NOTIFICATION_KEY)
      }
    },
    () => {
      onClearInput?.()
      const live = readLive()
      if (live.value !== '') {
        if (live.value.trim() !== '') addToHistory(live.value)
        if (!externalLiveReader) liveRef.current = { value: '', offset: 0 }
        onChange('')
        setOffset(0)
        onHistoryReset?.()
        addNotification({
          key: ESCAPE_CLEAR_NOTIFICATION_KEY,
          text: 'draft cleared — ↑ brings it back',
          priority: 'immediate',
          timeoutMs: CLEARED_NOTIFICATION_MS,
        })
      }
    },
    undefined,
    ESC_CLEAR_WINDOW_MS,
  )

  const yank = (cursor: Cursor): Cursor | null => {
    const killed = getLastKill()
    if (!killed) return null
    const start = cursor.offset
    const next = cursor.insert(killed)
    recordYank(start, next.offset - start)
    return next
  }

  const yankPopRoute = (cursor: Cursor): Cursor | null => {
    const popped = yankPop()
    if (!popped) return null
    const before = cursor.text.slice(0, popped.start)
    const after = cursor.text.slice(popped.start + popped.length)
    const nextText = before + popped.text + after
    const nextOffset = popped.start + popped.text.length
    updateYankLength(popped.text.length)
    return Cursor.fromText(nextText, columns, nextOffset)
  }

  const handleRawDelBytes = (cursor: Cursor, rawInput: string): void => {
    resetKillAccumulation()
    resetYankState()
    let delCount = 0
    for (let i = 0; i < rawInput.length; i++) {
      if (rawInput.charCodeAt(i) === 0x7f) delCount++
    }
    let next = cursor
    for (let i = 0; i < delCount; i++) {
      next = next.deleteTokenBefore() ?? next.backspace()
    }
    const textChanged = next.text !== cursor.text
    if (textChanged) onChange(next.text)
    if (next.offset !== cursor.offset) setOffset(next.offset)
    if (!externalLiveReader) liveRef.current = { value: next.text, offset: next.offset }
  }

  const upOrHistory = (cursor: Cursor): Cursor | null =>
    upOrHistoryOf({ disableCursorMovementForUpDownKeys, onHistoryUp, multiline }, cursor)

  const downOrHistory = (cursor: Cursor): Cursor | null => {
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

  const handleEnter = (cursor: Cursor, key: Key): Cursor | null => {
    if (multiline && isBackslashContinuation(cursor.text, cursor.offset)) {
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    if (key.meta || key.shift) {
      return cursor.insert('\n')
    }
    if (suppressEnterSubmit) return null
    onSubmit?.(cursor.text)
    return null
  }

  const routeKey = (
    cursor: Cursor,
    filtered: string,
    rawInput: string,
    key: Key,
  ): Cursor | null =>
    routeKeyOf(
      {
        handleEnter,
        onEscape,
        disableEscapeDoublePress,
        handleEscape,
        upOrHistory,
        downOrHistory,
        disablePageKeyCursorMovement,
        handleCtrlC,
        handleCtrlD,
        yank,
        yankPopRoute,
      },
      cursor,
      filtered,
      rawInput,
      key,
    )

  const onInput = (rawInput: string, key: Key): void => {
    onInputOf(
      {
        inputFilter,
        readLive,
        columns,
        selectionRange,
        externalLiveReader,
        liveRef,
        onClearInput,
        onChange,
        setOffset,
        onSelectionConsumed,
        onBeforeRangeEdit,
        handleRawDelBytes,
        routeKey,
        onSubmit,
        isKillKey,
        isYankKey,
      },
      rawInput,
      key,
    )
  }

  const cursor = Cursor.fromText(value, columns, offset)
  const previousViewportStart = effectiveViewportStartRef.current
  const viewportStart = cursor.getViewportStartLine(maxVisibleLines, previousViewportStart)
  effectiveViewportStartRef.current = viewportStart

  const ghostText =
    inlineGhostText && dim && inlineGhostText.insertPosition === cursor.offset
      ? { text: inlineGhostText.text, dim }
      : undefined

  const renderedValue = cursor.render(
    cursorChar,
    mask,
    invert ?? identity,
    ghostText,
    maxVisibleLines,
    selectionPaint ?? undefined,
    viewportStart,
  )
  const { line, column } = cursor.getPosition()
  const viewportCharOffset = cursor.getViewportCharOffset(maxVisibleLines, previousViewportStart)
  const viewportCharEnd = cursor.getViewportCharEnd(maxVisibleLines, previousViewportStart)

  return {
    onInput,
    renderedValue,
    offset: cursor.offset,
    setOffset,
    cursorLine: line - viewportStart,
    cursorColumn: column,
    viewportCharOffset,
    viewportCharEnd,
  }
}

import type React from 'react'
import stripAnsi from 'strip-ansi'
import type { Key } from '../../themedRenderer.js'
import { isBackslashContinuation } from '../input-core/backslashContinuation.js'
import { isInputModeCharacter } from '../inputModes.js'
import {
  Cursor,
  pushToKillRing,
  resetKillAccumulation,
  resetYankState,
} from '../vim/textCursor.js'
import { isFullscreenEnvEnabled } from '../../fullscreen-layout/fullscreen.js'
import { spliceInputRange } from './inputRange.js'

type LiveState = { value: string; offset: number }

export function upOrHistoryOf(
  {
    disableCursorMovementForUpDownKeys,
    onHistoryUp,
    multiline,
  }: {
    disableCursorMovementForUpDownKeys: boolean
    onHistoryUp: (() => void) | undefined
    multiline: boolean
  },
  cursor: Cursor,
): Cursor | null {
  if (disableCursorMovementForUpDownKeys) {
    onHistoryUp?.()
    return null
  }
  const visual = cursor.up()
  if (!visual.equals(cursor)) return visual
  if (multiline) {
    const logical = cursor.upLogicalLine()
    if (!logical.equals(cursor)) {
      const noNewlineBefore = !cursor.text.slice(0, cursor.offset).includes('\n')
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

export function routeKeyOf(
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
  }: {
    handleEnter: (cursor: Cursor, key: Key) => Cursor | null
    onEscape: (() => void) | undefined
    disableEscapeDoublePress: boolean
    handleEscape: () => void
    upOrHistory: (cursor: Cursor) => Cursor | null
    downOrHistory: (cursor: Cursor) => Cursor | null
    disablePageKeyCursorMovement: boolean
    handleCtrlC: () => void
    handleCtrlD: () => void
    yank: (cursor: Cursor) => Cursor | null
    yankPopRoute: (cursor: Cursor) => Cursor | null
  },
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
        if (cursor.text === '') {
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

export function onInputOf(
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
  }: {
    inputFilter: ((input: string, key: Key) => string) | undefined
    readLive: () => LiveState
    columns: number
    selectionRange: (() => { start: number; end: number } | null | undefined) | undefined
    externalLiveReader: (() => LiveState) | undefined
    liveRef: React.MutableRefObject<LiveState>
    onClearInput: (() => void) | undefined
    onChange: (value: string) => void
    setOffset: (next: number) => void
    onSelectionConsumed: (() => void) | undefined
    onBeforeRangeEdit: (() => void) | undefined
    handleRawDelBytes: (cursor: Cursor, rawInput: string) => void
    routeKey: (cursor: Cursor, filtered: string, rawInput: string, key: Key) => Cursor | null
    onSubmit: ((value: string) => void) | undefined
    isKillKey: (input: string, key: Key) => boolean
    isYankKey: (input: string, key: Key) => boolean
  },
  rawInput: string,
  key: Key,
): void {
  const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput
  if (inputFilter && filtered === '' && rawInput !== '') return

  const { value: liveValue, offset: liveOffset } = readLive()
  const cursor = Cursor.fromText(liveValue, columns, liveOffset)

  if (selectionRange) {
    const r = selectionRange()
    if (r) {
      const { start, end } = r
      if (start >= 0 && start < end && end <= liveValue.length) {
        const commitRangeEdit = (result: { text: string; cursorOffset: number }): void => {
          if (!externalLiveReader) liveRef.current = { value: result.text, offset: result.cursorOffset }
          if (result.text === '') onClearInput?.()
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

  if (next.text === '' && liveValue !== '' && isKillKey(filtered, key)) onClearInput?.()
  const textChanged = next.text !== liveValue
  if (textChanged) onChange(next.text)
  if (next.offset !== liveOffset || textChanged) setOffset(next.offset)
  if (!externalLiveReader) liveRef.current = { value: next.text, offset: next.offset }

  if (
    !key.isPasted &&
    filtered.length > 1 &&
    filtered.endsWith('\r') &&
    !filtered.slice(0, -1).includes('\r') &&
    !isBackslashContinuation(filtered, filtered.length - 1)
  ) {
    onSubmit?.(readLive().value)
  }
}

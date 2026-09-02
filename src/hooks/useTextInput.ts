// The single readline-style editing engine behind every Mercury text field:
// key→cursor-operation routing, the kill/yank ring, history hand-off,
// paste/DEL sanitation, and the screen-selection range-edit seam.
//
// Fully controlled: the caller supplies text, cursor offset and columns; the
// hook derives a cursor model per render and stores nothing of its own. The
// per-event processing order is load-bearing (filter → selection seam →
// raw-DEL sanitation → kill/yank resets → routing → commit → coalesced
// submit): a plain terminal backspace often arrives as a bare DEL byte with
// no key flags, and running sanitation before the selection seam would eat a
// character before the seam ever saw the event.

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
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { spliceInputRange } from '../utils/inputRange.js'
import { EXIT_CHORD_WINDOW_MS, useDoublePress } from './useDoublePress.js'

const ESCAPE_CLEAR_NOTIFICATION_KEY = 'escape-again-to-clear'

export type UseTextInputProps = {
  /** The caller's window into the banded viewport start —
   *  written every render so click-mapping reads the PAINTED window, and
   *  read back as the band's history. Optional: fieldless callers keep the
   *  centred stateless window. */
  viewportStartRef?: React.MutableRefObject<number | undefined>
  // Text and cursor.
  value: string
  onChange: (value: string) => void
  externalOffset: number
  onOffsetChange: (offset: number) => void
  columns: number
  // Outward actions.
  onSubmit?: (value: string) => void
  onExit?: () => void
  /** Escape with an owner-given meaning; absent ⇒ the double-press clear. */
  onEscape?: () => void
  onExitMessage?: (show: boolean, chordLabel?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  // Rendering.
  cursorChar?: string
  mask?: string
  invert?: (text: string) => string
  dim?: (text: string) => string
  maxVisibleLines?: number
  inlineGhostText?: InlineGhostText
  // Behaviour switches.
  multiline?: boolean
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  disablePageKeyCursorMovement?: boolean
  /** Enter's SUBMIT yields to a later listener (the completion menu's
   *  accept) — newline chords keep working. The raw listener registers
   *  child-first, so stopImmediatePropagation in the menu's handler runs
   *  too late to fence it; this option is the arbitration instead. */
  suppressEnterSubmit?: boolean
  // Interception.
  inputFilter?: (input: string, key: Key) => string
  selectionRange?: () => { start: number; end: number } | null | undefined
  onBeforeRangeEdit?: () => void
  onSelectionConsumed?: () => void
  // Accepted and currently ignored: part of the declared shape (callers pass
  // them), but nothing here reads them — the image-paste chord is owned by
  // the composer's keybindings.
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
}: UseTextInputProps): TextInputState {
  const { addNotification, removeNotification } = useNotifications()

  // On Apple Terminal the native modifier probe must be warm before the first
  // shift+Enter; the warm call is idempotent.
  if (env.terminal === 'Apple_Terminal') {
  }

  const offset = externalOffset

  // Burst survival under the controlled model: several key events can land
  // in ONE React batch, and every one of them would otherwise rebuild the
  // cursor from the same render-stale props (an 11-DEL SSH burst deleted
  // six). The ref mirrors the freshest committed value/offset WITHIN the
  // tick; assignment during render keeps props authoritative — an external
  // set or a caller that declines the change wins on the next render, so
  // the "no feedback ⇒ no movement" law is preserved.
  const liveRef = useRef({ value, offset })
  liveRef.current = { value, offset }

  const setOffset = (next: number): void => {
    onOffsetChange(next)
  }

  // The exit chords ride their own 3 s window (EXIT_CHORD_WINDOW_MS) —
  // distinct from Esc's 800 ms double-tap below.
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
      // Emptiness is re-checked at fire time: a draft typed between the two
      // presses cancels the exit.
      if (value === '') onExit?.()
    },
    undefined,
    EXIT_CHORD_WINDOW_MS,
  )

  // THE RULED WINDOW (the operator's word): "double clicking
  // escape … should clear the chat box … within the same three second
  // window" — the default 800 ms double-press read as a no-op at human esc
  // pacing. The cleared draft is recoverable the estate's usual way: it
  // banks to history first (↑ brings it back).
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
        // The logical move clamps to offset 0 on the first logical line; for
        // a history-wired input that clamp swallowed the keypress. A genuine
        // previous-line move (a newline exists before the cursor) is always
        // taken.
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



  // SSH and tmux deliver both a key event and raw DEL bytes for one physical
  // backspace: apply each DEL as a backspace in one synchronous pass and
  // commit once. The count comes from the UNFILTERED input.
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
      // The backslash-return idiom: consume the backslash, insert a newline,
      // and record the discovery signal for terminal setup. A backslash that
      // ends a Windows path (`C:\Users\`) is a separator, not the idiom — ↵
      // submits and the separator stays (isBackslashContinuation).
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    if (key.meta || key.shift) return cursor.insert('\n')
    // One owner per Enter: while a self-submitting completion menu is open,
    // the raw submit yields — the menu's accept (a LATER listener) submits
    // the completed form exactly once. Without this, one Enter submitted
    // twice: the raw buffer first, then the accepted completion queued
    // behind it (the /model double-execution class).
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
    // Enter is matched before the bare-meta branch, so meta+Enter inserts a
    // newline instead of routing as a meta chord.
    if (key.return) return handleEnter(cursor, key)

    if (key.escape) {
      if (onEscape) {
        onEscape()
        return null
      }
      if (!disableEscapeDoublePress) handleEscape()
      return null
    }

    // Tab is owned by the typeahead; wheel events are owned by the scroll
    // handler (their raw SGR bytes must never land as text).
    if (key.tab) return null
    if (key.wheelUp || key.wheelDown) return null

    // Shift+up/down match no branch at all and fall to the default text
    // branch, leaving the chord to the host.
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
    // Raw escape sequences some terminals send for home/end.
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
      // In fullscreen (or with the host opt-out) the hosting pager owns the
      // page keys.
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

    // Input-mode leading character: at the start of the draft a recognised
    // prefix character is inserted and the cursor moved back one, so the mode
    // indicator can take over the slot. The test runs against the RAW input,
    // so a coalesced "!\r" is not treated as a mode prefix.
    if (cursor.offset === 0 && isInputModeCharacter(rawInput)) {
      return cursor.insert(rawInput).left()
    }

    // The default text branch: strip ANSI escapes; drop a trailing carriage
    // return that follows a non-backslash, non-CR, non-LF character (a
    // batched "o\r" from a slow link); every remaining CR becomes a newline.
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
    // The filter emptying a non-empty input drops the event entirely.
    if (inputFilter && filtered === '' && rawInput !== '') return

    const { value: liveValue, offset: liveOffset } = liveRef.current
    const cursor = Cursor.fromText(liveValue, columns, liveOffset)

    // The screen-selection range-edit seam, BEFORE raw-DEL sanitation (a
    // bare DEL byte with no key flags must reach it intact). The adapter
    // answering with nothing (no selection, another region's selection,
    // reverse-search handoff) means byte-identical no-selection behaviour.
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
            return
          }
          if (key.escape) {
            onSelectionConsumed?.()
            return
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

    // Kill accumulation and yank chains break on any key that is not,
    // respectively, a kill or yank key — evaluated against the FILTERED
    // input, before routing. Note ctrl+backspace performs a word kill but is
    // NOT in the kill-key set: two consecutive ctrl+backspaces leave two ring
    // entries where two meta+backspaces leave one.
    if (!isKillKey(filtered, key)) resetKillAccumulation()
    if (!isYankKey(filtered, key)) resetYankState()

    const next = routeKey(cursor, filtered, rawInput, key)
    if (!next) return

    if (next.text !== liveValue) onChange(next.text)
    if (next.offset !== liveOffset) setOffset(next.offset)
    liveRef.current = { value: next.text, offset: next.offset }

    // The coalesced-Enter submit (the SSH case): not a paste, longer than one
    // character, ends with the only CR, and the character before it is not a
    // backslash. It submits the POST-edit text — "o\r" submits "o".
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
  )
  const position = renderCursor.getPosition()
  // D2: the banded window — its history rides the caller's ref (or the
  // local one), and the SAME start feeds every derived offset so paint,
  // caret row and click mapping cannot disagree.
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

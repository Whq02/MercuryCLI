// The shared text-input core beneath TextInput and VimTextInput:
// declares the cursor, wraps the input handler with paste handling (a return
// arriving mid-paste is swallowed), subscribes to keystrokes only while
// focused, prefers a caller-supplied placeholder element, renders the
// argument hint only for slash-command-shaped values, and filters highlights
// against the cursor and the horizontal viewport window.

import React, { useEffect } from 'react'
import { Box, Text } from '../ink.js'
import useInput from '../ink/hooks/use-input.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import type { useTextInput } from '../hooks/useTextInput.js'
import { usePasteHandler } from '../hooks/usePasteHandler.js'
import type { BaseTextInputProps } from '../types/textInputTypes.js'

/** Structural mirror of the input-highlight rows (the declaring module keeps
 *  the type local). */
type TextHighlight = NonNullable<BaseTextInputProps['highlights']>[number]
import { HighlightedInput } from './PromptInput/ShimmeredInput.js'

type InputState = ReturnType<typeof useTextInput>

/** The hint renders only for a non-empty slash value that is a single
 *  word or ends in a space; a separating space is inserted when missing. */
export function argumentHintText(
  value: string,
  argumentHint: string | undefined,
): string | null {
  if (!argumentHint) return null
  if (value === '') return null
  if (!value.startsWith('/')) return null
  const singleWord = !value.includes(' ')
  const endsWithSpace = value.endsWith(' ')
  if (!singleWord && !endsWithSpace) return null
  return `${endsWithSpace ? '' : ' '}${argumentHint}`
}

/** Highlight filtering: while the cursor is shown, any highlight overlapping
 *  the cursor is dropped unless it is a dim highlight; when horizontally
 *  scrolled, only highlights intersecting the visible window survive, with
 *  their offsets rebased to the window. */
export function filterHighlights(
  highlights: TextHighlight[] | undefined,
  cursorShown: boolean,
  cursorOffset: number,
  windowStart: number,
  windowEnd: number,
): TextHighlight[] | undefined {
  if (!highlights || highlights.length === 0) return highlights
  let out = highlights
  if (cursorShown) {
    out = out.filter(
      highlight =>
        highlight.dimColor === true ||
        cursorOffset < highlight.start ||
        cursorOffset >= highlight.end,
    )
  }
  if (windowStart > 0) {
    out = out
      .filter(
        highlight => highlight.end > windowStart && highlight.start < windowEnd,
      )
      .map(highlight => ({
        ...highlight,
        start: Math.max(0, highlight.start - windowStart),
        end: Math.min(windowEnd - windowStart, highlight.end - windowStart),
      }))
  }
  return out
}

export function BaseTextInput({
  inputState,
  children,
  terminalFocus,
  invert,
  hidePlaceholderText = false,
  ...props
}: BaseTextInputProps & {
  inputState: InputState
  children?: React.ReactNode
  terminalFocus: boolean
  invert?: (text: string) => string
  hidePlaceholderText?: boolean
}): React.ReactNode {
  void invert
  const {
    onInput,
    renderedValue,
    cursorLine,
    cursorColumn,
    viewportCharOffset,
    viewportCharEnd,
  } = inputState
  const focused = props.focus !== false
  const cursorShown = props.showCursor !== false

  // The cursor is DECLARED (the renderer positions the real terminal
  // cursor); active only when focused, shown, and the terminal has focus.
  const cursorRef = useDeclaredCursor({
    line: cursorLine,
    column: cursorColumn,
    active: focused && cursorShown && terminalFocus,
  })

  // Paste handling wraps the raw handler; a return key that arrives while a
  // paste is in progress is suppressed (it belongs to the pasted text).
  const { wrappedOnInput, isPasting } = usePasteHandler({
    onPaste: props.onPaste,
    onImagePaste: props.onImagePaste,
    onInput: (input, key) => {
      if (isPasting && key.return) return
      onInput(input, key)
    },
  })

  // The caller learns of paste-state changes through an effect, never
  // mid-render.
  const { onIsPastingChange } = props
  useEffect(() => {
    onIsPastingChange?.(isPasting)
  }, [isPasting, onIsPastingChange])

  // Keystrokes are subscribed only while focused.
  useInput((input, key, event) => wrappedOnInput(input, key, event), {
    isActive: focused,
  })

  const hint = argumentHintText(props.value, props.argumentHint)
  const hintNode = hint ? <Text dimColor>{hint}</Text> : null

  if (props.value === '') {
    return (
      <Box ref={cursorRef}>
        {props.placeholderElement ??
          (!hidePlaceholderText && props.placeholder ? (
            <Text dimColor>{props.placeholder}</Text>
          ) : (
            <Text> </Text>
          ))}
        {hintNode}
        {children}
      </Box>
    )
  }

  const visibleHighlights = filterHighlights(
    props.highlights,
    cursorShown && focused,
    props.cursorOffset,
    viewportCharOffset,
    viewportCharEnd,
  )

  if (visibleHighlights && visibleHighlights.length > 0) {
    // The highlighting renderer is not wrap-limited.
    return (
      <Box ref={cursorRef}>
        <HighlightedInput
          text={renderedValue}
          highlights={visibleHighlights}
          baseColor={props.userTextColor}
        />
        {hintNode}
        {children}
      </Box>
    )
  }

  return (
    <Box ref={cursorRef}>
      <Text
        color={props.userTextColor}
        dimColor={props.dimColor}
        wrap="truncate-end"
      >
        {/* CI-02: renderedValue is ALREADY masked by the one
            mask owner (Cursor.render → maskLine: every grapheme masked,
            the document-last line keeping its six-grapheme tail, the caret
            rendered in place). The old repeat-per-code-unit re-mask here
            destroyed all of that and sized itself from a raw length that
            counted ANSI escapes and newlines — the owner's render is the
            paint. */}
        {renderedValue}
      </Text>
      {hintNode}
      {children}
    </Box>
  )
}

export default BaseTextInput

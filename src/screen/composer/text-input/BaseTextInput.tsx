import React from 'react'
import { usePublish } from '../../effects/effects.js'
import { Box, Text } from '../../themedRenderer.js'
import useInput from '../../renderer/bindings/use-input.js'
import { useDeclaredCursor } from '../../renderer/bindings/use-declared-cursor.js'
import type { useTextInput } from './useTextInput.js'
import { usePasteHandler } from '../usePasteHandler.js'
import type { BaseTextInputProps } from '../input-core/textInput.js'

type TextHighlight = NonNullable<BaseTextInputProps['highlights']>[number]
import { HighlightedInput } from '../ShimmeredInput.js'

type InputState = ReturnType<typeof useTextInput>

function argumentHintText(
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

function filterHighlights(
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
  value,
  placeholder = '',
  placeholderElement,
  focus = true,
  multiline = false,
  showCursor = true,
  argumentHint,
  highlights,
  userTextColor,
  dimColor,
  onPaste,
  onImagePaste,
  onImageError,
  onIsPastingChange,
  routeInput,
  pastePendingRef,
  inputState,
  children,
  terminalFocus,
  hidePlaceholderText = false,
  cursorOffset,
}: BaseTextInputProps & {
  inputState: InputState
  children?: React.ReactNode
  terminalFocus: boolean
  invert?: (text: string) => string
  hidePlaceholderText?: boolean
}): React.ReactNode {
  const {
    onInput,
    renderedValue,
    cursorLine,
    cursorColumn,
    viewportCharOffset,
    viewportCharEnd,
  } = inputState

  const { wrappedOnInput, isPasting, pendingNow } = usePasteHandler({
    onPaste,
    onInput: (input, key) => {
      if ((isPasting || pendingNow()) && key.return) return
      onInput(input, key)
    },
    onImagePaste,
    onImageError,
  })

  if (pastePendingRef) {
    pastePendingRef.current = pendingNow
  }

  usePublish(() => {
    onIsPastingChange?.(isPasting)
  }, [isPasting, onIsPastingChange])

  useInput(
    (input, key, event) => {
      const pastePending = isPasting || pendingNow()
      const verdict = routeInput
        ? routeInput(input, key, event, pastePending)
        : focus
          ? 'edit'
          : 'yield'
      if (verdict === 'yield') return
      if (verdict === 'consume') {
        event.stopImmediatePropagation()
        return
      }
      wrappedOnInput(input, key, event)
      if (verdict === 'edit-and-consume') {
        event.stopImmediatePropagation()
      }
    },
    { isActive: focus || routeInput !== undefined },
  )

  const cursorRef = useDeclaredCursor({
    line: cursorLine,
    column: cursorColumn,
    active: focus && showCursor && terminalFocus,
  })

  const hint = argumentHintText(value, argumentHint)
  const hintNode = hint !== null ? <Text dimColor>{hint}</Text> : null

  if (value === '') {
    const placeholderNode =
      placeholderElement != null ? (
        placeholderElement
      ) : placeholder && !hidePlaceholderText ? (
        <Text dimColor wrap={multiline ? undefined : 'truncate-end'}>
          {placeholder}
        </Text>
      ) : (
        <Text>{' '}</Text>
      )
    return (
      <Box ref={cursorRef}>
        {placeholderNode}
        {hintNode}
        {children}
      </Box>
    )
  }

  const activeHighlights = filterHighlights(
    highlights,
    focus && showCursor,
    cursorOffset,
    viewportCharOffset,
    viewportCharEnd,
  )

  if (activeHighlights && activeHighlights.length > 0) {
    return (
      <Box ref={cursorRef}>
        <HighlightedInput
          text={renderedValue}
          highlights={activeHighlights}
          baseColor={userTextColor}
        />
        {hintNode}
        {children}
      </Box>
    )
  }

  return (
    <Box ref={cursorRef}>
      <Text color={userTextColor} dimColor={dimColor} wrap="truncate-end">
        {renderedValue}
      </Text>
      {hintNode}
      {children}
    </Box>
  )
}

export default BaseTextInput

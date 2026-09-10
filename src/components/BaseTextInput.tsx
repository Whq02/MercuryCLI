
import React, { useEffect } from 'react'
import { Box, Text } from '../ink.js'
import useInput from '../ink/hooks/use-input.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import type { useTextInput } from '../hooks/useTextInput.js'
import { usePasteHandler } from '../hooks/usePasteHandler.js'
import type { BaseTextInputProps } from '../types/textInputTypes.js'

type TextHighlight = NonNullable<BaseTextInputProps['highlights']>[number]
import { HighlightedInput } from './PromptInput/ShimmeredInput.js'

type InputState = ReturnType<typeof useTextInput>

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

  const cursorRef = useDeclaredCursor({
    line: cursorLine,
    column: cursorColumn,
    active: focused && cursorShown && terminalFocus,
  })

  const { wrappedOnInput, isPasting, pendingNow } = usePasteHandler({
    onPaste: props.onPaste,
    onImagePaste: props.onImagePaste,
    onImageError: props.onImageError,
    onInput: (input, key) => {
      if (isPasting && key.return) return
      onInput(input, key)
    },
  })

  const { onIsPastingChange } = props
  useEffect(() => {
    onIsPastingChange?.(isPasting)
  }, [isPasting, onIsPastingChange])

  if (props.pastePendingRef) props.pastePendingRef.current = pendingNow
  useInput((input, key, event) => {
    const route = props.routeInput?.(input, key, event, pendingNow()) ?? (focused ? 'edit' : 'yield')
    if (route === 'yield') return
    if (route === 'consume') {
      event.stopImmediatePropagation()
      return
    }
    wrappedOnInput(input, key, event)
    if (route === 'edit-and-consume') event.stopImmediatePropagation()
  }, { isActive: focused || props.routeInput !== undefined })

  const hint = argumentHintText(props.value, props.argumentHint)
  const hintNode = hint ? <Text dimColor>{hint}</Text> : null

  if (props.value === '') {
    return (
      <Box ref={cursorRef}>
        {props.placeholderElement ??
          (!hidePlaceholderText && props.placeholder ? (
            <Text dimColor wrap={props.maxVisibleLines === 1 ? "truncate-end" : undefined}>{props.placeholder}</Text>
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
        {
}
        {renderedValue}
      </Text>
      {hintNode}
      {children}
    </Box>
  )
}

export default BaseTextInput

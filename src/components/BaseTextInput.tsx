import React from 'react'
import { usePublish } from '../hooks/effects.js'
import { Box, Text } from '../ink.js'
import useInput from '../ink/hooks/use-input.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import type { useTextInput } from '../hooks/useTextInput.js'
import { usePasteHandler } from '../hooks/usePasteHandler.js'
import type { BaseTextInputProps } from '../types/textInputTypes.js'

type TextHighlight = NonNullable<BaseTextInputProps['highlights']>[number]
import { HighlightedInput } from './PromptInput/ShimmeredInput.js'
import { notBuilt } from '../pi/holes.js'

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

export function BaseTextInput(arg0: BaseTextInputProps & {
  inputState: InputState
  children?: React.ReactNode
  terminalFocus: boolean
  invert?: (text: string) => string
  hidePlaceholderText?: boolean
}): React.ReactNode {
  return notBuilt('src/components/BaseTextInput.tsx:60')
}

export default BaseTextInput

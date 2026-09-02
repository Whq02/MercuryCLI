// Search field: a bordered (or borderless) one-line field with a
// prefix glyph. Focused AND terminal-focused, the character at the cursor
// offset renders inverted (a space when the cursor sits at the end); without
// terminal focus the text renders plainly. Empty shows the placeholder,
// first character inverted under the same condition. Unfocused dims the
// prefix and renders query or placeholder plainly.

import React from 'react'
import { Box, Text } from '../ink.js'

export function SearchBox({
  query,
  placeholder = 'Search…',
  isFocused,
  isTerminalFocused,
  prefix = '/',
  width,
  cursorOffset,
  borderless = false,
}: {
  query: string
  placeholder?: string
  isFocused: boolean
  isTerminalFocused: boolean
  prefix?: string
  width?: number
  cursorOffset?: number
  borderless?: boolean
}): React.ReactNode {
  const showCursor = isFocused && isTerminalFocused

  let body: React.ReactNode
  if (query === '') {
    if (showCursor && placeholder.length > 0) {
      body = (
        <Text dimColor>
          <Text inverse>{placeholder[0]}</Text>
          {placeholder.slice(1)}
        </Text>
      )
    } else {
      body = <Text dimColor>{placeholder}</Text>
    }
  } else if (showCursor) {
    const offset = Math.max(0, Math.min(cursorOffset ?? query.length, query.length))
    const at = offset < query.length ? query[offset]! : ' '
    body = (
      <Text>
        {query.slice(0, offset)}
        <Text inverse>{at}</Text>
        {offset < query.length ? query.slice(offset + 1) : ''}
      </Text>
    )
  } else {
    body = <Text>{query}</Text>
  }

  return (
    <Box
      borderStyle={borderless ? undefined : 'round'}
      borderDimColor
      paddingX={borderless ? 0 : 1}
      width={width}
    >
      <Text dimColor={!isFocused}>{prefix} </Text>
      {body}
    </Box>
  )
}

export default SearchBox

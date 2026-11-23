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

  let content: React.ReactNode
  if (query.length === 0) {
    if (showCursor) {
      const firstChar = placeholder[0] ?? ' '
      const rest = placeholder.slice(1)
      content = (
        <Text dimColor>
          <Text inverse>{firstChar}</Text>
          {rest}
        </Text>
      )
    } else {
      content = <Text dimColor>{placeholder}</Text>
    }
  } else if (showCursor) {
    const clamped = Math.max(
      0,
      Math.min(query.length, cursorOffset ?? query.length),
    )
    const before = query.slice(0, clamped)
    const cursorChar = clamped < query.length ? query[clamped]! : ' '
    const after = clamped < query.length ? query.slice(clamped + 1) : ''
    content = (
      <Text>
        {before}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    )
  } else {
    content = <Text>{query}</Text>
  }

  return (
    <Box
      borderStyle={borderless ? undefined : 'round'}
      borderDimColor={borderless ? undefined : true}
      paddingX={borderless ? 0 : 1}
      width={width}
    >
      <Text dimColor={!isFocused}>{prefix} </Text>
      {content}
    </Box>
  )
}

export default SearchBox

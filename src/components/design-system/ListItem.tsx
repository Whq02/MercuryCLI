
import figures from 'figures'
import { GLYPH } from '../mercury-ui/glyphs.js'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

export type ListItemProps = {
  isFocused?: boolean
  isSelected?: boolean
  children?: React.ReactNode
  description?: string
  showScrollDown?: boolean
  showScrollUp?: boolean
  styled?: boolean
  disabled?: boolean
  declareCursor?: boolean
}

export function ListItem({
  isFocused = false,
  isSelected = false,
  children,
  description,
  showScrollDown = false,
  showScrollUp = false,
  styled = true,
  disabled = false,
  declareCursor = true,
}: ListItemProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused && !disabled && declareCursor,
  })

  let indicator: React.ReactNode
  if (disabled) {
    indicator = <Text> </Text>
  } else if (isFocused) {
    indicator = <Text color="suggestion">{figures.pointer}</Text>
  } else if (showScrollDown) {
    indicator = <Text dimColor>{figures.arrowDown}</Text>
  } else if (showScrollUp) {
    indicator = <Text dimColor>{figures.arrowUp}</Text>
  } else {
    indicator = <Text> </Text>
  }

  let stateColor: string | undefined
  if (disabled) stateColor = 'inactive'
  else if (!styled) stateColor = undefined
  else if (isSelected) stateColor = 'success'
  else if (isFocused) stateColor = 'suggestion'

  const showCheckmark = isSelected && !disabled

  return (
    <Box flexDirection="column" ref={cursorRef}>
      <Box
        width="100%"
        gap={1}
        backgroundColor={
          isFocused && !disabled ? tokens.selectionBand : undefined
        }
      >
        {indicator}
        {styled ? (
          <Text color={stateColor} dimColor={disabled}>
            {children}
          </Text>
        ) : (
          children
        )}
        {showCheckmark ? <Text color="success">{GLYPH.check}</Text> : null}
      </Box>
      {description !== undefined && description !== '' ? (
        <Box paddingLeft={2}>
          <Text color="inactive">{description}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default ListItem

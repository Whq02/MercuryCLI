// The ONE selection row: roughly eighty dialogs paint through this site.
// Indicator, state colours, the full-width selection band behind the
// focused row, the trailing chosen checkmark, and the terminal-cursor
// declaration for screen readers and magnifiers all live here, never per
// consumer.

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
  /** Unstyled mode renders the children verbatim: no colour wrapper and no
   *  dim wrapper either (a disabled unstyled row is NOT dimmed). */
  styled?: boolean
  disabled?: boolean
  /** Off when a child text field declares its own cursor. */
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
  // The declaration rides the outer column element so it covers the
  // description line too, parked at the row origin.
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused && !disabled && declareCursor,
  })

  // Indicator priority: disabled blank; focused pointer; scroll hints; blank.
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

  // The chosen (checkmark) state is deliberately quieter than the focused
  // band: the cursor row is what Enter acts on.
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

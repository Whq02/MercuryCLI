// The indented "response under a call" wrapper: connector glyph + clipped
// row. The connector is non-selectable from the left edge so a transcript
// copy never picks up the glyph or its indent; nesting is suppressed via
// context so connector glyphs never stack; and without an explicit height
// the row rides the offscreen ratchet.

import React, { createContext, useContext } from 'react'
import { Box, NoSelect, Text } from '../ink.js'
import { OUTPUT_CONNECTOR } from '../constants/figures.js'
import { Ratchet } from './design-system/Ratchet.js'

const MessageResponseContext = createContext(false)

export function MessageResponse({
  children,
  height,
}: {
  children: React.ReactNode
  height?: number
}): React.ReactNode {
  const nested = useContext(MessageResponseContext)
  // TOTAL over ReactNode (C14 — the class A2/Byline closed): this wrapper
  // hosts TOOL-supplied render output inside a Box, and a bare
  // string/number child reaching a Box trips Ink's text invariant at the
  // app root and ends the session. The wrapper owns the totality, not each
  // tool — Byline's own law. Both arms wrap: the nested arm's children land
  // in the OUTER wrapper's Box after this component has already passed its
  // own walk, so bare text must not slip through either door.
  const total = React.Children.toArray(children).map((child, position) =>
    React.isValidElement(child) ? (
      child
    ) : (
      <Text key={`total-${position}`}>{child}</Text>
    ),
  )
  // A response wrapper inside another renders its children bare.
  if (nested) return <>{total}</>

  const row = (
    <Box height={height} overflowY="hidden">
      <NoSelect fromLeftEdge>
        <Text dimColor>{`  ${OUTPUT_CONNECTOR}`}</Text>
      </NoSelect>
      <MessageResponseContext.Provider value={true}>
        {total}
      </MessageResponseContext.Provider>
    </Box>
  )

  if (height !== undefined) return row
  return <Ratchet lock="offscreen">{row}</Ratchet>
}

export default MessageResponse

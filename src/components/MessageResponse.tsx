
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
  const total = React.Children.toArray(children).map((child, position) =>
    React.isValidElement(child) ? (
      child
    ) : (
      <Text key={`total-${position}`}>{child}</Text>
    ),
  )
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

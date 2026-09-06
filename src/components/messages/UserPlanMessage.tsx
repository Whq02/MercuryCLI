
import React from 'react'
import { Box, Text } from '../../ink.js'
import { Markdown } from '../Markdown.js'

export function UserPlanMessage({
  addMargin,
  planContent,
}: {
  addMargin?: boolean
  planContent: string
}): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      borderStyle="round"
      borderColor="strategyMode"
      paddingX={1}
    >
      <Text bold color="strategyMode">
        Plan to implement
      </Text>
      <Markdown>{planContent}</Markdown>
    </Box>
  )
}

export default UserPlanMessage

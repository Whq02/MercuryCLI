// Bordered card presenting the plan the model intends to implement.

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
      borderColor="planMode"
      paddingX={1}
    >
      <Text bold color="planMode">
        Plan to implement
      </Text>
      <Markdown>{planContent}</Markdown>
    </Box>
  )
}

export default UserPlanMessage

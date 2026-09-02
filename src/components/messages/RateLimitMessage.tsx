
import React from 'react'
import { Box, Text } from '../../ink.js'

export {
  getUpsellMessage,
  type UpsellMessageParams,
} from '../../services/rateLimitMessages.js'

export function RateLimitMessage({
  addMargin = false,
  text,
}: {
  addMargin?: boolean
  text: string
}): React.ReactNode {
  const [head = '', ...remedies] = text.split('\n')
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text color="error">{head}</Text>
      {remedies
        .filter(line => line.trim() !== '')
        .map(line => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
    </Box>
  )
}

export default RateLimitMessage

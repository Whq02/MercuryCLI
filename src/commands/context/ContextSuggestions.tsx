
import React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { StatusIcon } from '../../screen/theme/StatusIcon.js'
import type { StatusIconStatus } from '../../screen/theme/StatusIcon.js'
import type { ContextSuggestion } from '../../engine/context-window/contextSuggestions.js'
import { formatNumber } from '../../platform/text/format.js'

export function ContextSuggestions({
  suggestions,
}: {
  suggestions: ContextSuggestion[]
}): React.ReactNode {
  if (suggestions.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Suggestions</Text>
      {suggestions.map((suggestion, index) => (
        <Box key={index} flexDirection="column">
          <Text>
            <StatusIcon status={suggestion.severity as StatusIconStatus} withSpace />
            <Text bold>{suggestion.title}</Text>
            {suggestion.savingsTokens !== undefined ? (
              <Text dimColor>
                {' '}
                (~{formatNumber(suggestion.savingsTokens)} tokens)
              </Text>
            ) : null}
          </Text>
          <Box paddingLeft={2}>
            <Text dimColor wrap="wrap">
              {suggestion.detail}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export default ContextSuggestions

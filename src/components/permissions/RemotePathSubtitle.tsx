import * as React from 'react'
import { Box, Text } from '../../ink.js'

export function RemotePathSubtitle({ path }: { path: string }): React.ReactNode {
  const cut = path.indexOf('/', path.indexOf('://') + 3)
  return (
    <Box>
      <Box flexShrink={0} maxWidth="100%">
        <Text color="subtle" dimColor={false} wrap="truncate-end">
          {cut === -1 ? path : path.slice(0, cut)}
        </Text>
      </Box>
      {cut === -1 ? null : (
        <Text color="subtle" dimColor={false} wrap="truncate-start">
          {path.slice(cut)}
        </Text>
      )}
    </Box>
  )
}

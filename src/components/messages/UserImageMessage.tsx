
import React from 'react'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import { storedImageState } from '../../utils/imageStore.js'

export function UserImageMessage({
  addMargin = false,
  imageId,
}: {
  addMargin?: boolean
  imageId?: number
}): React.ReactNode {
  const label = imageId !== undefined ? `[Image #${imageId}]` : '[Image]'
  const stored = imageId !== undefined ? storedImageState(imageId) : null
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text dimColor>
        {stored !== null && stored.present ? (
          <Link url={`file://${stored.path}`} fallback={label}>
            {label}
          </Link>
        ) : (
          label
        )}
        {stored !== null && !stored.present ? ` · file missing: ${stored.path}` : ''}
      </Text>
    </Box>
  )
}

export default UserImageMessage

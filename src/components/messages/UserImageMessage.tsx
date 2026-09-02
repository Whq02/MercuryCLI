// Image-attachment placeholder. The label is the transcript-search
// contract (`[Image #N]` / `[Image]`); when the image is stored and the
// terminal supports hyperlinks the label links to the stored file.

import React from 'react'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import { getStoredImagePath } from '../../utils/imageStore.js'

export function UserImageMessage({
  addMargin = false,
  imageId,
}: {
  addMargin?: boolean
  imageId?: number
}): React.ReactNode {
  const label = imageId !== undefined ? `[Image #${imageId}]` : '[Image]'
  const storedPath =
    imageId !== undefined ? getStoredImagePath(imageId) : null
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text dimColor>
        {storedPath ? (
          <Link url={`file://${storedPath}`} fallback={label}>
            {label}
          </Link>
        ) : (
          label
        )}
      </Text>
    </Box>
  )
}

export default UserImageMessage

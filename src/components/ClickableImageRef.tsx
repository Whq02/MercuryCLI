
import React from 'react'
import { Text } from '../ink.js'
import Link from '../ink/components/Link.js'
import { supportsHyperlinks } from '../ink/session/capabilities.js'
import { formatImageRef } from '../history.js'
import { storedImageState } from '../utils/imageStore.js'

export function ClickableImageRef({
  imageId,
  backgroundColor,
  isSelected = false,
}: {
  imageId: number
  backgroundColor?: string
  isSelected?: boolean
}): React.ReactNode {
  const label = formatImageRef(imageId)
  const stored = storedImageState(imageId)
  const storedPath = stored !== null && stored.present ? stored.path : null

  if (storedPath !== null && supportsHyperlinks()) {
    return (
      <Text
        backgroundColor={backgroundColor}
        inverse={isSelected}
        bold={isSelected}
      >
        <Link url={`file://${storedPath}`} fallback={label}>
          {label}
        </Link>
      </Text>
    )
  }
  return (
    <Text backgroundColor={backgroundColor} inverse={isSelected} dimColor>
      {label}
    </Text>
  )
}

export default ClickableImageRef

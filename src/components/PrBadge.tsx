// A PR label plus a linked number: underlined when linked, coloured by the
// review state, and dimmed when neither a state colour nor bold applies.

import React from 'react'
import { Text } from '../ink.js'
import Link from '../ink/components/Link.js'

const STATE_COLORS: Record<string, string | undefined> = {
  approved: 'success',
  changes_requested: 'error',
  pending: 'warning',
  merged: 'merged',
}

export function PrBadge({
  number,
  url,
  reviewState,
  bold = false,
}: {
  number: number
  url?: string
  reviewState?: string
  bold?: boolean
}): React.ReactNode {
  const color = reviewState ? STATE_COLORS[reviewState] : undefined
  const dim = color === undefined && !bold
  const label = `#${number}`
  return (
    <Text color={color} bold={bold} dimColor={dim} underline={Boolean(url)}>
      PR{' '}
      {url ? (
        <Link url={url} fallback={label}>
          {label}
        </Link>
      ) : (
        label
      )}
    </Text>
  )
}

export default PrBadge

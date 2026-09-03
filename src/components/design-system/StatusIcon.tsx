// Status → glyph + colour role (contract data as a mapping table). The two
// roleless entries render dimmed.

import figures from 'figures'
import { GLYPH } from '../mercury-ui/glyphs.js'
import React from 'react'
import { Text } from '../../ink.js'

export type StatusIconStatus =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'pending'
  | 'loading'

const STATUS_TABLE: Record<
  StatusIconStatus,
  { glyph: string; color: string | undefined }
> = {
  success: { glyph: GLYPH.check, color: 'success' },
  error: { glyph: figures.cross, color: 'error' },
  warning: { glyph: GLYPH.warn, color: 'warning' },
  info: { glyph: GLYPH.info, color: 'suggestion' },
  pending: { glyph: figures.circle, color: undefined },
  loading: { glyph: '…', color: undefined },
}

export function StatusIcon({
  status,
  withSpace = false,
}: {
  status: StatusIconStatus
  withSpace?: boolean
}): React.ReactNode {
  const entry = STATUS_TABLE[status]
  return (
    <Text color={entry.color} dimColor={entry.color === undefined}>
      {entry.glyph}
      {withSpace ? ' ' : ''}
    </Text>
  )
}

export default StatusIcon

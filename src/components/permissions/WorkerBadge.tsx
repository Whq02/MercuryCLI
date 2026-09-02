import * as React from 'react'
import { Text } from '../../ink.js'
import { toInkColor } from '../../utils/ink.js'

export type WorkerBadgeProps = {
  name: string
  color: string
}

export function WorkerBadge({ name, color }: WorkerBadgeProps): React.ReactNode {
  return (
    <Text color={toInkColor(color)}>
      {'●'} <Text bold>@{name}</Text>
    </Text>
  )
}

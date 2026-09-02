import * as React from 'react'
import { Text } from '../../ink.js'
import { toInkColor } from '../../utils/ink.js'

export type WorkerBadgeProps = {
  name: string
  color: string
}

/**
 * The `@name` badge identifying the swarm worker that raised a request: a
 * filled circle, a space, then the bold name — the whole run in the worker's
 * colour (hex or named, resolved through the ink colour adapter).
 */
export function WorkerBadge({ name, color }: WorkerBadgeProps): React.ReactNode {
  return (
    <Text color={toInkColor(color)}>
      {'●'} <Text bold>@{name}</Text>
    </Text>
  )
}


import * as React from 'react'
import { Text } from '../../ink.js'
import { plural } from '../../utils/stringUtils.js'

export function CapabilitiesSection({
  toolCount,
  resourceCount,
  promptCount,
}: {
  toolCount: number
  resourceCount: number
  promptCount: number
}): React.ReactNode {
  const parts: string[] = []
  if (toolCount > 0) parts.push(`${toolCount} ${plural(toolCount, 'tool')}`)
  if (resourceCount > 0) {
    parts.push(`${resourceCount} ${plural(resourceCount, 'resource')}`)
  }
  if (promptCount > 0) {
    parts.push(`${promptCount} ${plural(promptCount, 'prompt')}`)
  }
  return (
    <Text>
      <Text dimColor>Capabilities: </Text>
      {parts.length > 0 ? parts.join(' · ') : 'none'}
    </Text>
  )
}

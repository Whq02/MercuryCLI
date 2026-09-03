import * as React from 'react'
import { Text } from '../../ink.js'


export function EffortStrip({
  levels,
  current,
  accent,
  faint,
}: {
  levels: readonly string[]
  current: string | undefined
  accent: string
  faint: string
}): React.ReactNode {
  return (
    <Text>
      <Text color={faint}>effort  </Text>
      {levels.map(e => (
        <Text key={e} bold={e === current} color={e === current ? accent : faint}>
          {e === current ? `[${e}] ` : `${e} `}
        </Text>
      ))}
    </Text>
  )
}

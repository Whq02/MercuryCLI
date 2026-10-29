import * as React from 'react'
import { Text } from '../../ink.js'


const EFFORT_LEAD = 'effort  '
const levelText = (level: string, current: string | undefined): string => (level === current ? `[${level}] ` : `${level} `)

export function effortStripText(levels: readonly string[], current: string | undefined): string {
  return EFFORT_LEAD + levels.map(level => levelText(level, current)).join('')
}

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
      <Text color={faint}>{EFFORT_LEAD}</Text>
      {levels.map(e => (
        <Text key={e} bold={e === current} color={e === current ? accent : faint}>
          {levelText(e, current)}
        </Text>
      ))}
    </Text>
  )
}

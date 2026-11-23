
import React from 'react'

type Props = {
  readonly lines: readonly string[]
  readonly width: number
}

export function RawAnsi({ lines, width }: Props): React.ReactNode {
  if (lines.length === 0) return null
  return (
    <ink-raw-ansi
      rawText={lines.join('\n')}
      rawWidth={width}
      rawHeight={lines.length}
    />
  )
}

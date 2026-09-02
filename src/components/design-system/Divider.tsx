
import React from 'react'
import { Ansi, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import stripAnsi from 'strip-ansi'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'

const DEFAULT_RULE_CHAR = '─'

export function Divider({
  width,
  color,
  char = DEFAULT_RULE_CHAR,
  padding = 0,
  title,
}: {
  width?: number
  color?: string
  char?: string
  padding?: number
  title?: string
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const total = Math.max(0, (width ?? columns) - padding)

  if (title !== undefined && title !== '') {
    const titleWidth = stringWidth(stripAnsi(title)) + 2
    const remainder = Math.max(0, total - titleWidth)
    const left = Math.floor(remainder / 2)
    const right = remainder - left
    return (
      <Text>
        <Text color={color} dimColor={color === undefined}>
          {char.repeat(left)}
        </Text>{' '}
        <Text dimColor>
          <Ansi>{title}</Ansi>
        </Text>{' '}
        <Text color={color} dimColor={color === undefined}>
          {char.repeat(right)}
        </Text>
      </Text>
    )
  }

  return (
    <Text color={color} dimColor={color === undefined}>
      {char.repeat(total)}
    </Text>
  )
}

export default Divider

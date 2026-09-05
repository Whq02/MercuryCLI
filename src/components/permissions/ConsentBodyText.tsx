
import * as React from 'react'
import { useState } from 'react'
import { Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { boundLines, consentBodyBudget, consentContentWidth } from './consentBodyBudget.js'

export function ConsentBodyText({
  text,
  tail = '',
  dimColor = false,
  after,
}: {
  text: string
  tail?: string
  dimColor?: boolean
  after?: React.ReactNode
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  })
  const bounded = boundLines(
    text.split('\n'),
    consentContentWidth(columns),
    expanded ? null : consentBodyBudget(rows),
  )
  return (
    <>
      <Text dimColor={dimColor}>
        {bounded.lines.join('\n')}
        {after ?? null}
      </Text>
      {bounded.hiddenLines > 0 ? (
        <Text dimColor>
          … +{bounded.hiddenLines} more line{bounded.hiddenLines === 1 ? '' : 's'} · ctrl+f expands{tail}
        </Text>
      ) : null}
      {expanded ? <Text dimColor>ctrl+f collapses the preview</Text> : null}
    </>
  )
}

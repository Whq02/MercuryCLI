import * as React from 'react'
import { Text } from '../ink.js'
import { usePopupCompact } from '../context/popupFormContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { KEY_PAGES, type KeyFamilyValue } from './loginFamilyRows.js'

export const KEY_CARD_BACK = 'esc back'

export function keyCardLine(family: KeyFamilyValue, title: string, columns: number): { title: string; tail: string } {
  const page = ` · ${KEY_PAGES[family]}`
  const back = ` · ${KEY_CARD_BACK}`
  return { title, tail: stringWidth(title + page + back) <= columns ? page + back : back }
}

export function KeyCardTitle({ family, short, children }: { family: KeyFamilyValue; short?: string; children: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const { columns } = useTerminalSize()
  const line = compact ? keyCardLine(family, short ?? children, columns) : null
  return (
    <Text bold color={tokens.accent} wrap="truncate-end">
      {line === null ? children : line.title}
      {line === null ? null : <Text bold={false} color={tokens.textMuted}>{line.tail}</Text>}
    </Text>
  )
}

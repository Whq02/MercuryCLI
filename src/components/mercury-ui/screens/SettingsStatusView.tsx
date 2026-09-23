import * as React from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../../context/overlayContext.js'
import { Box, Text, useInput } from '../../../ink.js'
import wrapText from '../../../ink/wrap-text.js'
import { FAINT, IVORY } from '../../mercuryPalette.js'

export type StatusFact = { k: string; v: string; tone?: string; note?: string; noteTone?: string; bold?: boolean }
export type StatusMcp = { tone: string; count: string; label: string }

export function SettingsStatusView({
  onClose,
  facts,
  width,
  rowBudget,
}: {
  onClose: () => void
  facts: StatusFact[]
  width: number
  rowBudget: number
}): React.ReactNode {
  const inner = Math.max(0, Math.floor(width))
  const budget = Math.max(0, Math.floor(rowBudget))
  const lines = React.useMemo(() => facts.flatMap(fact => {
    const text = fact.v + (fact.note ?? '')
    let from = 0
    return wrapText(text, Math.max(1, inner), 'wrap').split('\n').map((line, index) => {
      const at = text.indexOf(line, from)
      from = Math.max(from, at + line.length)
      return { ...fact, key: `${fact.k}:${index}`, line, noteAt: Math.max(0, fact.v.length - at) }
    })
  }), [facts, inner])
  const overflowing = lines.length > budget
  const capacity = Math.max(1, budget - (overflowing && budget > 1 ? 1 : 0))
  const last = Math.max(0, lines.length - capacity)
  const [offset, setOffset] = React.useState(0)
  const start = Math.min(offset, last)
  const below = Math.max(0, lines.length - start - capacity)
  const overlay = useRegisterOverlay('status')
  useInput((_input, key, event) => {
    if (overlay !== null && !isTopOverlayNow(overlay)) return
    if (key.escape) {
      event.stopImmediatePropagation()
      onClose()
    } else if (overflowing && (key.upArrow || key.downArrow)) {
      event.stopImmediatePropagation()
      setOffset(current => Math.max(0, Math.min(last, Math.min(current, last) + (key.downArrow ? 1 : -1))))
    }
  })
  if (inner === 0 || budget === 0) return null
  return (
    <Box width={inner} flexDirection="column" flexShrink={0}>
      {lines.slice(start, start + capacity).map(row => (
        <Box key={row.key} height={1} flexShrink={0}>
          <Text color={row.tone ?? IVORY} bold={row.bold} wrap="truncate-end">
            {row.line.slice(0, row.noteAt)}
            <Text color={row.noteTone ?? row.tone ?? FAINT}>{row.line.slice(row.noteAt)}</Text>
          </Text>
        </Box>
      ))}
      {overflowing && budget > 1 ? (
        <Box height={1} flexShrink={0}>
          <Text color={FAINT} wrap="truncate-end">{below > 0 ? `↓ ${below} more` : ''}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

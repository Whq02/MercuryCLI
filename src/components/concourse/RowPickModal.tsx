import React, { useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { FloatingPopup } from '../PopupGutter.js'
import { paneWindow } from '../mercury-ui/paneWindow.js'

export function RowPickModal({
  cols,
  rows,
  titlePrefix,
  title,
  legend,
  options,
  onPick,
  onClose,
}: {
  cols: number
  rows: number
  titlePrefix: string
  title: string
  legend: string
  options: ReadonlyArray<{ id: string; label: string }>
  onPick: (id: string, label: string) => void
  onClose: () => void
}): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-session-model')
  const [at, setAt] = useState(0)
  const atRef = useRef(0)
  const selected = Math.max(0, Math.min(at, options.length - 1))
  atRef.current = selected
  useInput((_input, key, event) => {
    event.stopImmediatePropagation()
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      atRef.current = Math.max(0, Math.min(options.length - 1, atRef.current + (key.downArrow ? 1 : -1)))
      setAt(atRef.current)
      return
    }
    if (key.return) {
      const o = options[Math.max(0, Math.min(options.length - 1, atRef.current))]
      if (o !== undefined) onPick(o.id, o.label)
      else onClose()
    }
  })
  const width = Math.min(64, Math.max(40, cols - 8))
  const window = paneWindow(options.length, selected, Math.max(3, Math.min(10, rows - 10)))
  const shown = options.slice(window.start, window.end)
  return (
    <FloatingPopup host={{ left: 0, top: 0, columns: cols, rows }} width={width} borderColor={t.info} paddingX={2}>
      <Box height={1} flexShrink={0}>
        <Text bold color={t.info} wrap="truncate-end">
          {titlePrefix} — {title}
        </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        {shown.map((o, i) => (
          <InteractiveRow
            key={o.id}
            id={`concourse:row-pick:${o.id}`}
            directActivate
            hoverStyle="row-fill"
            onActivate={() => onPick(o.id, o.label)}
          >
            {(hover: boolean) => (
              <Text wrap="truncate-end">
                <Text color={window.start + i === selected ? t.info : t.textMuted}>{window.start + i === selected ? '▸ ' : '  '}</Text>
                <Text color={hover || window.start + i === selected ? t.textPrimary : t.textSecondary} bold={window.start + i === selected}>
                  {o.label}
                </Text>
              </Text>
            )}
          </InteractiveRow>
        ))}
        {options.length > shown.length ? (
          <Text color={t.textMuted} wrap="truncate-end">
            +{options.length - shown.length} more
          </Text>
        ) : null}
      </Box>
      <Box height={1} flexShrink={0} marginTop={1}>
        <Text color={t.textInstruction} wrap="truncate-end">
          ↑↓ choose · {legend}
        </Text>
      </Box>
    </FloatingPopup>
  )
}

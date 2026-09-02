import React, { useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

/** BOARD CONTROLS item 1 (`m` and `e` on a live row): the row pick modal —
 *  ONE declared-modal grammar for the session-arm MODEL picker (exactly
 *  the rows the strip's model chip cycles; haiku rides it wherever its
 *  family holds a credential — the never-Haiku law binds the autonomous
 *  crew arm only) and the shared-ladder EFFORT picker.
 *  ↑↓ choose · ↵ confirms · esc keeps; rows click. The switch itself is
 *  the daemon's verb (set-model / set-effort) — idle applies now, busy
 *  parks for the turn's end (the receipt says which).
 *
 *  TWO DOORWAYS, ONE UI (the coordinator effort dial ruling): the same
 *  component serves `e` on a session row (ConcourseScreen — the daemon
 *  verb road above) and `e` on the selected model in the coordinator-model
 *  picker (CoordinatorModelPicker — the persistent coordinator effort,
 *  written through switchCoordinatorEffort). No second picker exists. */
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
  atRef.current = at
  useInput((_input, key, event) => {
    event.stopImmediatePropagation()
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      setAt(v => Math.max(0, Math.min(options.length - 1, v + (key.downArrow ? 1 : -1))))
      return
    }
    if (key.return) {
      const o = options[Math.max(0, Math.min(options.length - 1, atRef.current))]
      if (o !== undefined) onPick(o.id, o.label)
      else onClose()
    }
  })
  const width = Math.min(64, Math.max(40, cols - 8))
  const shown = options.slice(0, Math.max(3, Math.min(10, rows - 10)))
  return (
    <Box
      position="absolute"
      top={Math.max(1, Math.floor(rows / 2) - Math.floor((shown.length + 6) / 2))}
      left={Math.max(0, Math.floor((cols - width) / 2))}
      width={Math.min(width, cols)}
      flexDirection="column"
      borderStyle="round"
      borderColor={t.info}
      paddingX={2}
      opaque={true}
    >
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
                <Text color={i === at ? t.info : t.textMuted}>{i === at ? '▸ ' : '  '}</Text>
                <Text color={hover || i === at ? t.textPrimary : t.textSecondary} bold={i === at}>
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
    </Box>
  )
}

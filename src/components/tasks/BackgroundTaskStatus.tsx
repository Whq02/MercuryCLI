import React from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { exitCrewmateView } from '../../state/crewmateViewHelpers.js'
import { getPillLabel } from '../../tasks/pillLabel.js'
import { calculateHorizontalScrollWindow } from '../../utils/horizontalScroll.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { Theme } from '../../utils/theme.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { GLYPH } from '../../utils/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { isManageableTask } from './taskStatusUtils.js'
import { notBuilt } from '../../pi/holes.js'

const MAIN_PILL_LABEL = 'main'
const EXPAND_CHORD = 'shift + ↓'
const ARROW_WIDTH = 2


function Pill({
  id,
  label,
  color,
  busy,
  idle,
  viewed,
  selected,
  onActivate,
}: {
  id: string
  label: string
  color: keyof Theme | undefined
  busy: boolean
  idle: boolean
  viewed: boolean
  selected: boolean
  onActivate?: () => void
}): React.ReactNode {
  const glyph = busy ? (
    <WorkingGlyph color={(color ?? 'suggestion') as string} active={true} />
  ) : (
    <Text dimColor>{GLYPH.inProgress}</Text>
  )
  const body = (highlighted: boolean): React.ReactNode => (
    <Text wrap="truncate-end">
      {glyph}
      <Text
        color={color}
        inverse={highlighted}
        bold={viewed}
        dimColor={!highlighted && (idle || color === undefined)}
      >
        {' '}
        {label}
      </Text>
    </Text>
  )
  if (!onActivate) return body(false)
  return (
    <InteractiveRow
      id={id}
      selected={selected}
      directActivate={true}
      onActivate={onActivate}
    >
      {(hover: boolean) => body(selected || hover)}
    </InteractiveRow>
  )
}

export function BackgroundTaskStatus(arg0: {
  tasksSelected: boolean
  isViewingCrewmate?: boolean
  crewmateFooterIndex?: number
  isLeaderIdle?: boolean
  onOpenDialog?: () => void
}): React.ReactNode {
  return notBuilt('src/components/tasks/BackgroundTaskStatus.tsx:74')
}

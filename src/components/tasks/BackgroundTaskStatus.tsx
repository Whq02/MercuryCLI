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

export function BackgroundTaskStatus({
  tasksSelected,
  isViewingCrewmate = false,
  crewmateFooterIndex,
  isLeaderIdle = false,
  onOpenDialog,
}: {
  tasksSelected: boolean
  isViewingCrewmate?: boolean
  crewmateFooterIndex?: number
  isLeaderIdle?: boolean
  onOpenDialog?: () => void
}): React.ReactNode {
  const tasks = useAppState((state: AppState) => state.tasks)
  const setAppState = useSetAppState()
  const { columns } = useTerminalSize()
  const tokens = useMercuryTokens()

  if (isViewingCrewmate) {
    const pills = [
      {
        id: 'footer:tasks:pill:main',
        label: MAIN_PILL_LABEL,
        color: undefined as keyof Theme | undefined,
        busy: !isLeaderIdle,
        idle: isLeaderIdle,
        onActivate: () => exitCrewmateView(setAppState),
      },
    ]
    const activeIndex = tasksSelected ? (crewmateFooterIndex ?? 0) : 0
    const itemWidths = pills.map(pill => 2 + stringWidth(pill.label))
    const availableWidth = Math.max(20, columns - 24)
    const win = calculateHorizontalScrollWindow(
      itemWidths,
      availableWidth,
      ARROW_WIDTH,
      activeIndex,
    )
    return (
      <Box>
        {win.showLeftArrow ? <Text dimColor>‹ </Text> : null}
        {pills.slice(win.startIndex, win.endIndex).map((pill, offset) => {
          const index = win.startIndex + offset
          return (
            <React.Fragment key={pill.id}>
              {offset > 0 ? <Text> </Text> : null}
              <Pill
                id={pill.id}
                label={pill.label}
                color={pill.color}
                busy={pill.busy}
                idle={pill.idle}
                viewed={index === 0}
                selected={tasksSelected && index === (crewmateFooterIndex ?? 0)}
                onActivate={pill.onActivate}
              />
            </React.Fragment>
          )
        })}
        {win.showRightArrow ? <Text dimColor> ›</Text> : null}
        <Text color={tokens.textMuted}>
          {' '}
          <KeyboardShortcutHint shortcut={EXPAND_CHORD} action="expand" />
        </Text>
      </Box>
    )
  }

  const manageable = Object.values(tasks ?? {}).filter(isManageableTask)
  if (manageable.length === 0) return null

  const label = getPillLabel(manageable)
  if (!onOpenDialog) {
    return <Text dimColor>{label}</Text>
  }

  return (
    <InteractiveRow
      id="footer:tasks:pill:summary"
      selected={tasksSelected}
      directActivate={true}
      onActivate={onOpenDialog}
    >
      {(hover: boolean) => (
        <Text inverse={tasksSelected || hover} dimColor={!tasksSelected && !hover}>
          {label}
        </Text>
      )}
    </InteractiveRow>
  )
}

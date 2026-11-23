import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../app-state/AppState.js'
import { exitCrewmateView } from '../../crew/crewmates/crewmateView.js'
import { getPillLabel } from '../../engine/tasks/pillLabel.js'
import { calculateHorizontalScrollWindow } from './horizontalScroll.js'
import { stringWidth } from '../renderer/stringWidth.js'
import type { Theme } from '../theme/theme.js'
import { KeyboardShortcutHint } from '../theme/KeyboardShortcutHint.js'
import { GLYPH } from '../theme/glyphs.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import { WorkingGlyph } from '../widgets/LiveGlyphs.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { isManageableTask } from './taskStatus.js'

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
        color: undefined,
        busy: !isLeaderIdle,
        idle: isLeaderIdle,
        onActivate: () => exitCrewmateView(setAppState),
      },
    ]
    const viewedIndex = 0
    const selectedIndex = tasksSelected ? (crewmateFooterIndex ?? 0) : 0
    const win = calculateHorizontalScrollWindow(
      pills.map(pill => stringWidth(pill.label) + 3),
      Math.max(20, columns - 24),
      ARROW_WIDTH,
      selectedIndex,
      true,
    )
    return (
      <Box flexDirection="row">
        {win.showLeftArrow ? <Text dimColor>‹ </Text> : null}
        {pills.slice(win.startIndex, win.endIndex).map((pill, offset) => {
          const index = win.startIndex + offset
          return (
            <Box key={pill.id} marginLeft={offset > 0 ? 1 : 0}>
              <Pill
                id={pill.id}
                label={pill.label}
                color={pill.color}
                busy={pill.busy}
                idle={pill.idle}
                viewed={index === viewedIndex}
                selected={tasksSelected && index === selectedIndex}
                onActivate={pill.onActivate}
              />
            </Box>
          )
        })}
        {win.showRightArrow ? <Text dimColor> ›</Text> : null}
        <Text color={tokens.textMuted}>
          {'  '}
          <KeyboardShortcutHint shortcut={EXPAND_CHORD} action="expand" />
        </Text>
      </Box>
    )
  }

  const manageable = Object.values(tasks ?? {}).filter(isManageableTask)
  if (manageable.length === 0) return null

  const label = getPillLabel(manageable)
  const body = (highlighted: boolean): React.ReactNode => (
    <Text wrap="truncate-end">
      <Text color="background" inverse={highlighted} dimColor={!highlighted}>
        {label}
      </Text>
    </Text>
  )
  if (!onOpenDialog) return body(false)

  return (
    <InteractiveRow
      id="footer:tasks:pill:summary"
      selected={tasksSelected}
      directActivate={true}
      onActivate={onOpenDialog}
    >
      {(hover: boolean) => body(tasksSelected || hover)}
    </InteractiveRow>
  )
}

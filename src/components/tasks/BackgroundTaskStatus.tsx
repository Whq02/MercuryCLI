
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
import { GLYPH } from '../mercury-ui/glyphs.js'
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
  const { columns } = useTerminalSize()
  const tokens = useMercuryTokens()
  const tasks = useAppState((state: AppState) => state.tasks)
  const treeShowing = useAppState(
    (state: AppState) => state.expandedView === 'crewmates',
  )
  const setAppState = useSetAppState()

  const manageable = Object.values(tasks).filter(isManageableTask)
  const agentPillMode = isViewingCrewmate && !treeShowing

  if (agentPillMode) {
    const viewedIndex = 0
    const selectedIndex = tasksSelected ? (crewmateFooterIndex ?? 0) : 0

    type PillModel = {
      id: string
      label: string
      color: keyof Theme | undefined
      busy: boolean
      idle: boolean
      onActivate: () => void
    }
    const pills: PillModel[] = [
      {
        id: 'footer:tasks:pill:main',
        label: MAIN_PILL_LABEL,
        color: undefined,
        busy: !isLeaderIdle,
        idle: isLeaderIdle,
        onActivate: () => exitCrewmateView(setAppState),
      },
    ]

    const widths = pills.map(pill => stringWidth(pill.label) + 2 + 1)
    const available = Math.max(20, columns - 24)
    const window = calculateHorizontalScrollWindow(
      widths,
      available,
      ARROW_WIDTH,
      selectedIndex,
      true,
    )

    return (
      <Box flexDirection="row">
        {window.showLeftArrow ? <Text dimColor>‹ </Text> : null}
        {pills.slice(window.startIndex, window.endIndex).map((pill, i) => {
          const index = window.startIndex + i
          return (
            <Box key={pill.id} marginLeft={index > window.startIndex ? 1 : 0}>
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
        {window.showRightArrow ? <Text dimColor> ›</Text> : null}
        <Text color={tokens.textMuted}>
          {'  '}
          <KeyboardShortcutHint shortcut={EXPAND_CHORD} action="expand" />
        </Text>
      </Box>
    )
  }

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

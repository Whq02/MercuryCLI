
import React from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import {
  enterCrewmateView,
  exitCrewmateView,
} from '../../state/crewmateViewHelpers.js'
import { isInProcessCrewmateTask, type InProcessCrewmateTaskState } from '../../tasks/InProcessCrewmateTask/types.js'
import { getPillLabel, pillNeedsCta } from '../../tasks/pillLabel.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/AgentTool/agentColorManager.js'
import { calculateHorizontalScrollWindow } from '../../utils/horizontalScroll.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { Theme } from '../../utils/theme.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { isManageableTask, shouldHideTasksFooter } from './taskStatusUtils.js'

const MAIN_PILL_LABEL = 'main'
const EXPAND_CHORD = 'shift + ↓'
const ARROW_WIDTH = 2

function themeColorOf(
  crewmate: InProcessCrewmateTaskState,
): keyof Theme | undefined {
  const raw = crewmate.identity.color
  if (raw === undefined) return undefined
  return (AGENT_COLOR_TO_THEME_COLOR as Record<string, keyof Theme>)[raw]
}

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
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  const setAppState = useSetAppState()

  const manageable = Object.values(tasks).filter(isManageableTask)
  const allCrewmates =
    manageable.length > 0 && manageable.every(isInProcessCrewmateTask)
  const agentPillMode =
    (allCrewmates && !treeShowing) || (isViewingCrewmate && !treeShowing)

  if (agentPillMode) {
    const crewmates = Object.values(tasks)
      .filter(isInProcessCrewmateTask)
      .filter(isManageableTask)
      .sort((a, b) =>
        (a.identity.agentName ?? '').localeCompare(b.identity.agentName ?? ''),
      )
    const displayed = tasksSelected
      ? crewmates
      : [...crewmates].sort(
          (a, b) => Number(a.isIdle === true) - Number(b.isIdle === true),
        )
    const viewedIndex =
      viewingAgentTaskId !== undefined
        ? displayed.findIndex(t => t.id === viewingAgentTaskId) + 1
        : 0
    const selectedIndex = tasksSelected
      ? (crewmateFooterIndex ?? 0)
      : Math.max(0, viewedIndex)

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
      ...displayed.map(crewmate => ({
        id: `footer:tasks:pill:${crewmate.id}`,
        label: `@${crewmate.identity.agentName}`,
        color: themeColorOf(crewmate),
        busy: crewmate.status === 'running' && crewmate.isIdle !== true,
        idle: crewmate.isIdle === true,
        onActivate: () => enterCrewmateView(crewmate.id, setAppState),
      })),
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

  if (shouldHideTasksFooter(Object.values(tasks), treeShowing)) return null
  if (manageable.length === 0) return null

  const label = getPillLabel(manageable)
  const callToAction = pillNeedsCta(manageable)
  const body = (highlighted: boolean): React.ReactNode => (
    <Text wrap="truncate-end">
      <Text color="background" inverse={highlighted} dimColor={!highlighted}>
        {label}
      </Text>
      {callToAction ? <Text dimColor> ↓ to view</Text> : null}
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

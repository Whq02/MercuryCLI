// The footer tasks pill: agent pills with horizontal scrolling when
// the manageable set is all teammates (or a teammate is viewed outside the
// tree), otherwise one summary pill. Pills are single-purpose controls —
// the shared interactive-row primitive in direct-activate mode — and every
// pill leads with an honest state glyph.

import React from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../../state/teammateViewHelpers.js'
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
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

/** Contract data: the leading pill's label. */
const MAIN_PILL_LABEL = 'main'
/** Contract data: the displayed expand chord. */
const EXPAND_CHORD = 'shift + ↓'
/** Overflow-arrow budget: glyph plus its spacing cell. */
const ARROW_WIDTH = 2

function themeColorOf(
  teammate: InProcessTeammateTaskState,
): keyof Theme | undefined {
  const raw = teammate.identity.color
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
  isViewingTeammate = false,
  teammateFooterIndex,
  isLeaderIdle = false,
  onOpenDialog,
}: {
  tasksSelected: boolean
  isViewingTeammate?: boolean
  teammateFooterIndex?: number
  isLeaderIdle?: boolean
  onOpenDialog?: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const tokens = useMercuryTokens()
  const tasks = useAppState((state: AppState) => state.tasks)
  const treeShowing = useAppState(
    (state: AppState) => state.expandedView === 'teammates',
  )
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  const setAppState = useSetAppState()

  const manageable = Object.values(tasks).filter(isManageableTask)
  const allTeammates =
    manageable.length > 0 && manageable.every(isInProcessTeammateTask)
  const agentPillMode =
    (allTeammates && !treeShowing) || (isViewingTeammate && !treeShowing)

  if (agentPillMode) {
    const teammates = Object.values(tasks)
      .filter(isInProcessTeammateTask)
      .filter(isManageableTask)
      .sort((a, b) =>
        (a.identity.agentName ?? '').localeCompare(b.identity.agentName ?? ''),
      )
    // Unselected rows read busy-first; the selected row keeps a stable order.
    const displayed = tasksSelected
      ? teammates
      : [...teammates].sort(
          (a, b) => Number(a.isIdle === true) - Number(b.isIdle === true),
        )
    const viewedIndex =
      viewingAgentTaskId !== undefined
        ? displayed.findIndex(t => t.id === viewingAgentTaskId) + 1
        : 0
    const selectedIndex = tasksSelected
      ? (teammateFooterIndex ?? 0)
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
        onActivate: () => exitTeammateView(setAppState),
      },
      ...displayed.map(teammate => ({
        id: `footer:tasks:pill:${teammate.id}`,
        label: `@${teammate.identity.agentName}`,
        color: themeColorOf(teammate),
        busy: teammate.status === 'running' && teammate.isIdle !== true,
        idle: teammate.isIdle === true,
        onActivate: () => enterTeammateView(teammate.id, setAppState),
      })),
    ]

    // Measured width: label + the 2-cell state glyph + one separator for all
    // but the first (the helper discounts the first's phantom separator).
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

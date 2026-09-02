// The footer's left cluster: exit-pending and paste-in-progress
// outrank everything; then the reverse-search field, the vim INSERT marker,
// and the indicator group — whose stable-height law matters in fullscreen:
// exactly one row, a single blank when there is nothing to say, boxes
// (mode badge slot · tasks pill · idle hint) never nested inside the
// truncating text wrapper.

import React, { useContext, useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import { RECORDING_FOOTER, subscribeVoice, TRANSCRIBING_FOOTER, voiceSnapshot } from '../../services/voice/voiceSession.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { usePrStatus } from '../../hooks/usePrStatus.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { isDefaultMode } from '../../utils/permissions/PermissionMode.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { getGlobalConfig, isCopyOnSelectEnabled } from '../../utils/config.js'
import { isFullscreenActive } from '../../utils/fullscreen.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { useSelection } from '../../ink.js'
import { useHasSelection } from '../../ink/hooks/use-selection.js'
import { env } from '../../utils/env.js'
import { getPlatform } from '../../utils/platform.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { PrBadge } from '../PrBadge.js'
import { TeamStatus } from '../teams/TeamStatus.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import { isManageableTask, shouldHideTasksFooter } from '../tasks/taskStatusUtils.js'
import { BASH_MODE_CHARACTER } from './inputModes.js'
import { ExitChordNotice } from './ExitChordNotice.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'

/** xterm.js hosts (VS Code-family embedded terminals). */
const XTERMJS_HOSTS = new Set(['vscode', 'cursor', 'windsurf', 'codium', 'antigravity'])

export function PromptInputFooterLeftSide({
  exitPending,
  exitKeyName,
  isPasting,
  searchField,
  vimInsert = false,
  mode,
  isLoading,
  hintsEnabled = true,
  teammateFooterIndex,
  onOpenTasksDialog,
}: {
  exitPending: boolean
  exitKeyName: string | null
  isPasting: boolean
  /** The reverse-search field, rendered by the composer while searching. */
  searchField?: React.ReactNode
  vimInsert?: boolean
  mode: PromptInputMode
  isLoading: boolean
  hintsEnabled?: boolean
  /** The composer's selected teammate pill (0 = the leader pill). */
  teammateFooterIndex?: number
  onOpenTasksDialog?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const setAppState = useSetAppState()
  const tasks = useAppState((state: AppState) => state.tasks)
  const footerSelection = useAppState((state: AppState) => state.footerSelection)
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  const treeShowing = useAppState(
    (state: AppState) => state.expandedView === 'teammates',
  )
  // The cockpit truth is the CONTEXT FullscreenLayout provides on its
  // rails-showing branch — app state carries no such member.
  const cockpitActive = useContext(CockpitActiveContext)
  const teamContext = useAppState((state: AppState) => state.teamContext)
  const permissionMode = useAppState(
    (state: AppState) => state.toolPermissionContext.mode,
  )
  const hasSelection = useHasSelection()
  const selection = useSelection()
  // The truthful interrupt hint: Esc is the
  // interrupt the resting hint names — chat:cancel's chord, not the ctrl+c
  // spelling app:interrupt would resolve to (ctrl+c's first press also arms
  // the exit chord; its notice appears only while armed, below).
  const cancelChord = useShortcutDisplay('chat:cancel', 'Chat', 'esc')
  const killChord = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x k')
  const todosChord = useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t')
  const copyChord = useShortcutDisplay('selection:copy', 'Scroll', 'ctrl+shift+c')
  const paletteChord = useShortcutDisplay('app:commandPalette', 'Global', 'ctrl+k')
  const killConfirmShowing = useAppState(
    (state: AppState) => state.notifications.current?.key === 'kill-agents-confirm',
  )
  // Every hook precedes the early returns (the exit-pending/pasting flips
  // must never change the hook count mid-turn).
  const prStatus = usePrStatus(
    isLoading,
    getGlobalConfig().prStatusFooterEnabled !== false,
  )
  // Voice input: a capture in flight owns the whole left cluster (below).
  const voice = useSyncExternalStore(subscribeVoice, voiceSnapshot, voiceSnapshot)

  // 1 · exit-pending outranks everything. The ruled notice copy: shown only
  // while the exit chord is armed; it clears when the 3 s window lapses.
  // ONE component owns the words (ExitChordNotice) — the route surfaces
  // paint the same one at their bottom-left (L22).
  if (exitPending) {
    return <ExitChordNotice keyName={exitKeyName} />
  }
  // 2 · paste in progress.
  if (isPasting) {
    return <Text dimColor>pasting text…</Text>
  }
  // 2b · a voice capture in flight: the one line, then the transcribing
  // wait — the hint set stands aside until the words land.
  if (voice.phase === 'recording') {
    return (
      <Box height={isFullscreenActive() ? 1 : undefined} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={tokens.failure}>●</Text>
          <Text dimColor> {RECORDING_FOOTER}</Text>
        </Text>
      </Box>
    )
  }
  if (voice.phase === 'transcribing') {
    return (
      <Box height={isFullscreenActive() ? 1 : undefined} overflow="hidden">
        <Text dimColor wrap="truncate-end">{TRANSCRIBING_FOOTER}</Text>
      </Box>
    )
  }

  const taskList = Object.values(tasks)
  const manageable = taskList.filter(isManageableTask)
  const viewingTeammate = viewingAgentTaskId !== undefined
  const viewedTask =
    viewingAgentTaskId !== undefined ? tasks[viewingAgentTaskId] : undefined
  const viewedTeammateCompleted =
    viewedTask !== undefined &&
    (isInProcessTeammateTask(viewedTask) || isLocalAgentTask(viewedTask)) &&
    viewedTask.status !== 'running' &&
    viewedTask.status !== 'pending'

  // Primary-item census: mode + tasks + teams. The mode badge itself
  // is hoisted to the statusbar in Mercury; only the PR gate reads the count.
  const nonDefaultMode = !isDefaultMode(permissionMode) ? 1 : 0
  const tasksPresent = manageable.length > 0 || viewingTeammate
  const inProcessMode = getTeammateModeFromSnapshot() === 'in-process'
  const teamsPresent =
    isAgentSwarmsEnabled() &&
    !inProcessMode &&
    teamContext !== undefined &&
    Object.values(teamContext.teammates).some(
      member => member.name !== TEAM_LEAD_NAME,
    )
  const primaryItems = nonDefaultMode + (tasksPresent ? 1 : 0) + (teamsPresent ? 1 : 0)

  const showPrBadge =
    primaryItems < 2 &&
    (primaryItems === 0 || columns >= 80) &&
    prStatus.number !== null &&
    prStatus.reviewState !== null &&
    prStatus.url !== null &&
    getGlobalConfig().prStatusFooterEnabled !== false

  // The tasks pill (its own box, never inside the truncating text node).
  const pillHidden = shouldHideTasksFooter(taskList, treeShowing)
  const showTasksPill = tasksPresent && !pillHidden

  // Teammate pills occupy their own row above the remaining parts.
  const inProcessTeammates = taskList.filter(isInProcessTeammateTask)
  const teammatePillsPresent =
    (inProcessTeammates.some(isManageableTask) && !treeShowing) ||
    (viewingTeammate && !treeShowing)

  // ── the hint set ─────────────────────────────────────────────────────────
  const parts: React.ReactNode[] = []
  if (mode === 'bash') {
    // In bash mode the whole group collapses to this single line — except an
    // active reverse search, whose field must paint here exactly as in
    // prompt mode: the collapse would otherwise swallow it, so ctrl+r captured the
    // keyboard with no visible field anywhere.
    return (
      <Box height={isFullscreenActive() ? 1 : undefined} overflow="hidden">
        {searchField ?? (
          <Text dimColor wrap="truncate-end">
            {BASH_MODE_CHARACTER} for shell mode
          </Text>
        )}
      </Box>
    )
  }

  const runningAgents = taskList.filter(
    task => isLocalAgentTask(task) && task.status === 'running',
  )
  if (viewingTeammate && viewedTeammateCompleted) {
    // Escape-returns-to-leader REPLACES the interrupt hint; no spinner hints.
    parts.push(
      <KeyboardShortcutHint key="return" shortcut="esc" action="return to leader" />,
    )
  } else {
    if (isLoading) {
      parts.push(
        <KeyboardShortcutHint key="interrupt" shortcut={cancelChord} action="interrupt" />,
      )
    } else if (runningAgents.length > 0 && !killConfirmShowing) {
      parts.push(
        <KeyboardShortcutHint key="stop-agents" shortcut={killChord} action="stop agents" />,
      )
    }
    // The toggle hint, only when the key can reach something.
    const runningTeammates = inProcessTeammates.filter(
      task => task.status === 'running',
    )
    const reachable = cockpitActive
      ? runningTeammates.length > 0
      : inProcessTeammates.length > 0
    if (reachable) {
      const action = cockpitActive
        ? treeShowing
          ? 'hide'
          : 'show teammates'
        : runningTeammates.length > 0
          ? 'cycle tasks'
          : treeShowing
            ? 'hide tasks'
            : 'show tasks'
      parts.push(
        <KeyboardShortcutHint key="toggle" shortcut={todosChord} action={action} />,
      )
    }
  }
  // Selection hints (fullscreen only, and only with something to say).
  if (isFullscreenActive() && hasSelection) {
    if (!isCopyOnSelectEnabled()) {
      parts.push(
        <KeyboardShortcutHint key="copy" shortcut={copyChord} action="copy" />,
      )
    }
    const xtermHost = XTERMJS_HOSTS.has(env.terminal ?? '')
    if (xtermHost) {
      const pressHadAlt = selection.getState()?.lastPressHadAlt === true
      const macos = getPlatform() === 'macos'
      parts.push(
        <Text key="native-selection" dimColor>
          {macos
            ? pressHadAlt
              ? 'enable macOptionClickForcesSelection for native selection'
              : 'option+click for native selection'
            : 'shift+click for native selection'}
        </Text>,
      )
    }
  }
  // A tasks pill present, hints enabled and no teams → the manage hint.
  if (showTasksPill && hintsEnabled && !teamsPresent) {
    parts.push(
      footerSelection === 'tasks' ? (
        <KeyboardShortcutHint key="manage" shortcut="Enter" action="view" />
      ) : (
        <KeyboardShortcutHint key="manage" shortcut="↓" action="manage" />
      ),
    )
  }

  const idleHintShows =
    parts.length === 0 && !showTasksPill && hintsEnabled && !showPrBadge
  const cluster = (
    <Box
      flexDirection="row"
      height={isFullscreenActive() ? 1 : undefined}
      overflow="hidden"
    >
      {searchField ?? null}
      {vimInsert && searchField === undefined ? (
        <Box flexShrink={0} marginRight={1}>
          <Text bold color={tokens.warning}>
            INSERT
          </Text>
        </Box>
      ) : null}
      {showTasksPill ? (
        <Box flexShrink={0} marginRight={1}>
          <BackgroundTaskStatus
            tasksSelected={footerSelection === 'tasks'}
            isViewingTeammate={viewingTeammate}
            teammateFooterIndex={teammateFooterIndex}
            isLeaderIdle={!isLoading}
            onOpenDialog={onOpenTasksDialog}
          />
        </Box>
      ) : null}
      {teamsPresent ? (
        <Box flexShrink={0} marginRight={1}>
          <TeamStatus teamsSelected={footerSelection === 'teams'} showHint={hintsEnabled} />
        </Box>
      ) : null}
      {showPrBadge ? (
        <Box flexShrink={0} marginRight={1}>
          <PrBadge
            number={prStatus.number as number}
            url={prStatus.url ?? undefined}
            reviewState={prStatus.reviewState ?? undefined}
          />
        </Box>
      ) : null}
      {/* The remaining parts share ONE truncating text node — the parts
          string sheds first. Vim INSERT suppresses the hint set. */}
      {!vimInsert && parts.length > 0 ? (
        <Text dimColor wrap="truncate-end">
          {parts.map((part, index) => (
            <React.Fragment key={index}>
              {index > 0 ? <Text color={tokens.textMuted}> · </Text> : null}
              {part}
            </React.Fragment>
          ))}
        </Text>
      ) : null}
      {idleHintShows && !vimInsert ? (
        <Box
          flexShrink={0}
          onClick={() => {
            // The idle hint is a click target dispatching /help — through
            // the one command-dispatch channel every sibling click rides.
            requestCommandDispatch('/help')
          }}
        >
          <Text dimColor wrap="truncate-end">
            {columns >= 50 ? (
              <>
                ? for shortcuts <Text color={tokens.textMuted}>· </Text>
                {paletteChord} for commands + files
              </>
            ) : (
              '? for shortcuts'
            )}
          </Text>
        </Box>
      ) : null}
      {parts.length === 0 && !idleHintShows && !showTasksPill && !teamsPresent && !showPrBadge && !vimInsert && searchField === undefined ? (
        <Text> </Text>
      ) : null}
    </Box>
  )

  if (teammatePillsPresent && !showTasksPill) {
    // Teammate pills get their own row above the remaining parts.
    return (
      <Box flexDirection="column">
        <BackgroundTaskStatus
          tasksSelected={footerSelection === 'tasks'}
          isViewingTeammate={viewingTeammate}
          teammateFooterIndex={teammateFooterIndex}
          isLeaderIdle={!isLoading}
          onOpenDialog={onOpenTasksDialog}
        />
        {cluster}
      </Box>
    )
  }
  return cluster
}

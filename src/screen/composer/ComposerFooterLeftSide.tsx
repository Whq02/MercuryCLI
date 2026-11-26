import React, { useContext, useSyncExternalStore } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { RECORDING_FOOTER, subscribeVoice, TRANSCRIBING_FOOTER, voiceSnapshot } from '../../integrations/voice/voiceSession.js'
import { desktopSnapshot, drivingFooter, subscribeDesktop } from '../../integrations/desktop/desktopSession.js'
import { armDesktopClaimPoll, desktopClaimFileSnapshot, subscribeDesktopClaimFile } from '../../integrations/desktop/desktopClaim.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useClaim } from '../effects/effects.js'
import { useAppState, type AppState } from '../app-state/AppState.js'
import { usePrStatus } from './usePrStatus.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { isDefaultMode } from '../../permissions/rules/permissionMode.js'
import { getGlobalConfig, isCopyOnSelectEnabled } from '../../platform/settings/config.js'
import { isFullscreenActive } from '../fullscreen-layout/fullscreen.js'
import { isCrewmateTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import { useSelection } from '../themedRenderer.js'
import { useHasSelection } from '../renderer/bindings/use-selection.js'
import {
  ownInputSelectionVersion,
  peekOwnInputSelection,
  subscribeOwnInputSelection,
} from '../cockpit/inputSelectionBridge.js'
import { env } from '../../platform/environment/env.js'
import { getPlatform } from '../../platform/environment/platform.js'
import { KeyboardShortcutHint } from '../theme/KeyboardShortcutHint.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { CompactFooterNoticeContext } from '../fullscreen-layout/layoutChromeContext.js'
import { useEscapeOwned } from '../keys/useEscapeOwned.js'
import { useFocusedShellRunning } from '../../engine/connector/shellRunning.js'
import { keyHintLabel } from '../widgets/keyHintLabel.js'
import { settingsChangeDetector } from '../../platform/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../../platform/settings/snapshot.js'
import { isManageableTask } from '../tasks/taskStatus.js'
import { BASH_MODE_CHARACTER } from './inputModes.js'
import { ExitChordNotice } from './ExitChordNotice.js'
import { noticeBlockRows, noticeRowBlock, noticeRowDetail, noticeRowText, noticeRowWayOut } from './Notifications.js'
import { standsUntilRemoved } from '../notifications/notifications.js'
import type { InputMode } from './input-core/textInput.js'
import {
  extendedKeysSupportedNow,
  subscribeExtendedKeysSupport,
} from '../renderer/terminal-session/capabilities.js'
import { getNewlineInstructions } from './composerConfig.js'
import { crewmateComposerHint } from '../cockpit/crewmateWords.js'
import { targetWords, useComposerCrewmate, useViewedCrewmate, viewedWords } from '../tasks/useCrewmateView.js'
import { footerClusterOf } from './footerLeftSideView.js'
const XTERMJS_HOSTS = new Set(['vscode', 'cursor', 'windsurf', 'codium', 'antigravity'])

export function ComposerFooterLeftSide({
  exitPending,
  exitKeyName,
  isPasting,
  searchField,
  vimInsert = false,
  mode,
  isLoading,
  hintsEnabled = true,
  crewmateFooterIndex,
  onOpenTasksDialog,
  compact = false,
}: {
  exitPending: boolean
  exitKeyName: string | null
  isPasting: boolean
  searchField?: React.ReactNode
  vimInsert?: boolean
  mode: InputMode
  isLoading: boolean
  hintsEnabled?: boolean
  crewmateFooterIndex?: number
  onOpenTasksDialog?: () => void
  compact?: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const tasks = useAppState((s: AppState) => s.tasks)
  const footerSelection = useAppState((s: AppState) => s.footerSelection)
  const toolPermissionContext = useAppState((s: AppState) => s.toolPermissionContext)
  const viewingCrewmateTaskId = useAppState((s: AppState) => s.viewingCrewmateTaskId)
  const currentNotice = useAppState((s: AppState) => s.notifications.current)
  const selection = useSelection()
  const hasPaintedSelection = useHasSelection()
  useSyncExternalStore(
    subscribeOwnInputSelection,
    ownInputSelectionVersion,
    ownInputSelectionVersion,
  )
  const hasOwnSelection = peekOwnInputSelection() !== null
  const hasSelection = hasPaintedSelection || hasOwnSelection
  const shellRunning = useFocusedShellRunning()
  useSyncExternalStore(settingsChangeDetector.subscribe, settingsRevision, settingsRevision)
  const voice = useSyncExternalStore(subscribeVoice, voiceSnapshot, voiceSnapshot)
  const desktopInProcess = useSyncExternalStore(subscribeDesktop, desktopSnapshot, desktopSnapshot)
  const desktopFile = useSyncExternalStore(
    subscribeDesktopClaimFile,
    desktopClaimFileSnapshot,
    desktopClaimFileSnapshot,
  )
  const desktop = desktopInProcess.phase === 'driving' ? desktopInProcess : desktopFile
  useClaim(() => {
    armDesktopClaimPoll(isLoading)
    return () => armDesktopClaimPoll(false)
  }, [isLoading])

  const prConfigEnabled = getGlobalConfig().prStatusFooterEnabled !== false
  const prStatus = usePrStatus(isLoading, !compact && prConfigEnabled)

  const cancelChord = useShortcutDisplay('chat:cancel', 'Chat', 'esc')
  const killChord = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x k')
  const copyChord = useShortcutDisplay('selection:copy', 'Scroll', 'ctrl+shift+c')
  const paletteChord = useShortcutDisplay('app:commandPalette', 'Global', 'ctrl+k')
  useSyncExternalStore(
    subscribeExtendedKeysSupport,
    extendedKeysSupportedNow,
    extendedKeysSupportedNow,
  )
  const escapeOwned = useEscapeOwned()
  const composerCrewmate = useComposerCrewmate()
  const viewedCrewmate = useViewedCrewmate()
  const crewmateHint =
    composerCrewmate !== null
      ? crewmateComposerHint(targetWords(composerCrewmate), viewedWords(viewedCrewmate), escapeOwned)
      : null
  const killConfirmPending = currentNotice?.key === 'kill-agents-confirm'
  const noticeText = noticeRowText(currentNotice)
  const noticeDetail = noticeText !== null ? noticeRowDetail(currentNotice) : null
  const noticeWayOut = noticeText !== null ? noticeRowWayOut(currentNotice) : null
  const noticeBlock = noticeRowBlock(currentNotice)
  const blockRows = noticeBlockRows(currentNotice)

  const setCompactFooterRows = useContext(CompactFooterNoticeContext)
  const drivingActive = isLoading && desktop.phase === 'driving'
  const compactNoticeRows =
    exitPending ||
    isPasting ||
    voice.phase === 'recording' ||
    voice.phase === 'transcribing' ||
    drivingActive ||
    (compact && searchField !== undefined)
      ? 1
      : compact
        ? blockRows
        : 0

  useClaim(() => {
    if (setCompactFooterRows === null) return undefined
    setCompactFooterRows(compactNoticeRows)
    return () => setCompactFooterRows(0)
  }, [setCompactFooterRows, compactNoticeRows])

  if (exitPending) {
    return <ExitChordNotice keyName={exitKeyName} />
  }

  if (isPasting) {
    return <Text dimColor>pasting text…</Text>
  }

  const fullscreen = isFullscreenActive()
  const secondLine = !compact ? (
    <Text dimColor wrap="truncate-end">
      {getNewlineInstructions()}
      {crewmateHint !== null ? ` · ${crewmateHint}` : ''}
    </Text>
  ) : null

  if (voice.phase === 'recording') {
    return (
      <>
        <Box height={fullscreen ? 1 : undefined} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={tokens.failure}>●</Text> {RECORDING_FOOTER}
          </Text>
        </Box>
        {secondLine}
      </>
    )
  }

  if (voice.phase === 'transcribing') {
    return (
      <>
        <Box height={fullscreen ? 1 : undefined} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {TRANSCRIBING_FOOTER}
          </Text>
        </Box>
        {secondLine}
      </>
    )
  }

  if (drivingActive) {
    return (
      <>
        <Box height={fullscreen ? 1 : undefined} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={tokens.warning}>●</Text> {drivingFooter(desktop.app)}
          </Text>
        </Box>
        {secondLine}
      </>
    )
  }
  if (compact) {
    if (searchField !== undefined) {
      return (
        <Box height={1} overflow="hidden">
          {searchField}
        </Box>
      )
    }
    if (noticeBlock !== null) {
      return (
        <Box height={blockRows} overflow="hidden">
          {noticeBlock}
        </Box>
      )
    }
    return null
  }

  if (mode === 'bash') {
    return (
      <>
        <Box height={fullscreen ? 1 : undefined} overflow="hidden">
          {searchField ?? <Text dimColor>{BASH_MODE_CHARACTER} for shell mode</Text>}
        </Box>
        {secondLine}
      </>
    )
  }

  const parts: React.ReactNode[] = []
  const viewingCrewmate = viewingCrewmateTaskId !== undefined
  if (!viewingCrewmate && isLoading) {
    if (!escapeOwned) {
      parts.push(<KeyboardShortcutHint shortcut={cancelChord} action="interrupt" />)
    }
    if (shellRunning && getSettingsSnapshot().settings.view?.backgroundKey !== false) {
      parts.push(
        <KeyboardShortcutHint
          shortcut={keyHintLabel('⇧b')}
          action="background the command"
        />,
      )
    }
  } else if (!viewingCrewmate) {
    const hasRunningLocalCrewmates = Object.values(tasks).some(
      task => isCrewmateTask(task) && task.status === 'running',
    )
    if (hasRunningLocalCrewmates && !killConfirmPending) {
      parts.push(<KeyboardShortcutHint shortcut={killChord} action="stop crewmates" />)
    }
  }

  if (fullscreen && hasSelection) {
    if (!isCopyOnSelectEnabled()) {
      parts.push(<KeyboardShortcutHint shortcut={copyChord} action="copy" />)
    }
    if (env.terminal !== null && XTERMJS_HOSTS.has(env.terminal)) {
      const nativeHint =
        getPlatform() === 'macos'
          ? selection.getState()?.lastPressHadAlt === true
            ? 'enable macOptionClickForcesSelection for native selection'
            : 'option+click for native selection'
          : 'shift+click for native selection'
      parts.push(<Text dimColor>{nativeHint}</Text>)
    }
  }

  const showTasksPill = Object.values(tasks).some(isManageableTask) || viewingCrewmate
  const primaryBits =
    (!isDefaultMode(toolPermissionContext.mode) ? 1 : 0) + (showTasksPill ? 1 : 0)
  const showPrBadge =
    prConfigEnabled &&
    prStatus.number !== null &&
    prStatus.reviewState !== null &&
    prStatus.url !== null &&
    primaryBits < 2 &&
    (primaryBits === 0 || columns >= 80)

  const noticeYields =
    currentNotice !== null && standsUntilRemoved(currentNotice) && parts.length > 0
  const noticeStands = !noticeYields && (noticeText !== null || noticeBlock !== null)
  const hintsShow = !vimInsert && !noticeStands && parts.length > 0
  const idleHintShows =
    parts.length === 0 &&
    !showTasksPill &&
    hintsEnabled &&
    !showPrBadge &&
    !noticeStands
  const rowHasContent =
    searchField !== undefined || vimInsert || showTasksPill || showPrBadge

  const idleLegendOnly =
    idleHintShows &&
    !vimInsert &&
    searchField === undefined &&
    crewmateHint === null

  return (
    <>
      {footerClusterOf({
        tokens,
        columns,
        footerSelection,
        paletteChord,
        noticeText,
        noticeDetail,
        noticeWayOut,
        noticeBlock,
        blockRows,
        prStatus,
        viewingCrewmate,
        showPrBadge,
        showTasksPill,
        parts,
        noticeStands,
        hintsShow,
        idleHintShows,
        rowHasContent,
        searchField,
        vimInsert,
        isLoading,
        crewmateFooterIndex,
        onOpenTasksDialog,
      })}
      {idleLegendOnly ? null : secondLine}
    </>
  )
}

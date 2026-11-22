import React, { useContext, useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import { RECORDING_FOOTER, subscribeVoice, TRANSCRIBING_FOOTER, voiceSnapshot } from '../../services/voice/voiceSession.js'
import { desktopSnapshot, drivingFooter, subscribeDesktop } from '../../services/desktop/desktopSession.js'
import { armDesktopClaimPoll, desktopClaimFileSnapshot, subscribeDesktopClaimFile } from '../../services/desktop/desktopClaim.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useClaim } from '../../hooks/effects.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import { usePrStatus } from '../../hooks/usePrStatus.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { isDefaultMode } from '../../utils/permissions/PermissionMode.js'
import { getGlobalConfig, isCopyOnSelectEnabled } from '../../utils/config.js'
import { isFullscreenActive } from '../../utils/fullscreen.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { useSelection } from '../../ink.js'
import { useHasSelection } from '../../ink/hooks/use-selection.js'
import {
  ownInputSelectionVersion,
  peekOwnInputSelection,
  subscribeOwnInputSelection,
} from '../../utils/cockpit/inputSelectionBridge.js'
import { env } from '../../utils/env.js'
import { getPlatform } from '../../utils/platform.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js'
import { CompactFooterNoticeContext } from '../../context/layoutChromeContext.js'
import { useEscapeOwned } from '../../hooks/useEscapeOwned.js'
import { useFocusedShellRunning } from '../../services/engine-connector/shellRunning.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../../utils/settings/snapshot.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { BASH_MODE_CHARACTER } from './inputModes.js'
import { ExitChordNotice } from './ExitChordNotice.js'
import { noticeBlockRows, noticeRowBlock, noticeRowDetail, noticeRowText, noticeRowWayOut } from './Notifications.js'
import { standsUntilRemoved } from '../../context/notifications.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { LEAD_ROW_NAME } from '../../utils/cockpit/crewmateWords.js'
import { crewmateLive, useViewedCrewmate } from '../tasks/useCrewmateView.js'
import { footerClusterOf } from './footerLeftSideView.js'
import { notBuilt } from '../../pi/holes.js'

const XTERMJS_HOSTS = new Set(['vscode', 'cursor', 'windsurf', 'codium', 'antigravity'])

export function PromptInputFooterLeftSide(arg0: {
  exitPending: boolean
  exitKeyName: string | null
  isPasting: boolean
  searchField?: React.ReactNode
  vimInsert?: boolean
  mode: PromptInputMode
  isLoading: boolean
  hintsEnabled?: boolean
  crewmateFooterIndex?: number
  onOpenTasksDialog?: () => void
  compact?: boolean
}): React.ReactNode {
  return notBuilt('src/components/PromptInput/PromptInputFooterLeftSide.tsx:46')
}

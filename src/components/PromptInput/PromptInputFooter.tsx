import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import {
  extendedKeysSupportedNow,
  subscribeExtendedKeysSupport,
} from '../../ink/session/capabilities.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import type { Message } from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import { useSetPromptOverlay } from '../../context/promptOverlayContext.js'
import {
  presentStripStops,
  stripKeyMapHintOf,
  subscribeSurfaceRoute,
} from '../../context/surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { MercuryMissionIndicator } from '../MercuryMissionIndicator.js'
import { Notifications } from './Notifications.js'
import { PromptInputFooterLeftSide } from './PromptInputFooterLeftSide.js'
import { PromptInputHelpMenu } from './PromptInputHelpMenu.js'
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
  type SuggestionType,
} from './PromptInputFooterSuggestions.js'
import { getNewlineInstructions } from './utils.js'
import { crewmateComposerHint } from '../../utils/cockpit/crewmateWords.js'
import { targetWords, useComposerCrewmate, useViewedCrewmate, viewedWords } from '../tasks/useCrewmateView.js'
import { notBuilt } from '../../pi/holes.js'

export function footerStripHint(hint: string): string {
  return hint.replace(/^(?:⇧|shift\+)←/, 'shift + ←')
}

const NARROW_COLUMNS = 80

export function PromptInputFooter(arg0: {
  suggestions: SuggestionItem[]
  suggestionType: SuggestionType
  onSuggestionPick?: (index: number) => void
  onSuggestionHover?: (index: number) => void
  helpOpen?: boolean
  input: string
  mode: PromptInputMode
  isLoading: boolean
  exitPending: boolean
  exitKeyName: string | null
  isPasting: boolean
  searchField?: React.ReactNode
  isSearching?: boolean
  vimInsert?: boolean
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  messages: Message[]
  mcpClients?: MCPServerConnection[]
  hintsEnabled?: boolean
  crewmateFooterIndex?: number
  onOpenTasksDialog?: () => void
  compact?: boolean
  maxRows?: number
  suggestionRows?: number
}): React.ReactNode {
  return notBuilt('src/components/PromptInput/PromptInputFooter.tsx:39')
}

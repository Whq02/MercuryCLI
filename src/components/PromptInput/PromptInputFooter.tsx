
import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import {
  extendedKeysSupportedNow,
  subscribeExtendedKeysSupport,
} from '../../ink/session/capabilities.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
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

export function footerStripHint(hint: string): string {
  return hint.replace(/^(?:⇧|shift\+)←/, 'shift + ←')
}

const NARROW_COLUMNS = 80

export function PromptInputFooter({
  suggestions,
  selectedSuggestion,
  suggestionType,
  onSuggestionPick,
  onSuggestionHover,
  helpOpen = false,
  input,
  mode,
  isLoading,
  exitPending,
  exitKeyName,
  isPasting,
  searchField,
  isSearching = false,
  vimInsert = false,
  apiKeyStatus,
  debug,
  verbose,
  messages,
  mcpClients,
  hintsEnabled = true,
  crewmateFooterIndex,
  onOpenTasksDialog,
  compact = false,
  maxRows,
  suggestionRows,
}: {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
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
  const { columns } = useTerminalSize()
  useSyncExternalStore(subscribeExtendedKeysSupport, extendedKeysSupportedNow, extendedKeysSupportedNow)
  const composerCrewmate = useComposerCrewmate()
  const viewedCrewmate = useViewedCrewmate()
  const fullscreen = isFullscreenEnvEnabled()
  const narrow = columns < NARROW_COLUMNS
  const stripHint = useSyncExternalStore(
    subscribeSurfaceRoute,
    () => stripKeyMapHintOf('repl', presentStripStops()),
    () => '',
  )

  useSetPromptOverlay(
    fullscreen && suggestions.length > 0
      ? {
          suggestions,
          onPick: onSuggestionPick,
          onHover: onSuggestionHover,
          maxRows: suggestionRows,
        }
      : null,
  )

  if (suggestions.length > 0 && !fullscreen) {
    return (
      <Box paddingX={2}>
        <PromptInputFooterSuggestions
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          onPick={onSuggestionPick}
          onHover={onSuggestionHover}
        />
      </Box>
    )
  }

  if (helpOpen) {
    return compact ? <Box maxHeight={maxRows} overflow="hidden"><PromptInputHelpMenu dimColor /></Box> : <PromptInputHelpMenu dimColor />
  }

  const leftSide = (
    <PromptInputFooterLeftSide
      compact={compact}
      exitPending={exitPending}
      exitKeyName={exitKeyName}
      isPasting={isPasting}
      searchField={searchField}
      vimInsert={vimInsert}
      mode={mode}
      isLoading={isLoading}
      hintsEnabled={hintsEnabled}
      crewmateFooterIndex={crewmateFooterIndex}
      onOpenTasksDialog={onOpenTasksDialog}
    />
  )
  if (compact) return <Box flexDirection="column" maxHeight={maxRows} overflow="hidden">{leftSide}</Box>
  const left = (
    <Box flexDirection="column" minWidth={0} flexShrink={1}>
      {leftSide}
      {!exitPending && !isPasting ? (
        <Text dimColor wrap="truncate-end">
          {getNewlineInstructions()}
          {composerCrewmate !== null ? ` · ${crewmateComposerHint(targetWords(composerCrewmate), viewedWords(viewedCrewmate))}` : ''}
          {fullscreen && stripHint !== '' ? ` · ${footerStripHint(stripHint)}` : ''}
        </Text>
      ) : null}
    </Box>
  )
  const right = (
    <Box
      flexDirection="column"
      alignItems={narrow ? 'flex-start' : 'flex-end'}
      gap={narrow ? 0 : 1}
      flexShrink={0}
    >
      {!fullscreen ? (
        <Notifications
          apiKeyStatus={apiKeyStatus}
          debug={debug}
          verbose={verbose}
          messages={messages}
          mcpClients={mcpClients}
          alignStart={narrow}
        />
      ) : null}
      {!compact ? <MercuryMissionIndicator /> : null}
    </Box>
  )

  if (narrow) {
    return (
      <Box flexDirection="column" alignItems="flex-start">
        {left}
        {right}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" justifyContent="space-between" gap={2}>
      {left}
      {right}
    </Box>
  )
}

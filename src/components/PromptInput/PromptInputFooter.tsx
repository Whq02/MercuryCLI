import React, { useMemo, useSyncExternalStore } from 'react'
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

export function footerStripHint(hint: string): string {
  return hint.replace(/^(?:⇧|shift\+)←/, 'shift + ←')
}

const NARROW_COLUMNS = 80

export function PromptInputFooter({
  suggestions,
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
  void isSearching
  useSyncExternalStore(
    subscribeExtendedKeysSupport,
    extendedKeysSupportedNow,
    extendedKeysSupportedNow,
  )
  const stripHint = useSyncExternalStore(
    subscribeSurfaceRoute,
    () => stripKeyMapHintOf('repl', presentStripStops()),
    () => '',
  )
  const fullscreen = isFullscreenEnvEnabled()
  const { columns } = useTerminalSize()
  const composerCrewmate = useComposerCrewmate()
  const viewedCrewmate = useViewedCrewmate()

  const hasSuggestions = suggestions.length > 0 && suggestionType !== 'none'
  const overlayData = useMemo(
    () =>
      fullscreen && hasSuggestions
        ? {
            suggestions,
            onPick: onSuggestionPick,
            onHover: onSuggestionHover,
            maxRows: suggestionRows,
          }
        : null,
    [fullscreen, hasSuggestions, suggestions, onSuggestionPick, onSuggestionHover, suggestionRows],
  )
  useSetPromptOverlay(overlayData)

  if (!fullscreen && hasSuggestions) {
    return (
      <Box paddingX={2}>
        <PromptInputFooterSuggestions
          suggestions={suggestions}
          onPick={onSuggestionPick}
          onHover={onSuggestionHover}
          maxRows={suggestionRows}
        />
      </Box>
    )
  }

  if (helpOpen) {
    const help = <PromptInputHelpMenu dimColor fixedWidth paddingX={2} />
    if (compact) {
      return (
        <Box maxHeight={maxRows} overflow="hidden">
          {help}
        </Box>
      )
    }
    return help
  }

  if (compact) {
    return (
      <Box maxHeight={maxRows} overflow="hidden">
        <PromptInputFooterLeftSide
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
          compact
        />
      </Box>
    )
  }

  const narrow = columns < NARROW_COLUMNS
  const crewmateHint =
    composerCrewmate !== null
      ? crewmateComposerHint(targetWords(composerCrewmate), viewedWords(viewedCrewmate))
      : null
  const formattedStripHint = fullscreen ? footerStripHint(stripHint) : ''

  return (
    <Box
      flexDirection={narrow ? 'column' : 'row'}
      justifyContent={narrow ? undefined : 'space-between'}
      alignItems={narrow ? 'flex-start' : undefined}
      gap={narrow ? undefined : 2}
    >
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <PromptInputFooterLeftSide
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
        {!exitPending && !isPasting ? (
          <Text dimColor wrap="truncate-end">
            {getNewlineInstructions()}
            {crewmateHint !== null ? ` · ${crewmateHint}` : ''}
            {formattedStripHint !== '' ? ` · ${formattedStripHint}` : ''}
          </Text>
        ) : null}
      </Box>
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
            isInputWrapped={input.includes('\n')}
            alignStart={narrow}
          />
        ) : null}
        <MercuryMissionIndicator />
      </Box>
    </Box>
  )
}

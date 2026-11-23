import React, { useMemo, useSyncExternalStore } from 'react'
import { Box, Text } from '../themedRenderer.js'
import {
  extendedKeysSupportedNow,
  subscribeExtendedKeysSupport,
} from '../renderer/terminal-session/capabilities.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { PromptInputMode } from './input-core/textInput.js'
import type { VerificationStatus } from '../../models/sign-in/credentials/useApiKeyVerification.js'
import { useSetPromptOverlay } from '../overlays/promptOverlay.js'
import {
  presentStripStops,
  stripKeyMapHintOf,
  subscribeSurfaceRoute,
} from '../routes/surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js'
import { MercuryMissionIndicator } from './MercuryMissionIndicator.js'
import { Notifications } from './Notifications.js'
import { PromptInputFooterLeftSide } from './ComposerFooterLeftSide.js'
import { PromptInputHelpMenu } from './ComposerHelpMenu.js'
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
  type SuggestionType,
} from './ComposerFooterSuggestions.js'
import { getNewlineInstructions } from './composerConfig.js'
import { crewmateComposerHint } from '../cockpit/crewmateWords.js'
import { targetWords, useComposerCrewmate, useViewedCrewmate, viewedWords } from '../tasks/useCrewmateView.js'

export function footerStripHint(hint: string): string {
  return hint.replace(/^(?:⇧|shift\+)←/, 'shift + ←')
}

const NARROW_COLUMNS = 80

export function PromptInputFooter({
  suggestions,
  onSuggestionPick,
  onSuggestionHover,
  helpOpen = false,
  mode,
  isLoading,
  exitPending,
  exitKeyName,
  isPasting,
  searchField,
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

  const hasSuggestions = suggestions.length > 0
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
        />
      </Box>
    )
  }

  if (helpOpen) {
    const help = <PromptInputHelpMenu dimColor />
    if (compact) {
      return (
        <Box maxHeight={maxRows} overflow="hidden">
          {help}
        </Box>
      )
    }
    return help
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

  if (compact) {
    return (
      <Box flexDirection="column" maxHeight={maxRows} overflow="hidden">
        {leftSide}
      </Box>
    )
  }

  const narrow = columns < NARROW_COLUMNS
  const crewmateHint =
    composerCrewmate !== null
      ? crewmateComposerHint(targetWords(composerCrewmate), viewedWords(viewedCrewmate))
      : null

  return (
    <Box
      flexDirection={narrow ? 'column' : 'row'}
      justifyContent={narrow ? undefined : 'space-between'}
      alignItems={narrow ? 'flex-start' : undefined}
      gap={narrow ? undefined : 2}
    >
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        {leftSide}
        {!exitPending && !isPasting ? (
          <Text dimColor wrap="truncate-end">
            {getNewlineInstructions()}
            {crewmateHint !== null ? ` · ${crewmateHint}` : ''}
            {fullscreen && stripHint !== '' ? ` · ${footerStripHint(stripHint)}` : ''}
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
            alignStart={narrow}
          />
        ) : null}
        <MercuryMissionIndicator />
      </Box>
    </Box>
  )
}

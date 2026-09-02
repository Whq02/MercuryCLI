
import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import {
  extendedKeysSupportedNow,
  subscribeExtendedKeysSupport,
} from '../../ink/session/capabilities.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
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
  ideSelection,
  mcpClients,
  hintsEnabled = true,
  teammateFooterIndex,
  onOpenTasksDialog,
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
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  hintsEnabled?: boolean
  teammateFooterIndex?: number
  onOpenTasksDialog?: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  useSyncExternalStore(subscribeExtendedKeysSupport, extendedKeysSupportedNow, extendedKeysSupportedNow)
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
    return <PromptInputHelpMenu dimColor />
  }

  const left = (
    <Box flexDirection="column" minWidth={0} flexShrink={1}>
      <PromptInputFooterLeftSide
        exitPending={exitPending}
        exitKeyName={exitKeyName}
        isPasting={isPasting}
        searchField={searchField}
        vimInsert={vimInsert}
        mode={mode}
        isLoading={isLoading}
        hintsEnabled={hintsEnabled}
        teammateFooterIndex={teammateFooterIndex}
        onOpenTasksDialog={onOpenTasksDialog}
      />
      {!exitPending && !isPasting ? (
        <Text dimColor wrap="truncate-end">
          {getNewlineInstructions()}
          {fullscreen && stripHint !== '' ? ` · ${stripHint}` : ''}
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
          ideSelection={ideSelection}
          mcpClients={mcpClients}
          alignStart={narrow}
        />
      ) : null}
      <MercuryMissionIndicator />
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

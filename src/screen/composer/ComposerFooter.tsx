import React, { useMemo } from 'react'
import { Box } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { InputMode } from './input-core/textInput.js'
import type { VerificationStatus } from '../../models/sign-in/credentials/useApiKeyVerification.js'
import { useSetPromptOverlay } from '../overlays/promptOverlay.js'
import { isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js'
import { MercuryMissionIndicator } from './MercuryMissionIndicator.js'
import { Notifications } from './Notifications.js'
import { ComposerFooterLeftSide } from './ComposerFooterLeftSide.js'
import { ComposerHelpMenu } from './ComposerHelpMenu.js'
import {
  ComposerFooterSuggestions,
  type SuggestionItem,
  type SuggestionType,
} from './ComposerFooterSuggestions.js'
const NARROW_COLUMNS = 80

export function ComposerFooter({
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
  mode: InputMode
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
  onOpenTasksDialog?: () => void
  compact?: boolean
  maxRows?: number
  suggestionRows?: number
}): React.ReactNode {
  const fullscreen = isFullscreenEnvEnabled()
  const { columns } = useTerminalSize()
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
        <ComposerFooterSuggestions
          suggestions={suggestions}
          onPick={onSuggestionPick}
          onHover={onSuggestionHover}
        />
      </Box>
    )
  }

  if (helpOpen) {
    const help = <ComposerHelpMenu dimColor />
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
    <ComposerFooterLeftSide
      compact={compact}
      exitPending={exitPending}
      exitKeyName={exitKeyName}
      isPasting={isPasting}
      searchField={searchField}
      vimInsert={vimInsert}
      mode={mode}
      isLoading={isLoading}
      hintsEnabled={hintsEnabled}
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

  return (
    <Box
      flexDirection={narrow ? 'column' : 'row'}
      justifyContent={narrow ? undefined : 'space-between'}
      alignItems={narrow ? 'flex-start' : undefined}
      gap={narrow ? undefined : 2}
    >
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        {leftSide}
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

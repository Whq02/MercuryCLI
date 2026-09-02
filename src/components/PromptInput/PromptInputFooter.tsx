// The footer arbiter: overlay publication first (fullscreen +
// completions → the floating suggestion payload), then — completions alone
// (non-fullscreen), the help menu alone, or the two-column status row.
// Narrow terminals stack the columns vertically and drop the gap. The
// custom status line of the base build is not mounted in Mercury (named
// spec delta — the statusbar owns standing status).

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
  /** The composer's selected teammate pill (0 = the leader pill). */
  teammateFooterIndex?: number
  onOpenTasksDialog?: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  // The newline row names the chord the latch decides; the boot probe's
  // reply can land after this footer's first paint, so it re-renders on the
  // upgrade instead of carrying the pre-reply chord until the next keystroke.
  useSyncExternalStore(subscribeExtendedKeysSupport, extendedKeysSupportedNow, extendedKeysSupportedNow)
  const fullscreen = isFullscreenEnvEnabled()
  const narrow = columns < NARROW_COLUMNS
  // THE FOOTER TEACHES THE STRIP (chat-feel item 4): the chat's key hints
  // name the surface chord beside the newline chord, STOP-DERIVED from the
  // router (the same stripKeyMapHintOf the face and the board paint) —
  // never a literal. The concourse present reads "⇧← concourse"; the plain
  // world reads "⇧← boot menu"; a world with no registered stop to the
  // left says nothing. Subscribed, so the row repaints exactly when a stop
  // appears or vanishes. Inline boots hide it — the strip refuses there
  // (CB-10), and a footer must never teach a chord that refuses.
  const stripHint = useSyncExternalStore(
    subscribeSurfaceRoute,
    () => stripKeyMapHintOf('repl', presentStripStops()),
    () => '',
  )

  // Overlay publication BEFORE the returns: in fullscreen a non-empty
  // completion list floats above the prompt through the overlay portal.
  useSetPromptOverlay(
    fullscreen && suggestions.length > 0
      ? {
          suggestions,
          onPick: onSuggestionPick,
          onHover: onSuggestionHover,
        }
      : null,
  )

  // 1 · completions present and not fullscreen → the list alone.
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

  // 2 · help open → the help menu alone.
  if (helpOpen) {
    return <PromptInputHelpMenu dimColor />
  }

  // 3 · the two-column status row. The newline instruction is a fixed row of
  // this form: a footer that sheds a row once a draft exists moves the
  // composer (the anchored-composer law), so it stays while typing and while
  // searching; only the exit-pending and pasting states, which replace the
  // left column wholesale, take the row with them.
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

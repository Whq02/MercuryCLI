
import React, { useMemo, useState } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { TerminalSizeContext } from '../renderer/elements/TerminalSizeContext.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import { Messages } from '../messages/Messages.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useLoad } from '../effects/effects.js'
import { getTools } from '../../tools/kit/toolList.js'
import { getEmptyToolPermissionContext } from '../../tools/kit/tool.js'
import { deserializeMessages } from '../../sessions/resume/conversationRecovery.js'
import { formatListingMetadata } from '../../platform/text/format.js'
import { getListingDisplayTitle } from '../../platform/logs/errorLog.js'
import { isLiteListing, fillSessionListing } from '../../sessions/transcripts/sessionStorage.js'

export function SessionPreview({
  log,
  onExit,
  onSelect,
}: {
  log: SessionListing
  onExit: () => void
  onSelect: (log: SessionListing) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const [fullLog, setFullLog] = useState<SessionListing | null>(
    isLiteListing(log) ? null : log,
  )
  const cardHeight = Math.max(6, rows)
  const interior = useMemo(
    () => ({ columns: Math.max(20, columns - 4), rows: Math.max(1, cardHeight - 2) }),
    [columns, cardHeight],
  )

  useLoad(signal => {
    if (!isLiteListing(log)) {
      setFullLog(log)
      return
    }
    void fillSessionListing(log).then(loaded => {
      if (!signal.aborted) setFullLog(loaded)
    })
  }, [log])

  useKeybinding('confirm:yes', () => onSelect(fullLog ?? log), {
    context: 'Confirmation',
  })
  useKeybinding('confirm:no', onExit, { context: 'Confirmation' })

  const tools = useMemo(() => getTools(getEmptyToolPermissionContext()), [])
  const messages = useMemo(
    () => (fullLog ? deserializeMessages(fullLog.messages) : []),
    [fullLog],
  )

  const title = getListingDisplayTitle(log, '(no prompt)').replace(/\s+/g, ' ').trim()

  const body =
    fullLog === null ? (
      <Box flexGrow={1} flexDirection="column">
        <Text dimColor>Loading session…</Text>
      </Box>
    ) : (
      <Box
        flexGrow={1}
        flexDirection="column"
        justifyContent="flex-end"
        overflowY="hidden"
      >
        <Messages
          messages={messages}
          tools={tools}
          commands={[]}
          verbose
          toolJSX={null}
          toolUseConfirmQueue={[]}
          inProgressToolUseIDs={new Set()}
          isRewindPickerVisible={false}
          conversationId={fullLog.sessionId ?? 'preview'}
          screen="transcript"
          streamingToolUses={[]}
          showAllInTranscript
          isLoading={false}
          suppressLogo
        />
      </Box>
    )

  const meta = fullLog ? formatListingMetadata(fullLog) : 'loading…'

  return (
    <Box
      flexDirection="column"
      height={cardHeight}
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
      key={(fullLog ?? log).sessionId ?? 'preview'}
    >
      <TerminalSizeContext.Provider value={interior}>
        <Box flexDirection="row" gap={1}>
          <Text bold color={tokens.accent}>
            Mercury · resume · preview
          </Text>
          <Text dimColor wrap="truncate">
            {title}
          </Text>
        </Box>
        {body}
        <Text dimColor wrap="truncate">
          {meta} · <Text color={tokens.info}>↵ resume</Text> · esc back
        </Text>
      </TerminalSizeContext.Provider>
    </Box>
  )
}

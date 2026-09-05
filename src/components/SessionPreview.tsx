
import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import type { LogOption } from '../types/logs.js'
import { Messages } from './Messages.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getTools } from '../tools.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { deserializeMessages } from '../utils/conversationRecovery.js'
import { formatLogMetadata } from '../utils/format.js'
import { getLogDisplayTitle } from '../utils/log.js'
import { isLiteLog, loadFullLog } from '../utils/sessionStorage.js'

export function SessionPreview({
  log,
  onExit,
  onSelect,
}: {
  log: LogOption
  onExit: () => void
  onSelect: (log: LogOption) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const [fullLog, setFullLog] = useState<LogOption | null>(
    isLiteLog(log) ? null : log,
  )
  const cardHeight = Math.max(6, rows)
  const interior = useMemo(
    () => ({ columns: Math.max(20, columns - 4), rows: Math.max(1, cardHeight - 2) }),
    [columns, cardHeight],
  )

  useEffect(() => {
    if (!isLiteLog(log)) {
      setFullLog(log)
      return
    }
    let cancelled = false
    void loadFullLog(log).then(loaded => {
      if (!cancelled) setFullLog(loaded)
    })
    return () => {
      cancelled = true
    }
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

  const title = getLogDisplayTitle(log, '(no prompt)').replace(/\s+/g, ' ').trim()

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
          isMessageSelectorVisible={false}
          conversationId={fullLog.sessionId ?? 'preview'}
          screen="transcript"
          streamingToolUses={[]}
          showAllInTranscript
          isLoading={false}
          suppressLogo
        />
      </Box>
    )

  const meta = fullLog ? formatLogMetadata(fullLog) : 'loading…'

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

export default SessionPreview

// Session preview: a read-only transcript of the picked session,
// framed in the SAME card grammar as the picker it opens from (rounded
// border, brand row, hint footer) — ctrl+v must read as a drilled-in pane of
// the picker, never a full-bleed surface swap. The transcript is bounded to
// the viewport and anchored to its TAIL (the newest turns are the preview's
// point); a lite record loads its full log first (loading state with its own
// cancel hint). Enter resumes — the fully-loaded record when it arrived,
// else the lite one; escape returns. Both ride the Confirmation context.

import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
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
  const { rows } = useTerminalSize()
  const [fullLog, setFullLog] = useState<LogOption | null>(
    isLiteLog(log) ? null : log,
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
      // Exact viewport fit: the writer's bottom-row scroll class is fixed
      // (CUP advances; the exact-fit bordered-card law pins it), so the card
      // owns every row again. The transcript box flex-grows into the middle
      // and clips, so the frame never overflows into a scroll.
      height={Math.max(6, rows)}
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
      key={(fullLog ?? log).sessionId ?? 'preview'}
    >
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
    </Box>
  )
}

export default SessionPreview

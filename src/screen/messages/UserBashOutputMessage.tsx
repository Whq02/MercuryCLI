
import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { BASH_BACKGROUND_TASK_TAG, BASH_DURATION_MS_TAG, BASH_EXIT_CODE_TAG } from '../../engine/message-shapes/messageTags.js'
import BashToolResultMessage from '../../tools/shell/BashToolResultMessage.js'
import { extractTag } from '../../engine/messages/messages.js'
import { formatDuration, formatSecondsShort } from '../../platform/text/format.js'
import { unescapeXml } from '../../platform/text/xml.js'
import { FAINT } from '../theme/mercuryPalette.js'
import { MessageResponse } from '../../tools/kit/MessageResponse.js'

function bashBackgroundWords(taskId: string): string {
  return `moved to the background as task ${taskId} — see /runs`
}

export function bashExitWords(code: string | null, durationMs: string | null, backgroundTaskId: string | null = null): string | null {
  if (backgroundTaskId !== null && backgroundTaskId !== '') return bashBackgroundWords(unescapeXml(backgroundTaskId))
  if (code === null || !/^\d+$/.test(code)) return null
  const ms = durationMs !== null && /^\d+$/.test(durationMs) ? Number(durationMs) : null
  const took = ms === null ? null : ms < 1000 ? `${ms}ms` : ms < 60_000 ? formatSecondsShort(ms) : formatDuration(ms)
  return took === null ? `exit ${code}` : `exit ${code} · ${took}`
}

export function UserBashOutputMessage({
  content,
  verbose,
}: {
  content: string
  verbose: boolean
}): React.ReactNode {
  let stdout = extractTag(content, 'bash-stdout') ?? ''
  const stderr = unescapeXml(extractTag(content, 'bash-stderr') ?? '')
  const persisted = extractTag(stdout, 'persisted-output')
  if (persisted !== null) stdout = persisted
  const words = bashExitWords(extractTag(content, BASH_EXIT_CODE_TAG), extractTag(content, BASH_DURATION_MS_TAG), extractTag(content, BASH_BACKGROUND_TASK_TAG))
  return (
    <Box flexDirection="column">
      <BashToolResultMessage
        content={{ stdout, stderr }}
        verbose={verbose}
      />
      {words !== null ? (
        <MessageResponse height={1}>
          <Text color={FAINT} dimColor>
            {words}
          </Text>
        </MessageResponse>
      ) : null}
    </Box>
  )
}

export default UserBashOutputMessage

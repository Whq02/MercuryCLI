
import React from 'react'
import { Box, Text } from '../../ink.js'
import { BASH_DURATION_MS_TAG, BASH_EXIT_CODE_TAG } from '../../constants/xml.js'
import BashToolResultMessage from '../../tools/BashTool/BashToolResultMessage.js'
import { extractTag } from '../../utils/messages.js'
import { formatDuration, formatSecondsShort } from '../../utils/format.js'
import { unescapeXml } from '../../utils/xml.js'
import { FAINT } from '../mercuryPalette.js'
import { MessageResponse } from '../MessageResponse.js'

export function bashExitWords(code: string | null, durationMs: string | null): string | null {
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
  const words = bashExitWords(extractTag(content, BASH_EXIT_CODE_TAG), extractTag(content, BASH_DURATION_MS_TAG))
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

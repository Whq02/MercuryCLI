import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from 'src/ink.js'
import { formatAPIError } from 'src/services/api/errorUtils.js'
import { apiTimeoutMsOverride } from 'src/utils/envValidation.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { useInterval } from 'usehooks-ts'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { GLYPH } from '../mercury-ui/glyphs.js'

const MAX_API_ERROR_CHARS = 1000

type Props = {
  message: SystemAPIErrorMessage
  verbose: boolean
}

export function SystemAPIErrorMessage({
  message: {
    retryAttempt,
    error,
    errorDetail,
    retryInMs,
    recoveryTimeoutMs,
    maxRetries,
  },
  verbose,
}: Props): React.ReactNode {
  const [countdownMs, setCountdownMs] = useState(0)
  const done = countdownMs >= retryInMs
  useInterval(() => setCountdownMs(ms => ms + 1000), done ? null : 1000)

  const retryInSecondsLive = Math.max(
    0,
    Math.round((retryInMs - countdownMs) / 1000),
  )

  const liveFormatted = formatAPIError(error)
  const formatted =
    (error as { message?: string })?.message || !errorDetail
      ? liveFormatted
      : `${errorDetail.name}${errorDetail.status ? ` ${errorDetail.status}` : ''}: ${errorDetail.message}`
  const transport = errorDetail?.transport
  const transportSuffix = transport?.code
    ? ` [${transport.code}${transport.via === 'recent-failure' ? ' · recent transport failure' : ''}]`
    : ''
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS
  const body = truncated
    ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…'
    : formatted

  const isTimeoutClass =
    /timed? ?out|timeout/i.test(formatted) ||
    transport?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    transport?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    transport?.code === 'UND_ERR_BODY_TIMEOUT'
  const timeoutRaw = process.env.API_TIMEOUT_MS
  const timeoutParsed = apiTimeoutMsOverride()
  const timeoutHint = timeoutRaw
    ? timeoutParsed === null
      ? ` · API_TIMEOUT_MS=${timeoutRaw} is not a whole number of milliseconds — unset it or set e.g. 120000`
      : ` · API_TIMEOUT_MS=${timeoutParsed}ms, try increasing it`
    : isTimeoutClass
      ? ' · slow link? set API_TIMEOUT_MS (current budget 600000ms)'
      : ''

  const statusLine =
    retryInMs === 0 && recoveryTimeoutMs
      ? `Retrying now without streaming (may take up to ${Math.round(recoveryTimeoutMs / 1000)}s)… (attempt ${retryAttempt}/${maxRetries})`
      : `Retrying in ${retryInSecondsLive} ${retryInSecondsLive === 1 ? 'second' : 'seconds'}… (attempt ${retryAttempt}/${maxRetries})`

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">
          {`${GLYPH.fail} `}
          {body}
          {transportSuffix}
        </Text>
        {truncated && <CtrlOToExpand />}
        <Text color={'subtle'} dimColor={false}>
          {statusLine}
          {timeoutHint}
        </Text>
        <Text dimColor>
          Reporting this? /export {'<name>'} writes the whole conversation to
          a file.
        </Text>
      </Box>
    </MessageResponse>
  )
}

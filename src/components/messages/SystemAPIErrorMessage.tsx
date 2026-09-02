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
  // EVERY retry is visible from attempt 1 (law 12: every fallback visible —
  // a blanket early-retry veil would hide attempts <4, which with a small
  // maxRetries meant NO feedback at all; the Windows
  // field-diagnostic retry-wall class).
  const [countdownMs, setCountdownMs] = useState(0)
  const done = countdownMs >= retryInMs
  useInterval(() => setCountdownMs(ms => ms + 1000), done ? null : 1000)

  const retryInSecondsLive = Math.max(
    0,
    Math.round((retryInMs - countdownMs) / 1000),
  )

  // A JSONL-resumed row carries error:{} — the structured detail is the
  // durable truth; prefer it whenever the live instance lost its message.
  const liveFormatted = formatAPIError(error)
  const formatted =
    (error as { message?: string })?.message || !errorDetail
      ? liveFormatted
      : `${errorDetail.name}${errorDetail.status ? ` ${errorDetail.status}` : ''}: ${errorDetail.message}`
  // /N-02: the deepest transport code is the diagnosis — show it.
  const transport = errorDetail?.transport
  const transportSuffix = transport?.code
    ? ` [${transport.code}${transport.via === 'recent-failure' ? ' · recent transport failure' : ''}]`
    : ''
  const truncated = !verbose && formatted.length > MAX_API_ERROR_CHARS
  const body = truncated
    ? formatted.slice(0, MAX_API_ERROR_CHARS) + '…'
    : formatted

  // /H-02: the API_TIMEOUT_MS hint helps the operator who has NOT set
  // it — name the live budget either way, on timeout-class rows only.
  const isTimeoutClass =
    /timed? ?out|timeout/i.test(formatted) ||
    transport?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    transport?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    transport?.code === 'UND_ERR_BODY_TIMEOUT'
  // Never glue 'ms' onto the RAW value: 'API_TIMEOUT_MS=60sms, try
  // increasing it' sent the operator raising a suffix the parser rejects
  // (TASK-017 S2, api-timeout-ms-three-parsers-no-floor) — an unparseable
  // spelling is named as such with the remedy.
  const timeoutRaw = process.env.API_TIMEOUT_MS
  const timeoutParsed = apiTimeoutMsOverride()
  const timeoutHint = timeoutRaw
    ? timeoutParsed === null
      ? ` · API_TIMEOUT_MS=${timeoutRaw} is not a whole number of milliseconds — unset it or set e.g. 120000`
      : ` · API_TIMEOUT_MS=${timeoutParsed}ms, try increasing it`
    : isTimeoutClass
      ? ' · slow link? set API_TIMEOUT_MS (current budget 600000ms)'
      : ''

  // /H-01: a recovery notice is NOT a scheduled wait — say what is
  // actually happening instead of counting down a ceiling nobody sleeps.
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

import * as React from 'react'
import { useState } from 'react'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { Box, Text } from 'src/ink.js'
import { formatAPIError } from 'src/services/api/errorUtils.js'
import { apiTimeoutMsOverride } from 'src/utils/envValidation.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { useInterval } from 'usehooks-ts'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { GLYPH } from '../../utils/glyphs.js'

const MAX_ERROR_LENGTH = 1000
const TIMEOUT_TRANSPORT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

type Props = {
  message: SystemAPIErrorMessage
  verbose?: boolean
}

export function SystemAPIErrorMessage({
  message: { retryAttempt, error, errorDetail, retryInMs, recoveryTimeoutMs, maxRetries },
  verbose = false,
}: Props): React.ReactNode {
  const [countdownMs, setCountdownMs] = useState(0)

  useInterval(
    () => {
      setCountdownMs(prev => prev + 1000)
    },
    countdownMs < retryInMs ? 1000 : null,
  )

  const remainingSeconds = Math.max(0, Math.round((retryInMs - countdownMs) / 1000))

  const rawBody =
    error?.message || !errorDetail
      ? formatAPIError(error)
      : `${errorDetail.name}${errorDetail.status !== undefined ? ` ${errorDetail.status}` : ''}: ${errorDetail.message}`

  const transport = errorDetail?.transport
  const transportSuffix = transport?.code
    ? ` [${transport.code}${transport.via === 'recent-failure' ? ' · recent transport failure' : ''}]`
    : ''

  const truncated = !verbose && rawBody.length > MAX_ERROR_LENGTH
  const body = truncated ? `${rawBody.slice(0, MAX_ERROR_LENGTH)}…` : rawBody

  const timeoutEnvRaw = flagEnv('MERCURY_API_TIMEOUT_MS')
  const parsedTimeoutMs = apiTimeoutMsOverride(timeoutEnvRaw)
  const looksLikeTimeout =
    /timed? ?out|timeout/i.test(rawBody) ||
    (transport?.code !== undefined && TIMEOUT_TRANSPORT_CODES.has(transport.code))

  let timeoutHint = ''
  if (timeoutEnvRaw !== undefined && timeoutEnvRaw.trim() !== '') {
    timeoutHint =
      parsedTimeoutMs === null
        ? ` · MERCURY_API_TIMEOUT_MS=${timeoutEnvRaw} is not a whole number of milliseconds — unset it or set e.g. 120000`
        : ` · MERCURY_API_TIMEOUT_MS=${parsedTimeoutMs}ms, try increasing it`
  } else if (looksLikeTimeout) {
    timeoutHint = ' · slow link? set MERCURY_API_TIMEOUT_MS (current budget 600000ms)'
  }

  let statusLine: string
  if (retryInMs === 0 && recoveryTimeoutMs) {
    statusLine = `Retrying now without streaming (may take up to ${Math.round(recoveryTimeoutMs / 1000)}s)… (attempt ${retryAttempt}/${maxRetries})`
  } else if (remainingSeconds === 0) {
    statusLine = `Retrying now… (attempt ${retryAttempt}/${maxRetries})`
  } else {
    statusLine = `Retrying in ${remainingSeconds} ${remainingSeconds === 1 ? 'second' : 'seconds'}… (attempt ${retryAttempt}/${maxRetries})`
  }

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{`${GLYPH.fail} ${body}${transportSuffix}`}</Text>
        {truncated ? <CtrlOToExpand /> : null}
        <Text color="subtle">{`${statusLine}${timeoutHint}`}</Text>
        <Text dimColor>
          Reporting this? /export &lt;name&gt; writes the whole conversation to a file.
        </Text>
      </Box>
    </MessageResponse>
  )
}

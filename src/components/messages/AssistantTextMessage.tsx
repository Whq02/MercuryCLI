
import { GLYPH } from '../mercury-ui/glyphs.js'
import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import { apiTimeoutMsOverride } from '../../utils/envValidation.js'
import type { TextBlockParam } from '../../types/wire.js'
import { decodeApiErrorBlobMessage } from '../../services/api/errorUtils.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  API_TIMEOUT_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  CUSTOM_OFF_SWITCH_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  TOKEN_REVOKED_ERROR_MESSAGE,
  isContinuableStreamFaultText,
  startsWithApiErrorPrefix,
} from '../../services/api/errors.js'
import { walletEntries } from '../../services/wallet/wallet.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { familyRouteWords } from '../../services/providers/accountSlots.js'
import { computedDefault } from '../../utils/model/computedDefault.js'
import { isRateLimitErrorMessage } from '../../services/rateLimitMessages.js'
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../../services/engine-connector/focusedConnector.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NO_RESPONSE_REQUESTED,
} from '../../utils/messages.js'
import { isMacOsKeychainLocked } from '../../utils/secureStorage/macOsKeychainStorage.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { InterruptedByUser } from '../InterruptedByUser.js'
import { Markdown } from '../Markdown.js'
import { RateLimitMessage } from './RateLimitMessage.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'

const subscribeFocusedRowModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedRowModel = (): string => getFocusedSessionConnector().modelFacts().main

const ERROR_CARD_TRUNCATE = 1_000
const DEFAULT_API_TIMEOUT_MS = 600_000
const BILLING_SETTINGS_URL = 'https://console.anthropic.com/settings/billing'

function splitErrorBody(body: string): { head: string; rest: string } {
  const candidates: number[] = []
  const sentence = body.indexOf('. ')
  if (sentence !== -1) candidates.push(sentence + 1)
  const newline = body.indexOf('\n')
  if (newline !== -1) candidates.push(newline)
  const json = body.search(/\{\s*"/)
  if (json > 0) candidates.push(json)
  if (candidates.length === 0) return { head: body, rest: '' }
  const at = Math.min(...candidates)
  return {
    head: body.slice(0, at).trimEnd(),
    rest: body.slice(at).replace(/^\s+/, ''),
  }
}

const DECODED_DIAGNOSIS_CAP = 240

function foldJsonBlobs(
  rest: string,
  shownElsewhere: string,
): { text: string; folded: boolean } {
  const at = rest.search(/\{\s*"/)
  if (at === -1) return { text: rest, folded: false }
  const blob = rest.slice(at)
  const before = rest.slice(0, at)
  const note = `[${blob.length} characters of error detail]`
  const decoded = decodeApiErrorBlobMessage(blob)
  if (
    decoded !== undefined &&
    decoded !== '' &&
    !`${shownElsewhere} ${before}`.includes(decoded)
  ) {
    const capped =
      decoded.length > DECODED_DIAGNOSIS_CAP
        ? `${decoded.slice(0, DECODED_DIAGNOSIS_CAP)}…`
        : decoded
    return { text: `${before}${capped} ${note}`, folded: true }
  }
  return { text: `${before}${note}`, folded: true }
}

function ErrorCard({
  text,
  verbose,
  recovered,
}: {
  text: string
  verbose: boolean
  recovered: boolean
}): React.ReactNode {
  if (recovered && isContinuableStreamFaultText(text) && !verbose) {
    return (
      <Text>
        <Text color="warning">{GLYPH.warn} </Text>
        <Text>The stream dropped mid-response.</Text>
        <Text dimColor> It recovered and the reply resumed below. </Text>
        <CtrlOToExpand />
      </Text>
    )
  }

  let body = text
  let truncated = false
  if (!verbose && body.length > ERROR_CARD_TRUNCATE) {
    body = `${body.slice(0, ERROR_CARD_TRUNCATE)}…`
    truncated = true
  }
  if (body.trim() === API_ERROR_MESSAGE_PREFIX) {
    body = `${API_ERROR_MESSAGE_PREFIX}: wait a moment, then try again.`
  }
  const { head, rest } = splitErrorBody(body)
  const { text: foldedRest, folded } = verbose
    ? { text: rest, folded: false }
    : foldJsonBlobs(rest, head)
  const showAffordance = !verbose && (folded || truncated)
  return (
    <Box flexDirection="column">
      <Text bold color="error">
        {head}
      </Text>
      {foldedRest !== '' ? <Text dimColor>{foldedRest}</Text> : null}
      {showAffordance ? <CtrlOToExpand /> : null}
    </Box>
  )
}

export function AssistantTextMessage({
  param,
  addMargin = false,
  shouldShowDot = false,
  verbose = false,
  streamFaultRecovered = false,
  width,
}: {
  param: TextBlockParam
  addMargin?: boolean
  shouldShowDot?: boolean
  verbose?: boolean
  streamFaultRecovered?: boolean
  width?: number | string
}): React.ReactNode {
  const mainLoopModel = useSyncExternalStore(subscribeFocusedRowModel, getFocusedRowModel, getFocusedRowModel)
  const text = param.text
  if (text === '' || text === NO_RESPONSE_REQUESTED) return null

  if (isRateLimitErrorMessage(text)) {
    return (
      <RateLimitMessage
        addMargin={addMargin}
        text={text}
      />
    )
  }

  if (text === PROMPT_TOO_LONG_ERROR_MESSAGE) {
    const upgrade = getUpgradeMessage(mainLoopModel)
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        <Text color="error">
          Context limit reached. Run /compact to continue with a summarized
          history, or /clear to start fresh.
        </Text>
        {upgrade ? <Text dimColor>{upgrade.tip}</Text> : null}
      </Box>
    )
  }
  if (text === CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE) {
    return (
      <Text color="error">
        Anthropic says this account's credit balance is too low · Add funds at{' '}
        {BILLING_SETTINGS_URL}
      </Text>
    )
  }
  if (text === INVALID_API_KEY_ERROR_MESSAGE) {
    const otherProviders = ((): string | null => {
      try {
        const others = walletEntries().filter(e => e.provider !== 'anthropic')
        if (others.length === 0) return null
        return [...new Set(others.map(e => providerDisplayName(e.provider)))].join(' · ')
      } catch {
        return null
      }
    })()
    const refusedFamily = providerDisplayName('anthropic')
    const switchTarget = ((): string => {
      try {
        const landed = computedDefault().provider
        return landed !== null && landed !== 'anthropic' ? providerDisplayName(landed) : 'their models'
      } catch {
        return 'their models'
      }
    })()
    return (
      <Box flexDirection="column">
        <Text color="error">
          {
}
          {otherProviders !== null ? `No ${refusedFamily} account for this model` : 'Not logged in · Run /logins'}
        </Text>
        {otherProviders !== null ? (
          <Text dimColor>
            {`${otherProviders} ${otherProviders.includes(' · ') ? 'are' : 'is'} connected — /model switches to ${switchTarget}, or ${familyRouteWords('anthropic')} adds one.`}
          </Text>
        ) : null}
        {isMacOsKeychainLocked() ? (
          <Text dimColor>
            The macOS keychain is locked — run `security unlock-keychain` in
            another terminal, then retry.
          </Text>
        ) : null}
      </Box>
    )
  }
  if (
    text === INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL ||
    text === ORG_DISABLED_ERROR_MESSAGE_ENV_KEY ||
    text === ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH ||
    text === TOKEN_REVOKED_ERROR_MESSAGE ||
    text === 'Your account does not have access to Mercury. Please log in again, or contact your administrator.'
  ) {
    return <Text color="error">{text}</Text>
  }
  if (text === API_TIMEOUT_ERROR_MESSAGE) {
    const configured = process.env.API_TIMEOUT_MS
    return (
      <Box flexDirection="column">
        <Text color="error">{text}</Text>
        <Text dimColor>
          {configured
            ? apiTimeoutMsOverride() === null
              ? `API_TIMEOUT_MS is set to ${configured}, which is not a whole number of milliseconds — the default applied; unset it or set e.g. 120000.`
              : `API_TIMEOUT_MS is set to ${configured} — increase it to allow slower responses.`
            : `Set the API_TIMEOUT_MS environment variable to raise the request budget (current default: ${DEFAULT_API_TIMEOUT_MS} ms).`}
        </Text>
      </Box>
    )
  }
  if (text === CUSTOM_OFF_SWITCH_MESSAGE) {
    return <Text color="warning">{text}</Text>
  }
  if (text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE) {
    return <InterruptedByUser />
  }

  if (startsWithApiErrorPrefix(text)) {
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        <ErrorCard
          text={text}
          verbose={verbose}
          recovered={streamFaultRecovered}
        />
      </Box>
    )
  }

  const workingNote = param.phase === 'commentary'
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      width={width}
    >
      <Markdown
        color={workingNote ? 'subtle' : undefined}
        leadingInline={shouldShowDot ? <TranscriptNameplate /> : undefined}
      >
        {text}
      </Markdown>
    </Box>
  )
}

export default AssistantTextMessage

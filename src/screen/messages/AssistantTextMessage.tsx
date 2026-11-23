import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { apiTimeoutMsOverride } from '../../platform/environment/envValidation.js'
import type { TextBlockParam } from '../../engine/message-shapes/wire.js'
import { decodeApiErrorBlobMessage } from '../../engine/requests/apiErrorDetails.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  API_TIMEOUT_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  CUSTOM_OFF_SWITCH_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isContinuableStreamFaultText,
  isInvalidCredentialWords,
  startsWithApiErrorPrefix,
} from '../../engine/requests/apiErrorRows.js'
import { walletEntries } from '../../models/wallet/wallet.js'
import { providerDisplayName } from '../../models/roads/routeLaw.js'
import { familyRouteWords } from '../../models/roads/accountSlots.js'
import { CHOOSE_A_MODEL_DOOR, computedDefault } from '../../models/catalogue/computedDefault.js'
import { isRateLimitErrorMessage } from '../../models/roads/anthropic/rateLimitMessages.js'
import { getUpgradeMessage } from '../../models/facts/contextWindowUpgradeCheck.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../../engine/connector/focusedConnector.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NO_RESPONSE_REQUESTED,
} from '../../engine/messages/messages.js'
import { isMacOsKeychainLocked } from '../../platform/secure-storage/macOsKeychainStorage.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { InterruptedByUser } from './InterruptedByUser.js'
import { Markdown } from './Markdown.js'
import { RateLimitMessage } from './RateLimitMessage.js'
import { CrewmatePlateContext, TranscriptNameplate } from './TranscriptNameplate.js'
import { ENVELOPE_TAG, type DeclaredEnvelope } from '../../crew/agent-results/contracts.js'
import { parseDeclaration } from '../../crew/agent-results/normalize.js'
import { withoutMissionMetSentinel } from '../../sessions/mission/sentinel.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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
  if (recovered && isContinuableStreamFaultText(text)) {
    return <Text dimColor>{text}</Text>
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

export function crewmateCloseNoteOf(declared: DeclaredEnvelope): string {
  const parts: string[] = []
  const summary = declared.summary?.replace(/\s+/g, ' ').trim() ?? ''
  if (summary.length > 0) parts.push(summary)
  if (declared.findings !== undefined && declared.findings.length > 0) parts.push(`${declared.findings.length} finding${declared.findings.length === 1 ? '' : 's'}`)
  if (declared.unresolved !== undefined && declared.unresolved.length > 0) parts.push(`${declared.unresolved.length} unresolved: ${declared.unresolved.map(u => u.replace(/\s+/g, ' ').trim()).join('; ')}`)
  if (declared.recommendedNextAction !== undefined && declared.recommendedNextAction.trim().length > 0) parts.push(`next: ${declared.recommendedNextAction.replace(/\s+/g, ' ').trim()}`)
  if (declared.checks !== undefined) parts.push(declared.checks.length === 0 ? 'no checks named' : `checks: ${declared.checks.join(', ')}`)
  return `close note — ${parts.length > 0 ? parts.join(' · ') : 'nothing declared'}`
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
  const mainModel = useSyncExternalStore(
    subscribeFocusedRowModel,
    getFocusedRowModel,
    getFocusedRowModel,
  )
  const crewmatePlate = React.useContext(CrewmatePlateContext)
  const { text } = param

  if (!text || text.trim() === '' || text === NO_RESPONSE_REQUESTED) {
    return null
  }

  if (isRateLimitErrorMessage(text)) {
    return <RateLimitMessage addMargin={addMargin} text={text} />
  }

  if (text === PROMPT_TOO_LONG_ERROR_MESSAGE) {
    const upgrade = getUpgradeMessage(mainModel)
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
        Anthropic says this account's credit balance is too low · Add funds at {BILLING_SETTINGS_URL}
      </Text>
    )
  }

  if (text === INVALID_API_KEY_ERROR_MESSAGE) {
    const keychainLocked = isMacOsKeychainLocked()
    const otherProviders: string[] = []
    try {
      const seen = new Set<string>()
      for (const entry of walletEntries()) {
        if (entry.provider === 'anthropic') continue
        const display = providerDisplayName(entry.provider)
        if (!seen.has(display)) {
          seen.add(display)
          otherProviders.push(display)
        }
      }
    } catch (error) {
      passedOver(error)
      otherProviders.length = 0
    }

    let switchTarget = 'their models'
    if (otherProviders.length > 0) {
      try {
        const decision = computedDefault()
        if (decision.provider !== null && decision.provider !== 'anthropic' && decision.row !== '') {
          switchTarget = decision.row
        }
      } catch (error) {
        passedOver(error)
      }
    }

    const keychainWarning = keychainLocked ? (
      <Text dimColor>
        The macOS keychain is locked — run `security unlock-keychain` in
        another terminal, then retry.
      </Text>
    ) : null

    if (otherProviders.length === 0) {
      return (
        <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
          <Text color="error">Not logged in · Run /logins</Text>
          {keychainWarning}
        </Box>
      )
    }

    const joinedProviders = otherProviders.join(' · ')
    const verb = otherProviders.length > 1 ? 'are' : 'is'
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        <Text color="error">
          No {providerDisplayName('anthropic')} account for this model
        </Text>
        <Text dimColor>
          {joinedProviders} {verb} connected — /model switches to {switchTarget}, or {familyRouteWords('anthropic')} adds one.
        </Text>
        {keychainWarning}
      </Box>
    )
  }

  if (isInvalidCredentialWords(text) || text === CHOOSE_A_MODEL_DOOR) {
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        <Text color="error">{text}</Text>
      </Box>
    )
  }

  if (text === API_TIMEOUT_ERROR_MESSAGE) {
    const configuredTimeout = flagEnv('MERCURY_API_TIMEOUT_MS')
    const parsedTimeout = apiTimeoutMsOverride()
    const hint = configuredTimeout
      ? parsedTimeout === null
        ? `MERCURY_API_TIMEOUT_MS is set to ${configuredTimeout}, which is not a whole number of milliseconds — the default applied; unset it or set e.g. 120000.`
        : `MERCURY_API_TIMEOUT_MS is set to ${configuredTimeout} — increase it to allow slower responses.`
      : `Set the MERCURY_API_TIMEOUT_MS environment variable to raise the request budget (current default: ${DEFAULT_API_TIMEOUT_MS} ms).`
    return (
      <Box flexDirection="column">
        <Text color="error">{text}</Text>
        <Text dimColor>{hint}</Text>
      </Box>
    )
  }

  if (text === CUSTOM_OFF_SWITCH_MESSAGE) {
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        <Text color="warning">{text}</Text>
      </Box>
    )
  }

  if (text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <InterruptedByUser />
      </Box>
    )
  }

  if (startsWithApiErrorPrefix(text)) {
    if (streamFaultRecovered && !verbose && isContinuableStreamFaultText(text)) {
      return null
    }
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
        <ErrorCard text={text} verbose={verbose} recovered={streamFaultRecovered} />
      </Box>
    )
  }

  const hasEnvelope = crewmatePlate !== null && text.includes(`<${ENVELOPE_TAG}>`)
  let proseText = text
  let closeNote: string | null = null
  if (hasEnvelope) {
    const parsed = parseDeclaration(text)
    proseText = parsed.prose
    if (parsed.declared !== null) {
      closeNote = crewmateCloseNoteOf(parsed.declared)
    } else if (parsed.malformedRaw !== null) {
      closeNote = `close note (unreadable) — ${parsed.malformedRaw}`
    }
  }

  const cleanProse = withoutMissionMetSentinel(proseText)
  const hasProse = cleanProse.trim() !== ''
  if (!hasProse && closeNote === null) {
    return null
  }

  const leadingPlate = shouldShowDot ? <TranscriptNameplate /> : undefined
  const color = param.phase === 'commentary' ? 'subtle' : undefined

  if (!hasProse && closeNote !== null) {
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width={width}>
        <Text dimColor>
          {leadingPlate}
          {closeNote}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width={width}>
      <Markdown color={color} leadingInline={leadingPlate}>
        {cleanProse}
      </Markdown>
      {closeNote !== null ? <Text dimColor>{closeNote}</Text> : null}
    </Box>
  )
}

export default AssistantTextMessage

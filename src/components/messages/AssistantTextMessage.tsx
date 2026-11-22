import { flagEnv } from '../../substrate/flagRegistry.js'
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
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isContinuableStreamFaultText,
  isInvalidCredentialWords,
  startsWithApiErrorPrefix,
} from '../../services/api/errors.js'
import { walletEntries } from '../../services/wallet/wallet.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { familyRouteWords } from '../../services/providers/accountSlots.js'
import { CHOOSE_A_MODEL_DOOR, computedDefault } from '../../services/model/computedDefault.js'
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
} from '../../services/messages.js'
import { isMacOsKeychainLocked } from '../../utils/secureStorage/macOsKeychainStorage.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { InterruptedByUser } from '../InterruptedByUser.js'
import { Markdown } from '../Markdown.js'
import { RateLimitMessage } from './RateLimitMessage.js'
import { CrewmatePlateContext, TranscriptNameplate } from './TranscriptNameplate.js'
import { ENVELOPE_TAG, type DeclaredEnvelope } from '../../services/agentResults/contracts.js'
import { parseDeclaration } from '../../services/agentResults/normalize.js'
import { withoutMissionMetSentinel } from '../../services/mission/sentinel.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

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

export function AssistantTextMessage(arg0: {
  param: TextBlockParam
  addMargin?: boolean
  shouldShowDot?: boolean
  verbose?: boolean
  streamFaultRecovered?: boolean
  width?: number | string
}): React.ReactNode {
  return notBuilt('src/components/messages/AssistantTextMessage.tsx:143')
}

export default AssistantTextMessage

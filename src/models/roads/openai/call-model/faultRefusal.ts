import type {
  AssistantMessage,
} from '../../../../engine/message-shapes/message.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../../../engine/requests/apiErrorRows.js'
import {
  openaiSourceIdentity,
} from '../openaiAccounts.js'
import { noteOpenaiSourceIdentity, recordOpenaiUsageLimit } from '../openaiLimitState.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { stampProviderWait } from '../../../../engine/requests/recoveryBudget.js'
import { markUnknownModel } from '../../../../engine/requests/backupEngines.js'
import { apiErrorMessage, openaiFaultToTypedError } from './faults.js'
import { busyPrefix, withEffort, type AttemptFault, type OpenaiTurn } from './turnState.js'
import { passedOver } from '../../../../platform/errors/passedOver.js'

export async function refuseUsageLimit(turn: OpenaiTurn, fault: AttemptFault): Promise<AssistantMessage> {
  const { auth } = turn
  const { outcome } = fault
  noteOpenaiSourceIdentity(auth.account.kind, openaiSourceIdentity(auth.account.kind))
  recordOpenaiUsageLimit(outcome.fault.resetsAtMs, auth.account.kind)
  const slotAppendix = ((): string => {
    try {
      const { slotWallAppendix } =
        require('../../slotSwitch.js') as typeof import('../../slotSwitch.js')
      return slotWallAppendix('openai')
    } catch (error) {
      passedOver(error)
      return ''
    }
  })()
  await (await import('../../catalogueOnDemand.js')).readCataloguesForOtherFamilies('openai')
  const laneRemedy = ((): string => {
    try {
      const { crossFamilyLaneRemedy } =
        require('../../anthropic/rateLimitMessages.js') as typeof import('../../anthropic/rateLimitMessages.js')
      const line = crossFamilyLaneRemedy('openai')
      return line === null ? '' : ` ${line}`
    } catch (error) {
      passedOver(error)
      return ''
    }
  })()
  await refreshProviderUsage('openai', { force: true, reason: 'operator' })
  const carryClause = ((): string => {
    try {
      const { usageCarryWords, usageForProvider } =
        require('../../providerUsage.js') as typeof import('../../providerUsage.js')
      const words = usageCarryWords(usageForProvider('openai').carry)
      return words === undefined ? '' : ` · ${words}`
    } catch (error) {
      passedOver(error)
      return ''
    }
  })()
  return withEffort(turn, stampProviderWait(
    markUnknownModel(apiErrorMessage(
      busyPrefix(turn, `${API_ERROR_MESSAGE_PREFIX}: the ${auth.account.label} request was refused (${outcome.fault.code}) — ${outcome.fault.message}${carryClause}. The next request goes to OpenAI again; resume any time. Mercury never reroutes across providers silently, and never changes the account source without your word.${slotAppendix || ' Options: retry now · pick another model via /model · switch the OpenAI source explicitly (s on the OpenAI row in /logins).'}${laneRemedy}`, outcome.fault),
      openaiFaultToTypedError(outcome.fault),
      `${outcome.fault.code}${outcome.fault.resetsAtMs !== undefined ? ` resets_at=${new Date(outcome.fault.resetsAtMs).toISOString()}` : ''}`,
    ), outcome.fault.status),
    outcome.fault.retryAfterMs,
  ))
}

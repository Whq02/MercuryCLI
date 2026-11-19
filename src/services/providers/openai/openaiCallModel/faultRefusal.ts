import { API_ERROR_MESSAGE_PREFIX } from '../../../api/errors.js'
import {
  createAssistantMessage,
} from '../../../../utils/messages.js'
import {
  openaiSourceIdentity,
} from '../openaiAccounts.js'
import { noteOpenaiSourceIdentity, recordOpenaiUsageLimit } from '../openaiLimitState.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { recordLaneBillingRefusal } from '../../laneBillingState.js'
import { stampProviderWait } from '../../../api/recoveryBudget.js'
import { markUnknownModel } from '../../../api/backupEngines.js'
import { busyRefusalFact } from '../../busyRetry.js'
import type { CallModelYield } from '../../callModelContract.js'
import { MODEL_NOT_FOUND_CODE, apiErrorMessage, openaiFaultToTypedError } from './faults.js'
import { isCompactionSource, priorConversation4xx } from './resumeTrim.js'
import { busyPrefix, withEffort, type AttemptFault, type OpenaiTurn } from './turnState.js'

export async function* refuseUsageLimit(turn: OpenaiTurn, fault: AttemptFault): AsyncGenerator<CallModelYield, boolean> {
  const { auth } = turn
  const { outcome, typed } = fault
  if (outcome.fault.kind === 'usage-limit' && typed === 'rate_limit') {
    noteOpenaiSourceIdentity(auth.account.kind, openaiSourceIdentity(auth.account.kind))
    recordOpenaiUsageLimit(outcome.fault.resetsAtMs, auth.account.kind)
    const slotAppendix = ((): string => {
      try {
        const { slotWallAppendix } =
          require('../../slotSwitch.js') as typeof import('../../slotSwitch.js')
        return slotWallAppendix('openai')
      } catch {
        return ''
      }
    })()
    await (await import('../../catalogueOnDemand.js')).readCataloguesForOtherFamilies('openai')
    const laneRemedy = ((): string => {
      try {
        const { crossFamilyLaneRemedy } =
          require('../../../rateLimitMessages.js') as typeof import('../../../rateLimitMessages.js')
        const line = crossFamilyLaneRemedy('openai')
        return line === null ? '' : ` ${line}`
      } catch {
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
      } catch {
        return ''
      }
    })()
    yield withEffort(turn, stampProviderWait(
      markUnknownModel(apiErrorMessage(
        busyPrefix(turn, `${API_ERROR_MESSAGE_PREFIX}: the ${auth.account.label} request was refused (${outcome.fault.code}) — ${outcome.fault.message}${carryClause}. The next request goes to OpenAI again; resume any time. Mercury never reroutes across providers silently, and never changes the account source without your word.${slotAppendix || ' Options: retry now · pick another model via /model · switch the OpenAI source explicitly (s on the OpenAI row in /logins).'}${laneRemedy}`, outcome.fault, typed),
        openaiFaultToTypedError(outcome.fault),
        `${outcome.fault.code}${outcome.fault.resetsAtMs !== undefined ? ` resets_at=${new Date(outcome.fault.resetsAtMs).toISOString()}` : ''}`,
      ), outcome.fault.status),
      outcome.fault.retryAfterMs,
    ))
    return true
  }
  return false
}

export async function* refuseTurn(turn: OpenaiTurn, fault: AttemptFault): AsyncGenerator<CallModelYield, void> {
  const { auth, recovery, options, conversation4xxKey, resumeTrimReissued, busy } = turn
  const { outcome, typed, refusedMedia, overflow } = fault
  const detail = outcome.fault.message
    ? `${outcome.fault.code}: ${outcome.fault.message}`
    : outcome.fault.code
  const text =
    typed === 'authentication_failed'
      ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI rejected the ${auth.account.label} credential (${detail}) — ${
          auth.account.kind === 'chatgpt-subscription'
            ? '/logins signs in to the ChatGPT account again'
            : 'set a valid OPENAI_API_KEY, or /logins attaches a fresh API key'
        }.${
          recovery === 'retried'
            ? ' The stored token was refreshed and the call retried once before this refusal.'
            : recovery === 'no-new-credential'
              ? ' A token refresh was attempted first and produced no new credential.'
              : ''
        }`
      : typed === 'billing_error'
        ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI reports the ${auth.account.label} account out of credit (${detail}) — add credit to the OpenAI account, then retry; /model picks another model meanwhile.`
        : `${API_ERROR_MESSAGE_PREFIX}: OpenAI stream failed (${outcome.fault.code}) — ${outcome.fault.message}`
  if (typed === 'billing_error') {
    recordLaneBillingRefusal('openai', {
      detail,
      remedy: 'add credit to the OpenAI account, then retry; /model picks another model meanwhile.',
    })
  }
  if (typed === 'invalid_request' && refusedMedia === null && overflow === null && !MODEL_NOT_FOUND_CODE.test(outcome.fault.code) && !isCompactionSource(options.querySource)) {
    priorConversation4xx.set(conversation4xxKey, outcome.fault.code)
  }
  if (resumeTrimReissued !== undefined) {
    yield withEffort(turn, createAssistantMessage({ content: resumeTrimReissued }))
  }
  yield withEffort(turn, apiErrorMessage(
    busyPrefix(turn, text, outcome.fault, typed),
    typed,
    outcome.fault.code,
    overflow,
    refusedMedia,
    busy !== undefined ? busyRefusalFact('OpenAI', busy.ladder, outcome.fault) : null,
  ))
}

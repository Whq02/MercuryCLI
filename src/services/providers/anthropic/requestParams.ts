import { flagEnabled } from '../../../substrate/flagRegistry.js'
import {
  type BetaMessageParam as MessageParam,
  type BetaOutputConfig,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  getLastApiCompletionTimestamp,
  getPromptCache1hEligible,
  getSessionId,
  setPromptCache1hEligible,
} from 'src/bootstrap/state.js'
import { getOauthAccountInfo, isClaudeAISubscriber } from '../../../utils/auth.js'
import {
  getModelBetas,
  modelSupportsTemperature,
} from '../../../utils/betas.js'
import { cacheClockTtlDecision } from 'src/utils/cache/cacheClock.js'
import { logForDebugging } from 'src/utils/debug.js'
import { modelSupportsEffort, type EffortValue } from 'src/utils/effort.js'
import type { EffortWireFact } from 'src/utils/effortStamp.js'
import { errorMessage } from '../../../utils/errors.js'
import { returnValue } from 'src/utils/generators.js'
import { safeParseJSON } from '../../../utils/json.js'
import { logError } from '../../../utils/log.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
} from '../../../utils/model/model.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import { currentLimits } from '../../anthropicLimits.js'
import { getAnthropicClient } from '../../api/client.js'
import { CannotRetryError, withRetry } from '../../api/withRetry.js'
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

function extraObject(name: 'MERCURY_EXTRA_BODY' | 'MERCURY_EXTRA_METADATA', logParseError: boolean): JsonObject {
  const raw = process.env[name]
  if (!raw) return {}
  const value = safeParseJSON(raw, logParseError)
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  logForDebugging(`${name} env var must be a JSON object, but was given ${raw}`, { level: 'error' })
  return {}
}

export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  let body: JsonObject
  try {
    body = { ...extraObject('MERCURY_EXTRA_BODY', true) }
  } catch (error) {
    logForDebugging(`Error parsing MERCURY_EXTRA_BODY: ${errorMessage(error)}`, { level: 'error' })
    body = {}
  }
  if (!betaHeaders?.length) return body
  const previous = body.anthropic_beta
  body.anthropic_beta = Array.isArray(previous)
    ? [...previous, ...betaHeaders.filter(header => !previous.includes(header))] : betaHeaders
  return body
}

export function getPromptCachingEnabled(model: string): boolean {
  if (!flagEnabled('MERCURY_PROMPT_CACHING')) return false

  if (!flagEnabled('MERCURY_PROMPT_CACHING_HAIKU')) {
    if (model === getSmallFastModel()) return false
  }
  if (!flagEnabled('MERCURY_PROMPT_CACHING_SONNET')) {
    if (model === getDefaultSonnetModel()) return false
  }
  if (!flagEnabled('MERCURY_PROMPT_CACHING_OPUS')) {
    if (model === getDefaultOpusModel()) return false
  }

  return true
}

export function getCacheControl(): {
  type: 'ephemeral'
  ttl?: '1h'
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL() && { ttl: '1h' }),
  }
}

export function latched1hEligibility(): boolean {
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = isClaudeAISubscriber() && !currentLimits.isUsingOverage
    setPromptCache1hEligible(userEligible)
  }
  return userEligible
}

export function should1hCacheTTL(): boolean {
  const clockTtl = cacheClockTtlDecision({
    eligible: latched1hEligibility(),
    lastCompletionAt: getLastApiCompletionTimestamp(),
    now: Date.now(),
  })
  return clockTtl === '1h'
}

const FIRST_PARTY_WIRE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly NonNullable<BetaOutputConfig['effort']>[]
type FirstPartyWireEffort = (typeof FIRST_PARTY_WIRE_EFFORTS)[number]
function isFirstPartyWireEffort(level: string): level is FirstPartyWireEffort {
  return (FIRST_PARTY_WIRE_EFFORTS as readonly string[]).includes(level)
}

export function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    return
  }
  if (typeof effortValue === 'string' && isFirstPartyWireEffort(effortValue)) {
    outputConfig.effort = effortValue
  } else {
    logForDebugging(
      `configureEffortParams: effort ${effortValue} has no first-party wire encoding — sending without effort`,
      { level: 'warn' },
    )
  }
}

export function anthropicEffortWireFact(
  params: { output_config?: { effort?: string | undefined } | undefined },
  supported: boolean,
): EffortWireFact {
  const top = params.output_config?.effort
  if (top !== undefined) return { kind: 'sent', parameter: 'output_config.effort', value: top }
  return supported ? { kind: 'omitted' } : { kind: 'unsupported' }
}

export function getAPIMetadata() {
  const extra = extraObject('MERCURY_EXTRA_METADATA', false)
  const identity = { account_uuid: getOauthAccountInfo()?.accountUuid ?? '', session_id: getSessionId() }
  return { user_id: jsonStringify({ ...extra, ...identity }) }
}

function keyProbeBody(model: string, betas: string[]) {
  const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
  return {
    model, max_tokens: 1, messages,
    ...(modelSupportsTemperature(model) ? { temperature: 1 } : {}),
    ...(betas.length ? { betas } : {}),
    metadata: getAPIMetadata(), ...getExtraBodyParams(),
  }
}

function keyProbeFailure(caught: unknown): false {
  const error = caught instanceof CannotRetryError ? caught.originalError : caught
  logError(error)
  const invalid = error instanceof Error && error.message.includes(
    '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  )
  if (invalid) return false
  throw error
}

export async function verifyApiKey(apiKey: string, isNonInteractiveSession: boolean): Promise<boolean> {
  if (isNonInteractiveSession) return true
  try {
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    const createClient = () => getAnthropicClient({ apiKey, maxRetries: 3, source: 'verify_api_key' })
    const probe = async (anthropic: Awaited<ReturnType<typeof getAnthropicClient>>): Promise<true> => {
      await anthropic.beta.messages.create(keyProbeBody(model, betas))
      return true
    }
    const attempts = withRetry(createClient, probe, {
      maxRetries: 2, model, thinkingConfig: { type: 'disabled' }, reconnect: false,
    })
    return await returnValue(attempts)
  } catch (caught) {
    return keyProbeFailure(caught)
  }
}

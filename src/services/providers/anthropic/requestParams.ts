import { flagEnabled } from '../../../substrate/flagRegistry.js'
import type { MessageParam } from '../../../types/wire.js'
import type { AnthropicOutputConfig as BetaOutputConfig } from './anthropicWire.js'
import {
  getLastApiCompletionTimestamp,
  getPromptCache1hEligible,
  getSessionId,
  setPromptCache1hEligible,
} from 'src/bootstrap/state.js'
import { getOauthAccountInfo, hasStoredOAuthToken, isAnthropicAuthEnabled, isClaudeAISubscriber, readAnthropicPreferredSource } from '../../../utils/auth.js'
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

export function promptCache1hEligibility(): { eligible: boolean; reason: string | null } {
  const reading = eligibilityReading()
  setPromptCache1hEligible(reading.eligible)
  return reading
}

function eligibilityReading(): { eligible: boolean; reason: string | null } {
  if (isClaudeAISubscriber()) {
    if (currentLimits.isUsingOverage) return { eligible: false, reason: 'the claude.ai account is on extra usage, billed per token — the 1h tier costs 2x on writes; MERCURY_CACHE_TTL=1h pins it as billing consent' }
    return { eligible: true, reason: null }
  }
  if (!isAnthropicAuthEnabled()) return { eligible: false, reason: 'the Anthropic seat is a console key (ANTHROPIC_API_KEY, a key command or an auth token), billed per token — the 1h tier costs 2x on writes; MERCURY_CACHE_TTL=1h pins it as billing consent' }
  if (hasStoredOAuthToken() && readAnthropicPreferredSource() === 'api-key') return { eligible: false, reason: 'the stored claude.ai sign-in yields the seat to the managed key (/logins), billed per token — the 1h tier costs 2x on writes; MERCURY_CACHE_TTL=1h pins it as billing consent' }
  return { eligible: false, reason: 'no claude.ai sign-in is stored for this home — the 1h tier rides a claude.ai subscription; MERCURY_CACHE_TTL=1h pins it as billing consent' }
}

function should1hCacheTTL(): boolean {
  const eligibility = getPromptCache1hEligible() === true ? { eligible: true, reason: null } : promptCache1hEligibility()
  const clockTtl = cacheClockTtlDecision({
    eligible: eligibility.eligible,
    ...(eligibility.reason !== null ? { ineligible: eligibility.reason } : {}),
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

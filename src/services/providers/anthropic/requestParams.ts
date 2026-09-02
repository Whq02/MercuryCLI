// providers/anthropic/requestParams — per-request parameter assembly: operator
// extra-body/metadata env passthrough, prompt-caching enablement, the
// cache_control TTL decision (Mercury's Cache Clock decides here; the
// session-latched eligibility keeps mid-session flips from busting the
// server cache), effort + task-budget output_config wiring, and API-key
// verification. Mercury-owned.

import {
  type BetaMessageParam as MessageParam,
  type BetaOutputConfig,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  getLastApiCompletionTimestamp,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
} from 'src/bootstrap/state.js'
import {
  EFFORT_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import { type QuerySource } from 'src/constants/querySource.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/featureGates.js'
import { type CacheScope } from '../../../utils/api.js'
import { getOauthAccountInfo, isClaudeAISubscriber } from '../../../utils/auth.js'
import {
  getModelBetas,
  modelSupportsTemperature,
  shouldIncludeFirstPartyOnlyBetas,
} from '../../../utils/betas.js'
import { cacheClockTtlDecision } from 'src/utils/cache/cacheClock.js'
import { getOrCreateUserID } from '../../../utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { modelSupportsEffort, type EffortValue } from 'src/utils/effort.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
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
import { currentLimits } from '../../claudeAiLimits.js'
import { getAnthropicClient } from '../../api/client.js'
import { CannotRetryError, withRetry } from '../../api/withRetry.js'
// Type-only import (erased at compile time, so no runtime cycle): the query
// Options vocabulary still lives on the stream-core barrel.
import type { Options } from './index.js'

// The value grammar for extra-body assembly: anything JSON, keyed at the top.
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

/**
 * Operator passthrough for request bodies: MERCURY_EXTRA_BODY (a JSON
 * object) is spread into every request, and provider-required beta headers
 * merge into its anthropic_beta
 * array without duplicating entries. Non-object env values are rejected
 * with a logged reason, never half-applied.
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  let result: JsonObject = {}

  const extraBodyStr = process.env.MERCURY_EXTRA_BODY
  if (extraBodyStr) {
    try {
      const parsed = safeParseJSON(extraBodyStr)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Copy before touching: safeParseJSON serves LRU-cached objects, so
        // writing into `parsed` directly would poison every later read of
        // the same env string.
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `MERCURY_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing MERCURY_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

/**
 * Caching kill-switches, resolved per model: one global env disable, plus
 * per-tier disables that match against the CURRENT default model of that
 * tier (not a substring — an explicit non-default model never matches).
 */
export function getPromptCachingEnabled(model: string): boolean {
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    if (model === getSmallFastModel()) return false
  }
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    if (model === getDefaultSonnetModel()) return false
  }
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    if (model === getDefaultOpusModel()) return false
  }

  return true
}

export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * 1h-TTL eligibility, computed once per session and latched in bootstrap
 * state. The latch is the point: an overage flip mid-session would change
 * cache_control on the next request and bust ~20K tokens of server-side
 * prompt cache. The base allowlist path and Mercury's Cache Clock share
 * this latch — the clock replaces the TTL DECISION, not eligibility.
 */
export function latched1hEligibility(): boolean {
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible = isClaudeAISubscriber() && !currentLimits.isUsingOverage
    setPromptCache1hEligible(userEligible)
  }
  return userEligible
}

/**
 * The TTL decision: does this request's cache_control carry ttl:'1h'?
 *
 * Decision order:
 *   1. Mercury's Cache Clock — the Mercury-owned
 *      adaptive policy. It exists because the base allowlist below is
 *      structurally dead in Mercury (its remote config never arrives), which
 *      silently pinned every session to 5m. A null verdict means the clock
 *      is not engaged (flag off, or ineligible without a pin) and the default
 *      path runs exactly as before.
 *   2. The default path: latched eligibility, then a querySource match against
 *      the remotely-configured allowlist ({allowlist: string[]}, trailing
 *      '*' = prefix match). The allowlist is ALSO session-latched so a disk
 *      cache refresh mid-request cannot mix TTLs within one session.
 */
export function should1hCacheTTL(querySource?: QuerySource): boolean {
  const clockTtl = cacheClockTtlDecision({
    eligible: latched1hEligibility(),
    lastCompletionAt: getLastApiCompletionTimestamp(),
    now: Date.now(),
  })
  if (clockTtl !== null) return clockTtl === '1h'

  if (!latched1hEligibility()) return false

  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('mercury_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}

/**
 * Wire effort into output_config + betas. No-ops when the model has no
 * effort support or the operator's extra-body already set one (their
 * output_config wins). An undefined effort still sends the beta header —
 * the API applies the model's default level; the deepthink turn floor
 * upstream resolves to a concrete level before this point when active.
 * Numeric EffortValue is presently not a wire shape and is dropped here,
 * loudly, so a future numeric ladder cannot silently no-op.
 */
export function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER)
  } else if (typeof effortValue === 'string') {
    outputConfig.effort = effortValue
    betas.push(EFFORT_BETA_HEADER)
  } else {
    logForDebugging(
      `configureEffortParams: numeric effort ${effortValue} has no wire encoding — sending without effort`,
      { level: 'warn' },
    )
  }
}

// output_config.task_budget — tells the model its token budget so it can
// pace the task. The Stainless SDK types lag this field, so the wire shape
// is declared here and cast at the assignment; the API validates receipt.
// Beta: task-budgets (first-party EAP).
export type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

/**
 * Request metadata: the user_id envelope (device + OAuth account + session),
 * extendable via MERCURY_EXTRA_METADATA (JSON object; rejected loudly
 * otherwise). The account UUID is present only while OAuth is the live
 * auth method — API-key sessions send an empty slot.
 */
export function getAPIMetadata() {
  let extra: JsonObject = {}
  const extraStr = process.env.MERCURY_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `MERCURY_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

/**
 * Prove an API key works with the cheapest possible call: one token from
 * the small/fast model. Non-interactive sessions skip the probe entirely
 * (print mode pays for a failed key with its own first request). Returns
 * false ONLY on the API's authentication_error envelope; every other
 * failure propagates — a network outage is not an invalid key.
 */
export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // Small/fast model on purpose: on first-party, non-Haiku models require
    // the CLI sysprompt prefix and this minimal call would 400.
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    return await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
          // biome-ignore lint/plugin: the key probe stays a bare one-token call by design
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            // 5-family models 400 on temperature's mere presence.
            ...(modelSupportsTemperature(model) && { temperature: 1 }),
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        // Verification is latency-sensitive: fewer retries than a real turn.
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } },
      ),
    )
  } catch (errorFromRetry) {
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

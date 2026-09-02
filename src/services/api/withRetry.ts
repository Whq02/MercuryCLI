import type Anthropic from '@anthropic-ai/sdk'

import type { SystemAPIErrorMessage } from '../../types/message.js'
import {
  apiKeyHelperFailedLast,
  clearApiKeyHelperCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isAnthropicOAuthSignInExpired,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isRevokedSignInText } from '../providers/credentialWall.js'
import { logError } from '../../utils/log.js'
import { createSystemAPIErrorMessage } from '../../utils/messages.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { checkFeatureGate_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { isMockRateLimitError } from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { APIConnectionError, APIError, APIUserAbortError } from './sdkErrors.js'
import { deepestErrorDetail, isStaleSocketCode } from './transportEvidence.js'

/**
 * The retry generator: classification, backoff, client rebuild, and model
 * fallback. It YIELDS user-visible "API error, retrying" system messages and
 * finally returns the operation's result — every backoff sleep is preceded
 * by a yielded notice.
 */

export const BASE_DELAY_MS = 500

const MAX_DELAY_MS = 32_000
const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000
const CONSECUTIVE_529_FALLBACK_THRESHOLD = 3

const OVERLOADED_TYPE_MARKER = '"type":"overloaded_error"'

/**
 * Only FOREGROUND query sources retry an overload: a background summary,
 * title or suggestion has nobody blocked on it, while its retries multiply
 * load on a saturated gateway by roughly an order of magnitude. New sources
 * default to NO retry — a source joins only when an operator is waiting on
 * its result. Byte-exact contract data.
 */
const FOREGROUND_QUERY_SOURCES = new Set([
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // The auto-mode security classifier's source tag; a second,
  // vendor-internal classifier source is compiled out to an empty spread in
  // this build.
  'auto_mode',
  ...([] as string[]),
])

export type RetryContext = {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
}

export class CannotRetryError extends Error {
  originalError: unknown
  retryContext: RetryContext

  constructor(originalError: unknown, retryContext: RetryContext) {
    const message =
      originalError instanceof Error ? originalError.message : String(originalError)
    super(message)
    this.name = 'RetryError'
    this.originalError = originalError
    this.retryContext = retryContext
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  originalModel: string
  fallbackModel: string

  constructor(originalModel: string, fallbackModel: string) {
    super(`Model fallback triggered: ${originalModel} → ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
    this.originalModel = originalModel
    this.fallbackModel = fallbackModel
  }
}

export function getDefaultMaxRetries(): number {
  const env = process.env.MERCURY_MAX_RETRIES
  if (env !== undefined && env !== '') {
    // An unparseable value yields a non-numeric bound — the loop body never
    // runs and the generator ends in the terminal throw. Deliberate; do not
    // "fix" it into a silent default.
    return Number.parseInt(env, 10)
  }
  return 10
}

// ---------------------------------------------------------------------------
// Header + classification helpers
// ---------------------------------------------------------------------------

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined
  }
  const record = headers as Record<string, string>
  return record[name] ?? record[name.toLowerCase()]
}

function errorHeaders(error: unknown): unknown {
  return (error as { headers?: unknown } | null)?.headers
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(error)
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

export function is529Error(error: unknown): boolean {
  return statusOf(error) === 529 || errorMessage(error).includes(OVERLOADED_TYPE_MARKER)
}

/**
 * ONLY the SDK's connection-error class (the timeout subclass included) —
 * a duplicate SDK copy yields the same class under a different identity,
 * recognised by name.
 * Never "any statusless non-API Error": the SDK's own auth-resolution
 * failure (no key/token configured) is exactly such an Error and must fail
 * the turn immediately, not retry ten times.
 */
function isConnectionErrorLike(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true
  if (!(error instanceof Error)) return false
  const className = error.constructor?.name
  return className === 'APIConnectionError' || className === 'APIConnectionTimeoutError'
}

/** Exported for the headless-deadline prover (a pure classifier). */
export function isStaleConnectionError(error: unknown): boolean {
  if (!isConnectionErrorLike(error)) return false
  return isStaleSocketCode(deepestErrorDetail(error).code)
}

/** The revoked-sign-in family, read through the credential wall's one
 *  needle (never a spelling of its own — the 401 drift that reopened the
 *  raw-JSON hole lived in a second copy of the phrase). */
function isRevokedTokenError(error: unknown): boolean {
  return statusOf(error) === 403 && isRevokedSignInText(errorMessage(error))
}

/** Exported for the auth-honesty prover (a pure classifier over error + the
 *  observed credential estate). */
export function isRetryableError(error: unknown): boolean {
  // Mocked rate-limit errors are NEVER retryable.
  if (isMockRateLimitError(error)) return false
  const status = statusOf(error)
  // The overload marker inside a streamed error body (status sometimes lost).
  if (errorMessage(error).includes(OVERLOADED_TYPE_MARKER)) return true
  if (parseMaxTokensContextOverflowError(error) !== undefined) return true
  // The server's non-standard retry hint. `true` is honoured only for
  // non-subscription accounts or enterprise subscribers (for consumer plans
  // the server's "retry" can mean hours away); `false` always wins.
  const shouldRetry = headerValue(errorHeaders(error), 'x-should-retry')
  if (shouldRetry === 'false') return false
  if (shouldRetry === 'true' && (!isClaudeAISubscriber() || isEnterpriseSubscriber())) return true
  if (isConnectionErrorLike(error)) return true
  if (status === 408 || status === 409) return true
  if (status !== undefined && status >= 500) return true
  if (status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }
  if (status === 401) {
    // A configured apiKeyHelper whose last execution FAILED sent no
    // credential at all: this 401 is the helper's failure in costume, and
    // every retry lap would re-run the helper under its ten-minute budget
    // before the same 401 (FN-015 rank 48). Fail fast into the line that
    // names the helper; the cache clear below still makes the next turn
    // re-run it.
    const helperFailed = apiKeyHelperFailedLast()
    clearApiKeyHelperCache()
    if (helperFailed) return false
    // One recovery lap is owed — the rebuild path refreshes the stored OAuth
    // token in place and the next attempt carries the new bearer. But once
    // the estate has OBSERVED the sign-in dead (invalid_grant blanked the
    // refresh token, or it expired with nothing to spend), every further lap
    // re-401s through the whole backoff ladder — the operator's "loads
    // forever, then a vague failure". Fail fast into the attributed line.
    if (isAnthropicOAuthSignInExpired()) return false
    return true
  }
  if (isRevokedTokenError(error)) return true
  return false
}

// ---------------------------------------------------------------------------
// Max-tokens context overflow
// ---------------------------------------------------------------------------

const OVERFLOW_SUBSTRING = 'input length and `max_tokens` exceed context limit'
const OVERFLOW_PATTERN =
  /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/

export function parseMaxTokensContextOverflowError(
  error: unknown,
): { inputTokens: number; maxTokens: number; contextLimit: number } | undefined {
  if (statusOf(error) !== 400) return undefined
  const message = errorMessage(error)
  if (message === '') return undefined
  if (!message.includes(OVERFLOW_SUBSTRING)) return undefined
  const match = OVERFLOW_PATTERN.exec(message)
  if (!match) return undefined
  return {
    inputTokens: Number.parseInt(match[1] as string, 10),
    maxTokens: Number.parseInt(match[2] as string, 10),
    contextLimit: Number.parseInt(match[3] as string, 10),
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs: number = MAX_DELAY_MS,
): number {
  if (retryAfterHeader !== undefined && retryAfterHeader !== null && retryAfterHeader !== '') {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds) && seconds > 0) {
      // Clamped to a hard 6-hour ceiling so a mis-set gateway cannot sleep
      // unbounded.
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
  }
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), maxDelayMs)
  return base + Math.random() * 0.25 * base
}

function retryAfterOf(error: unknown): string | undefined {
  return headerValue(errorHeaders(error), 'retry-after')
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

type WithRetryOptions = {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  signal?: AbortSignal
  querySource?: string
  initialConsecutive529Errors?: number
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, retryContext: RetryContext) => Promise<T>,
  options: WithRetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = options.maxRetries ?? getDefaultMaxRetries()

  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
  }

  let client: Anthropic | null = null
  let lastError: unknown
  let previousError: unknown
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) throw new APIUserAbortError()

    // (Re)build the client when: none yet; the previous error was a 401 /
    // revoked-token 403 / stale connection.
    const previousStatus = statusOf(previousError)
    const needsRebuild =
      client === null ||
      previousStatus === 401 ||
      isRevokedTokenError(previousError) ||
      isStaleConnectionError(previousError)
    if (needsRebuild) {
      if (previousStatus === 401 || isRevokedTokenError(previousError)) {
        // Recover the credential before rebuilding — the standard refresh
        // path (handleOAuth401Error) refreshes the stored token in place.
        const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
        if (failedAccessToken !== undefined) {
          await handleOAuth401Error(failedAccessToken).catch(() => false)
        }
      }
      if (isStaleConnectionError(previousError)) {
        if (checkFeatureGate_CACHED_MAY_BE_STALE('mercury_disable_keepalive_on_econnreset')) {
          disableKeepAlive()
        }
      }
      client = await getClient()
    }

    try {
      return await operation(client as Anthropic, attempt, retryContext)
    } catch (error) {
      lastError = error
      previousError = error
      if (error instanceof APIError) {
        logForDebugging(`API error (attempt ${attempt}): ${error.status} ${error.message}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`API error (attempt ${attempt}): ${errorMessage(error)}`, {
          level: 'error',
        })
      }

      const status = statusOf(error)
      const overload = is529Error(error)

      // --- The non-foreground overload bail.
      if (overload) {
        const source = options.querySource
        if (source !== undefined && !FOREGROUND_QUERY_SOURCES.has(source)) {
          throw new CannotRetryError(error, retryContext)
        }
      }

      // --- Consecutive-overload counting and model fallback.
      if (overload) {
        const countingEnabled =
          Boolean(process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS) ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(retryContext.model))
        if (countingEnabled) {
          consecutive529Errors++
          if (consecutive529Errors >= CONSECUTIVE_529_FALLBACK_THRESHOLD) {
            if (options.fallbackModel !== undefined) {
              throw new FallbackTriggeredError(retryContext.model, options.fallbackModel)
            }
            if (!isEnvTruthy(process.env.IS_SANDBOX)) {
              // A SYNTHETIC error carrying the repeated-overload constant —
              // the class string keys off it.
              throw new CannotRetryError(new Error(REPEATED_529_ERROR_MESSAGE), retryContext)
            }
          }
        }
      } else {
        consecutive529Errors = 0
      }

      // --- Attempt exhaustion (before the retryable gate; both throw the
      // same wrapper, only the wrapped error differs).
      if (attempt > maxRetries) {
        throw new CannotRetryError(error, retryContext)
      }

      // --- The retryable gate.
      if (!isRetryableError(error)) {
        throw new CannotRetryError(error, retryContext)
      }

      // --- Max-tokens overflow adjustment: retry immediately, no backoff,
      // no notice.
      const overflow = parseMaxTokensContextOverflowError(error)
      if (overflow !== undefined) {
        const SAFETY_BUFFER = 1000
        const FLOOR = 3000
        const available = Math.max(0, overflow.contextLimit - overflow.inputTokens - SAFETY_BUFFER)
        if (available < FLOOR) {
          // No room to succeed: the one path that escapes without the
          // cannot-retry wrapper.
          logError(
            new Error(
              `max_tokens overflow unrecoverable: available context ${available} is under the ${FLOOR} floor`,
            ),
          )
          throw error
        }
        const thinkingBudget =
          retryContext.thinkingConfig.type === 'enabled'
            ? (retryContext.thinkingConfig as { budget_tokens?: number }).budget_tokens ?? 0
            : 0
        const minRequired = thinkingBudget > 0 ? thinkingBudget + 1 : 1
        retryContext.maxTokensOverride = Math.max(FLOOR, available, minRequired)
        continue
      }

      // --- Backoff.
      const delayMs = getRetryDelay(attempt, retryAfterOf(error))
      yield createSystemAPIErrorMessage(
        error instanceof Error ? error : new Error(errorMessage(error)),
        delayMs,
        attempt,
        maxRetries,
      )
      await sleep(delayMs, options.signal)
    }
  }

  // Falling out of the loop: the terminal cannot-retry throw. The never-ran
  // case (an unparseable MERCURY_MAX_RETRIES makes the guard false on its
  // first evaluation — deliberate, see getDefaultMaxRetries) names ITS OWN
  // cause: 'retry attempts exhausted' blamed exhaustion for a turn that made
  // ZERO requests, and the operator went tuning retries instead of the
  // variable (TASK-017 S2, max-retries-nan-zero-attempts).
  const zeroAttempts = !(1 <= maxRetries + 1)
  throw new CannotRetryError(
    lastError ??
      new Error(
        zeroAttempts
          ? `MERCURY_MAX_RETRIES=${process.env.MERCURY_MAX_RETRIES ?? ''} is not a non-negative integer — no request was attempted; unset it or set a number`
          : 'retry attempts exhausted',
      ),
    retryContext,
  )
}

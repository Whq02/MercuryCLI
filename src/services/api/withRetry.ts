import { OUTPUT_FIT_FLOOR_TOKENS, OUTPUT_FIT_HEADWAY_TOKENS } from './outputFit.js'
import { isBedrockThrottle } from './bedrockThrottle.js'
import type { AnthropicClient as Anthropic } from '../providers/anthropic/anthropicClient.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'

import type { FailoverCause, SystemAPIErrorMessage } from '../../types/message.js'
import {
  apiKeyHelperFailedLast,
  clearApiKeyHelperCache,
  getApiKeyFromApiKeyHelperCached,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { handleOAuth401Error } from '../auth/oauthLifecycle.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRevokedSignInText } from '../providers/credentialWall.js'
import { logError } from '../../utils/log.js'
import { createSystemAPIErrorMessage } from '../messages.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { isMockRateLimitError } from '../rateLimitMocking.js'
import { heldBusyRetryWait, nextBusyRetry, openBusyRetryLadder, takesBusyLadder, type BusyRetryLadder, type HeldBusyRetryWait } from '../providers/busyRetry.js'
import { EMPTY_STREAM_TRIES, emptyStreamRetryNotice, emptyStreamRetryWaitMs, emptyStreamSpentWords, isEmptyStreamFault } from '../providers/emptyStreamRetry.js'
import { requestWaitLine, retryNoticeWait, retryReasonWords, streamReconnectWait, type RequestWaitV1 } from '../providers/streamIdleBudget.js'
import { isClientContractRefusalError } from '../../utils/api/clientContractGate.js'
import { cacheDiagnosticsRefusal, isCacheDiagnosticsRefusal, refuseCacheDiagnostics } from '../providers/anthropic/cacheDiagnostics.js'
import { healClientContractRefusal, noteClientContractHeal, type ClientContractHeal } from './clientContractLearned.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { isSdkConnectionError as isConnectionErrorLike, NetworkOutageError, nextReconnect, openReconnectLadder, outageCauseOf, ReconnectBudgetSpentError, streamReconnectCause, type OutageCause, type ReconnectLadder } from './reconnectLadder.js'
import { isSpentUsageWindowAnswer, providerAskedWaitMs, providerWaitIsWindow, retrySeconds } from './recoveryBudget.js'
import { errorHeaders, headerValue, retryAfterHeaderMs, retryAfterOf } from './retryAfter.js'
import { jitterRetryDelay } from './retryJitter.js'
import { APIError, APIUserAbortError } from '../../utils/api/sdkErrors.js'
import { deepestErrorDetail, isStaleSocketCode, transportCutOf, transportCutWords } from '../../utils/api/transportEvidence.js'
import { messageEffortRefusedBy } from '../providers/anthropic/messageEffort.js'
import { passedOverAs } from '../../utils/passedOver.js'


const BASE_DELAY_MS = 500

const MAX_DELAY_MS = 32_000
const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000
const CONSECUTIVE_529_FALLBACK_THRESHOLD = 3

const OVERLOADED_TYPE_MARKER = '"type":"overloaded_error"'

const FOREGROUND_QUERY_SOURCES = new Set([
  'main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
])

export function isForegroundQuerySource(source: string): boolean {
  return FOREGROUND_QUERY_SOURCES.has(source) || source.startsWith('agent:')
}

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
  trigger: FailoverCause

  constructor(originalModel: string, fallbackModel: string, trigger: FailoverCause = 'overloaded') {
    super(`Model fallback triggered: ${originalModel} → ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
    this.originalModel = originalModel
    this.fallbackModel = fallbackModel
    this.trigger = trigger
  }
}

function getDefaultMaxRetries(): number {
  const env = flagEnv('MERCURY_MAX_RETRIES')
  if (env !== undefined && env !== '') {
    return Number.parseInt(env, 10)
  }
  return 10
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

export function isStaleConnectionError(error: unknown): boolean {
  if (transportCutOf(error) !== null) return true
  if (!isConnectionErrorLike(error)) return false
  return isStaleSocketCode(deepestErrorDetail(error).code)
}

function isRevokedTokenError(error: unknown): boolean {
  return statusOf(error) === 403 && isRevokedSignInText(errorMessage(error))
}

export function isRetryableError(error: unknown): boolean {
  if (isMockRateLimitError(error)) return false
  const status = statusOf(error)
  if (status === 401) {
    clearApiKeyHelperCache()
    return false
  }
  if (isRevokedTokenError(error)) return false
  if (providerWaitIsWindow(providerAskedWaitMs(error))) return false
  const shouldRetry = headerValue(errorHeaders(error), 'x-should-retry')
  if (shouldRetry === 'false') return false
  if (errorMessage(error).includes(OVERLOADED_TYPE_MARKER)) return true
  if (parseMaxTokensContextOverflowError(error) !== undefined) return true
  if (shouldRetry === 'true' && (!isClaudeAISubscriber() || isEnterpriseSubscriber())) return true
  if (isConnectionErrorLike(error)) return true
  if (transportCutOf(error) !== null) return true
  if (status === 408 || status === 409) return true
  if (status !== undefined && status >= 500) return true
  if (isBedrockThrottle(error)) return true
  if (status === 429) {
    if (isClaudeAISubscriber() && !isEnterpriseSubscriber() && isSpentUsageWindowAnswer(error)) return false
    return true
  }
  return false
}


const OVERFLOW_SUBSTRING = 'input length and `max_tokens` exceed context limit'
const OVERFLOW_PATTERN =
  /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/

function parseMaxTokensContextOverflowError(
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


export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs: number = MAX_DELAY_MS,
): number {
  const asked = retryAfterHeaderMs(retryAfterHeader)
  if (asked !== undefined) return Math.min(asked, MAX_RETRY_AFTER_MS)
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), maxDelayMs)
  return jitterRetryDelay(base)
}


type WithRetryOptions = {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  signal?: AbortSignal
  querySource?: string
  initialConsecutive529Errors?: number
  onHeldWait?: (wait: HeldBusyRetryWait) => void
  healClientContract?: boolean
  reconnect?: boolean
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
  let authenticationRecoveryAttempted = false
  let contractHealTried = false
  let contractHeal: ClientContractHeal | undefined
  let busy: BusyRetryLadder | undefined
  let reconnect: ReconnectLadder | undefined

  for (let attempt = 1; attempt <= maxRetries + 1 || busy !== undefined; attempt++) {
    if (options.signal?.aborted) throw new APIUserAbortError()

    if (client === null || isStaleConnectionError(previousError)) {
      if (isStaleConnectionError(previousError)) {
        disableKeepAlive()
      }
      client = await getClient()
    }
    const failedAccessToken = client.authToken
    const failedHelperToken = !failedAccessToken && getAuthTokenSource().source === 'credentials.keyCommand'
      ? getApiKeyFromApiKeyHelperCached()
      : null

    try {
      return await operation(client as Anthropic, attempt, retryContext)
    } catch (error) {
      lastError = error
      previousError = error
      if (error instanceof APIError) {
        const prefix = error.status !== undefined ? `${error.status} ` : ''
        logForDebugging(`API error (attempt ${attempt}): ${prefix}${error.message}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`API error (attempt ${attempt}): ${errorMessage(error)}`, {
          level: 'error',
        })
      }

      const outage = maxRetries === 0 || options.reconnect === false ? null : outageCauseOf(error)
      if (outage !== null) {
        const now = Date.now()
        const ladder = reconnect ?? openReconnectLadder(now, outage)
        reconnect = ladder
        const step = nextReconnect(ladder, outage, now)
        yield createSystemAPIErrorMessage(new NetworkOutageError(step, error), step.waitMs, step.reconnect, step.of)
        if (step.waitMs <= 0) {
          throw new CannotRetryError(new ReconnectBudgetSpentError(ladder, now, error), retryContext)
        }
        await paused(step.waitMs, options.signal)
        attempt--
        continue
      }

      const status = statusOf(error)
      if (status !== undefined) reconnect = undefined
      if (status === 401 || isRevokedTokenError(error)) {
        const helperFailed = apiKeyHelperFailedLast()
        clearApiKeyHelperCache()
        if (!authenticationRecoveryAttempted && !helperFailed && attempt <= maxRetries) {
          authenticationRecoveryAttempted = true
          const current = await getClient()
          if ((current.apiKey || current.authToken) && (current.apiKey !== client.apiKey || current.authToken !== client.authToken)) {
            client = current
            continue
          }
          if (failedAccessToken && getAuthTokenSource().source === 'claude.ai') {
            const refreshed = await handleOAuth401Error(failedAccessToken).catch(passedOverAs(false))
            const accessToken = getClaudeAIOAuthTokens()?.accessToken
            if (refreshed && accessToken && accessToken !== failedAccessToken) {
              client = await getClient()
              if (client.authToken && client.authToken !== failedAccessToken) continue
            }
          } else if (failedHelperToken) {
            client = await getClient()
            const helperToken = getApiKeyFromApiKeyHelperCached()
            if (!apiKeyHelperFailedLast() && helperToken && helperToken !== failedHelperToken) continue
          }
        }
        if (options.signal?.aborted) throw new APIUserAbortError()
        throw new CannotRetryError(error, retryContext)
      }
      const overload = is529Error(error)

      if (overload) {
        const source = options.querySource
        if (source !== undefined && !isForegroundQuerySource(source)) {
          throw new CannotRetryError(error, retryContext)
        }
      }

      if (overload) {
        const countingEnabled =
          flagEnabled('MERCURY_FALLBACK_ALL_MODELS') ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(retryContext.model))
        if (countingEnabled) consecutive529Errors++
      } else {
        consecutive529Errors = 0
      }

      if (cacheDiagnosticsRefusal() === null && isCacheDiagnosticsRefusal(error)) {
        refuseCacheDiagnostics(errorMessage(error))
        logForDebugging(`cache diagnostics: the provider refused the diagnostics field (${errorMessage(error)}); this process sends it no more and the request goes out again without it`, { level: 'warn' })
        continue
      }

      if (messageEffortRefusedBy(error)) {
        logForDebugging(`per-message effort: the provider refused the request that carried it (${errorMessage(error)}); this process sends it no more and the request goes out again without it`, { level: 'warn' })
        attempt--
        continue
      }

      if (options.healClientContract === true && isClientContractRefusalError(error)) {
        if (!contractHealTried && attempt <= maxRetries) {
          contractHealTried = true
          contractHeal = await healClientContractRefusal(error, options.signal).catch(passedOverAs(undefined))
          logForDebugging(`client contract: the too-old refusal met ${contractHeal?.kind ?? 'no heal'}`)
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (contractHeal?.kind === 'retry') continue
        }
        if (contractHeal !== undefined) noteClientContractHeal(error, contractHeal)
        throw new CannotRetryError(error, retryContext)
      }

      if (overload && isRetryableError(error)) {
        const ladder = busy ?? openBusyRetryLadder(Date.now())
        busy = ladder
        const step = nextBusyRetry(ladder, providerAskedWaitMs(error), Date.now())
        if (step === null) {
          if (options.fallbackModel !== undefined) {
            throw new FallbackTriggeredError(retryContext.model, options.fallbackModel, 'overloaded')
          }
          if (consecutive529Errors >= CONSECUTIVE_529_FALLBACK_THRESHOLD) {
            throw new CannotRetryError(new Error(REPEATED_529_ERROR_MESSAGE), retryContext)
          }
          throw new CannotRetryError(error, retryContext)
        }
        const notice = createSystemAPIErrorMessage(
          error instanceof Error ? error : new Error(errorMessage(error)),
          step.waitMs,
          step.attempt,
          step.of,
        )
        if (!step.quiet) yield notice
        else options.onHeldWait?.(heldBusyRetryWait(step, notice))
        await paused(step.waitMs, options.signal)
        continue
      }

      if (attempt > maxRetries) {
        throw new CannotRetryError(error, retryContext)
      }

      if (!isRetryableError(error)) {
        throw new CannotRetryError(error, retryContext)
      }

      const overflow = parseMaxTokensContextOverflowError(error)
      if (overflow !== undefined) {
        const FLOOR = OUTPUT_FIT_FLOOR_TOKENS
        const available = Math.max(0, overflow.contextLimit - overflow.inputTokens - OUTPUT_FIT_HEADWAY_TOKENS)
        if (available < FLOOR) {
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

      const delayMs = getRetryDelay(attempt, retryAfterOf(error))
      const cut = transportCutOf(error)
      yield createSystemAPIErrorMessage(
        cut !== null
          ? Object.assign(new Error(`${transportCutWords('The provider', cut)}; retrying on a fresh connection`), { cause: error })
          : error instanceof Error ? error : new Error(errorMessage(error)),
        delayMs,
        attempt,
        maxRetries,
      )
      await paused(delayMs, options.signal)
    }
  }

  const zeroAttempts = !(1 <= maxRetries + 1)
  throw new CannotRetryError(
    lastError ??
      new Error(
        zeroAttempts
          ? `MERCURY_MAX_RETRIES=${flagEnv('MERCURY_MAX_RETRIES') ?? ''} is not a non-negative integer — no request was attempted; unset it or set a number`
          : 'retry attempts exhausted',
      ),
    retryContext,
  )
}

function paused(waitMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  return sleep(waitMs, signal).then(() => signal?.aborted !== true)
}

export type RetryFault = {
  kind: string
  code: string
  message: string
  retryable: boolean
  status?: number
  retryAfterMs?: number
  outage?: OutageCause
  inStream?: true
  silentMs?: number
}

export type RetryVerdict =
  | { kind: 'again' | 'cancelled' | 'spent' | 'stream-reconnect-spent' }
  | { kind: 'outage-spent'; line: string }

type TurnRetryRoad = {
  signal: AbortSignal
  maxAttempts: number
  backoffMs: (attempt: number) => number
  provider: string
  log: string
  agent: boolean
  singleShot: boolean
  streamReconnect?: boolean
  onWait?: (wait: RequestWaitV1 | null) => void
}

type FaultFacts = {
  typed: string
  retryEligible: boolean
  invisibleOnly?: boolean
  reissue?: boolean
}

export type TurnRetries<F extends RetryFault> = {
  readonly attempt: number
  readonly left: boolean
  readonly busy: { ladder: BusyRetryLadder; fault: F } | undefined
  readonly emptyEnd: boolean
  next(): boolean
  uncounted(): void
  afterFault(fault: F, facts: FaultFacts): AsyncGenerator<SystemAPIErrorMessage, RetryVerdict>
}

function faultNoticeError(fault: RetryFault): Error {
  const askedMs = fault.retryAfterMs
  return Object.assign(new Error(fault.message), {
    ...(fault.status !== undefined ? { status: fault.status } : {}),
    ...(askedMs !== undefined ? { headers: { 'retry-after': String(Math.ceil(askedMs / 1000)) } } : {}),
  })
}

export async function* retryEmptyStream(
  counter: { emptyStreamEnds: number },
  road: { provider: string; detail: string; cause?: unknown; log: string; signal: AbortSignal; onWait?: (wait: RequestWaitV1 | null) => void; whilePaused?: () => void },
): AsyncGenerator<SystemAPIErrorMessage, 'again' | 'cancelled' | 'spent'> {
  counter.emptyStreamEnds++
  if (counter.emptyStreamEnds >= EMPTY_STREAM_TRIES) return 'spent'
  road.whilePaused?.()
  const waitMs = emptyStreamRetryWaitMs()
  const notice = emptyStreamRetryNotice({ provider: road.provider, detail: road.detail, ...(road.cause !== undefined ? { cause: road.cause } : {}), attempt: counter.emptyStreamEnds + 1, waitMs })
  logForDebugging(`${road.log}${notice.error.message} — retrying in ${retrySeconds(waitMs)} (attempt ${counter.emptyStreamEnds + 1} of ${EMPTY_STREAM_TRIES})`, { level: 'warn' })
  yield notice
  road.onWait?.(retryNoticeWait(notice))
  return (await paused(waitMs, road.signal)) ? 'again' : 'cancelled'
}

export function openTurnRetries<F extends RetryFault>(road: TurnRetryRoad): TurnRetries<F> {
  const { signal, log } = road
  const startedAtMs = Date.now()
  const counter = { emptyStreamEnds: 0 }
  const again: RetryVerdict = { kind: 'again' }
  const cancelled: RetryVerdict = { kind: 'cancelled' }
  let attempt = 0
  let busy: { ladder: BusyRetryLadder; fault: F } | undefined
  let reconnect: ReconnectLadder | undefined
  let emptyEnd = false
  let rateLimited = false

  async function* afterFault(fault: F, facts: FaultFacts): AsyncGenerator<SystemAPIErrorMessage, RetryVerdict> {
    const askedMs = fault.retryAfterMs
    const wireDetail = fault.message ? `${fault.code}: ${fault.message}` : fault.code
    const eligible = facts.retryEligible && !road.singleShot
    const ladders = eligible && facts.invisibleOnly !== true
    const streamCut = road.streamReconnect === true && ladders ? streamReconnectCause(fault) : null
    if (streamCut !== null) {
      const now = Date.now()
      const ladder = reconnect ?? openReconnectLadder(now, streamCut)
      reconnect = ladder
      const step = nextReconnect(ladder, streamCut, now)
      if (step.waitMs <= 0) return { kind: 'stream-reconnect-spent' }
      const wait = streamReconnectWait(step.reconnect, step.of, step.waitMs, fault.silentMs)
      const notice = createSystemAPIErrorMessage(Object.assign(new Error(requestWaitLine(wait)), { streamWait: wait }), step.waitMs, step.reconnect, step.of)
      road.onWait?.(wait)
      yield notice
      if (!(await paused(step.waitMs, signal))) {
        road.onWait?.(null)
        return cancelled
      }
      attempt--
      return again
    }
    const outage = ladders ? fault.outage : undefined
    if (outage !== undefined) {
      const now = Date.now()
      const ladder = reconnect ?? openReconnectLadder(now, outage)
      reconnect = ladder
      const step = nextReconnect(ladder, outage, now)
      const notice = createSystemAPIErrorMessage(new NetworkOutageError(step, Object.assign(new Error(fault.message), { code: outage.code })), step.waitMs, step.reconnect, step.of)
      logForDebugging(`${log} network outage (${wireDetail}) — ${notice.error.message}`)
      yield notice
      road.onWait?.({ kind: 'retry', attempt: step.reconnect, of: step.of, reason: retryReasonWords(undefined, notice.error.message), delayMs: step.waitMs, sinceMs: now })
      if (step.waitMs <= 0) return { kind: 'outage-spent', line: new ReconnectBudgetSpentError(ladder, now, undefined).message }
      if (!(await paused(step.waitMs, signal))) return cancelled
      attempt--
      return again
    }
    if (fault.status !== undefined) reconnect = undefined
    const waits = ladders && facts.reissue !== true && !providerWaitIsWindow(askedMs)
    if (waits && takesBusyLadder(fault)) {
      const ladder = busy?.ladder ?? openBusyRetryLadder(Date.now())
      busy = { ladder, fault }
      const step = nextBusyRetry(ladder, askedMs, Date.now())
      if (step !== null) {
        logForDebugging(`${log} busy refusal (${wireDetail}) — retry ${step.attempt} of ${step.of} after ${retrySeconds(step.waitMs)}${step.quiet ? ' inside the quiet window' : ''}`)
        const notice = createSystemAPIErrorMessage(faultNoticeError(fault), step.waitMs, step.attempt, step.of)
        if (!step.quiet) {
          yield notice
          road.onWait?.(retryNoticeWait(notice))
        } else if (road.agent) road.onWait?.(heldBusyRetryWait(step, notice))
        return (await paused(step.waitMs, signal)) ? again : cancelled
      }
      logForDebugging(`${log} busy refusal (${wireDetail}) — the retry ladder is spent after ${ladder.waitsMs.length} retries and ${retrySeconds(ladder.spentMs)} of waiting`)
    } else if (waits && fault.retryable && facts.typed === 'rate_limit') {
      const maxRetries = getDefaultMaxRetries()
      if (!(attempt <= maxRetries)) return { kind: 'spent' }
      rateLimited = true
      const delayMs = getRetryDelay(attempt, askedMs === undefined ? null : String(askedMs / 1000))
      logForDebugging(`${log} rate limit (${wireDetail}) — retry ${attempt} of ${maxRetries} after ${retrySeconds(delayMs)}`)
      const notice = createSystemAPIErrorMessage(faultNoticeError(fault), delayMs, attempt, maxRetries)
      yield notice
      road.onWait?.(retryNoticeWait(notice))
      return (await paused(delayMs, signal)) ? again : cancelled
    }
    emptyEnd = busy === undefined && ladders && facts.reissue !== true && isEmptyStreamFault(fault)
    if (emptyEnd) {
      const empty = yield* retryEmptyStream(counter, { provider: road.provider, detail: fault.code, log: `${log} `, signal, ...(road.onWait !== undefined ? { onWait: road.onWait } : {}) })
      if (empty === 'cancelled') return cancelled
      if (empty === 'again') {
        attempt--
        return again
      }
      logForDebugging(`${log} ${emptyStreamSpentWords(road.provider, Date.now() - startedAtMs)} (${wireDetail})`, { level: 'error' })
    }
    const retryable = !emptyEnd && !providerWaitIsWindow(askedMs) && (facts.reissue === true || (busy === undefined && eligible && fault.retryable && attempt < road.maxAttempts))
    if (!retryable) return { kind: 'spent' }
    const delayMs = Math.max(road.backoffMs(attempt), askedMs ?? 0)
    const notice = createSystemAPIErrorMessage(faultNoticeError(fault), delayMs, attempt, road.maxAttempts - 1)
    yield notice
    road.onWait?.(retryNoticeWait(notice))
    return (await paused(delayMs, signal)) ? again : cancelled
  }

  return {
    get attempt() {
      return attempt
    },
    get left() {
      return attempt < road.maxAttempts
    },
    get busy() {
      return busy
    },
    get emptyEnd() {
      return emptyEnd
    },
    next: () => ++attempt <= road.maxAttempts || busy !== undefined || rateLimited,
    uncounted: () => {
      attempt--
    },
    afterFault,
  }
}

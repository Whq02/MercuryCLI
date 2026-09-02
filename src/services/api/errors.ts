import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages'

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { AFK_MODE_BETA_HEADER } from '../../constants/betas.js'
import { describeAnthropicClientContract } from '../../constants/oauth.js'
import { API_PDF_MAX_PAGES, PDF_TARGET_RAW_SIZE } from '../../constants/apiLimits.js'
import type { AssistantMessage, AssistantMessageError, Message } from '../../types/message.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyHelperFailure,
  getAuthTokenSource,
  hasStoredOAuthToken,
  isClaudeAISubscriber,
  isAnthropicOAuthSignInExpired,
} from '../../utils/auth.js'
import { formatFileSize } from '../../utils/format.js'
import { isEnvShadowedAuthSource } from '../../utils/loginShadow.js'
import { logForDebugging } from '../../utils/debug.js'
import { createAssistantAPIErrorMessage, NO_RESPONSE_REQUESTED } from '../../utils/messages.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { classifyCredentialWall, credentialWallLine, isRevokedSignInText } from '../providers/credentialWall.js'
import { classifyOverflowFault, type OverflowFamily } from './overflowSignal.js'
import type { ClaudeAILimits, OverageDisabledReason, QuotaStatus } from '../claudeAiLimits.js'
import { getRateLimitErrorMessage } from '../claudeAiLimits.js'
import { composeAnthropicWallRemedies } from '../rateLimitMessages.js'
import { shouldProcessRateLimits } from '../rateLimitMocking.js'
import {
  extractConnectionErrorDetails as connectionDetailsFor,
  formatAPIError as formatConnectionFallback,
} from './errorUtils.js'
import { ImageResizeError } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../../utils/imageValidation.js'

/**
 * The error taxonomy: raw provider errors → typed assistant error messages,
 * analytics class strings, and the stream-fault/PTL/media predicates.
 */

// ---------------------------------------------------------------------------
// Constants (this slice's own copy; several are matched by the classifier so
// Mercury-synthesised messages classify correctly on the way back through)
// ---------------------------------------------------------------------------

export const API_ERROR_MESSAGE_PREFIX = 'API Error'

/**
 * The typed sentence for a response frame that does not carry the body its
 * own type promises (a `content_block_start` without a `content_block`, a
 * delta frame without its `delta`). One owner: every per-frame decoder that
 * must give up on a malformed frame throws THIS sentence, naming the frame
 * and what was expected — never a raw `Cannot read properties of undefined`
 * TypeError, which one live console ask painted verbatim as its reply row
 * (the answer-seam sighting). The wire named is the one the decoder speaks:
 * a gateway that answers in another vendor's frame layout earns this exact
 * diagnosis.
 */
export function malformedStreamFrameText(
  frameType: string,
  missingField: string,
): string {
  return (
    `the model stream returned a '${frameType}' frame without its '${missingField}' body — ` +
    `the endpoint did not answer in the Anthropic stream shape this lane decodes, so the frame cannot be read`
  )
}

export const STREAM_FAULT_AFTER_PARTIAL_MARKER = 'stream fault after partial content'

/**
 * The bounded-continuation instruction injected into the conversation after
 * a continuable stream fault. The classifier is an identity test against
 * this constant, which is what lets transcript lookups recognise "this fault
 * was recovered".
 */
export const STREAM_FAULT_RECOVERY_NUDGE =
  'The provider stream dropped mid-response after partial content. ' +
  'Pick up exactly where your output stopped rather than restarting. Do not apologise ' +
  'and do not restate anything you already produced. Finish the outstanding work and ' +
  'end with a complete final message.'

export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'

/** The logged-out state: there is no key to be invalid — the message states
 *  the not-logged-in fact and points at /logins. */
export const INVALID_API_KEY_ERROR_MESSAGE =
  'Not logged in · Please run /logins'

export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  'Invalid API key · Fix external API key'

export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY =
  'The organization associated with ANTHROPIC_API_KEY has been disabled. Update or unset the ANTHROPIC_API_KEY environment variable.'

export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH =
  'The organization associated with ANTHROPIC_API_KEY has been disabled. Unset the ANTHROPIC_API_KEY environment variable to use your subscription instead.'

export const TOKEN_REVOKED_ERROR_MESSAGE =
  'Your account does not have access to Mercury. Log in again, or contact your administrator.'

export const REPEATED_529_ERROR_MESSAGE =
  'Repeated API overload errors (529). The provider is under sustained load; try again shortly.'

export const CUSTOM_OFF_SWITCH_MESSAGE =
  'The top-tier model is currently experiencing high load. Switch to the mid-tier model with /model for faster responses.'

export const API_TIMEOUT_ERROR_MESSAGE =
  'Request timed out. Check your internet connection and proxy settings.'

export const OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE =
  'Your organization does not have access to Mercury. Log in again, or contact your administrator.'

// SDK-emitted strings recognised by equality — interoperability contract.
const SDK_REQUEST_ABORTED_MESSAGE = 'Request was aborted.'

// Provider-emitted substrings — interoperability contract data.
const OVERLOADED_TYPE_MARKER = '"type":"overloaded_error"'
const ADJACENCY_PHRASE = '`tool_use` ids were found without `tool_result` blocks immediately after'
const UNEXPECTED_TOOL_RESULT_PHRASE = 'unexpected `tool_use_id` found in `tool_result`'
const DUPLICATE_TOOL_USE_PHRASE = '`tool_use` ids must be unique'
const PDF_PASSWORD_PHRASE = 'The PDF specified is password protected'
const PDF_INVALID_PHRASE = 'The PDF specified was not valid'
const CREDIT_BALANCE_PROVIDER_PHRASE = 'Your credit balance is too low'
const OAUTH_ORG_NOT_ALLOWED_PHRASE =
  'OAuth authentication is currently not allowed for this organization'
const LONG_CONTEXT_EXTRA_USAGE_PHRASE = 'Extra usage is required for long context'
const PDF_PAGES_PATTERN = /maximum of \d+ PDF pages/

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : ''
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof APIError && typeof error.status === 'number') return error.status
  return undefined
}

function isConnectionError(error: unknown): boolean {
  return error instanceof APIConnectionError
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return true
  return isConnectionError(error) && messageOf(error).toLowerCase().includes('timeout')
}

/** The hosted-remote-backend predicate is permanently false. */
function isHostedRemoteBackend(): boolean {
  return false
}

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

/** The family a session model routes to, for the credential wall's words.
 *  Late require: this error surface must not pull the route law at load;
 *  a broken projection names the home lane. */
function routeOfModel(model: string): string {
  try {
    const { declaredRouteOf } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    // At an error surface the wire ANSWERED — a stranger's answering wire
    // can only be the earned gateway, so the attribution word says so.
    return declaredRouteOf(model) ?? 'gateway'
  } catch {
    return 'anthropic'
  }
}

/** The family's display name for an attributed sentence ("<Family> says:
 *  …") — the one display-name owner, never a hand spelling. */
function providerNameOfModel(model: string): string {
  const route = routeOfModel(model)
  try {
    const { providerDisplayName } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    return providerDisplayName(route)
  } catch {
    return route
  }
}

// ---------------------------------------------------------------------------
// Interactive/non-interactive message getters
// ---------------------------------------------------------------------------

export function getPdfTooLargeErrorMessage(): string {
  const limits = `PDFs are limited to ${API_PDF_MAX_PAGES} pages and ${formatFileSize(PDF_TARGET_RAW_SIZE)}.`
  if (getIsNonInteractiveSession()) {
    return `The PDF is too large for the API. ${limits} Try reading the file another way, e.g. extracting its text with a PDF-to-text tool.`
  }
  return `The PDF is too large for the API. ${limits} Press escape twice to go back, then retry with a smaller PDF or convert it to text first.`
}

export function getPdfPasswordProtectedErrorMessage(): string {
  if (getIsNonInteractiveSession()) {
    return 'The PDF is password protected and cannot be read by the API. Use a CLI tool to extract or convert its contents first.'
  }
  return 'The PDF is password protected and cannot be read by the API. Press escape twice and edit your message.'
}

export function getPdfInvalidErrorMessage(): string {
  if (getIsNonInteractiveSession()) {
    return 'The PDF was not valid and cannot be read by the API. Convert it to text first.'
  }
  return 'The PDF was not valid and cannot be read by the API. Press escape twice and try a different file.'
}

export function getImageTooLargeErrorMessage(): string {
  if (getIsNonInteractiveSession()) {
    return 'The image is too large for the API. Resize it or take another approach.'
  }
  return 'The image is too large for the API. Press escape twice to go back, then retry with a smaller image.'
}

export function getRequestTooLargeErrorMessage(): string {
  if (getIsNonInteractiveSession()) {
    return 'The request is too large for the API (32 MB maximum). Use a smaller file.'
  }
  return 'The request is too large for the API (32 MB maximum). Press escape twice and remove or shrink the attached content.'
}

// ---------------------------------------------------------------------------
// The client-contract gate (the first-party subscription door)
// ---------------------------------------------------------------------------

/**
 * The phrase family of the subscription endpoint's minimum-client-version
 * refusal (HTTP 400: "<read> does not support this model; version <floor>
 * or newer is required"; its details also carry error_code
 * claude_code_version_too_old).
 */
export function isClientContractGateText(text: string): boolean {
  return (
    (text.includes('does not support this model') && text.includes('or newer is required')) ||
    text.includes('claude_code_version_too_old')
  )
}

/**
 * The Mercury line for that refusal: the real cause (a minimum
 * client-contract version, read from the attribution line's cc_version —
 * constants/oauth.ts carries the why), what the endpoint read and requires,
 * what Mercury presents and where that came from, and the override that
 * raises it. The wire's own remedy is the vendor CLI's updater — not a
 * Mercury verb — and never reaches the operator.
 */
export function clientContractGateLine(wireText: string, model: string): string {
  const floor = /version (\d+(?:\.\d+)+) or newer is required/.exec(wireText)?.[1]
  const read = /(\d+(?:\.\d+)+) does not support this model/.exec(wireText)?.[1]
  const contract = describeAnthropicClientContract()
  const source = contract.source === 'override' ? 'from MERCURY_ANTHROPIC_CLIENT_CONTRACT' : 'the built-in constant'
  return (
    `${API_ERROR_MESSAGE_PREFIX} (400): the subscription endpoint gates ${model} on a minimum client-contract version: ` +
    `it read ${read ?? 'an older version'} from this request and requires ${floor ?? 'a newer version'}${floor ? ' or newer' : ''}. ` +
    `Mercury presents ${contract.presented} (${source}) on that door; ` +
    `set MERCURY_ANTHROPIC_CLIENT_CONTRACT=${floor ?? '<version>'} (or newer) and restart Mercury to raise it.`
  )
}

export function getTokenRevokedErrorMessage(): string {
  if (getIsNonInteractiveSession()) return TOKEN_REVOKED_ERROR_MESSAGE
  return 'Your OAuth token has been revoked — run /logins.'
}

export function getOauthOrgNotAllowedErrorMessage(): string {
  if (getIsNonInteractiveSession()) return OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE
  return 'Your account does not have access to Mercury — run /logins.'
}

// ---------------------------------------------------------------------------
// Stream-fault predicates
// ---------------------------------------------------------------------------

export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    // Both login-prefixed spellings: the live emitter's period form and the
    // middot form persisted transcripts may carry from earlier eras.
    text.startsWith(`Please run /logins. ${API_ERROR_MESSAGE_PREFIX}`) ||
    text.startsWith(`Please run /logins · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}

/** Both provider transports must compose their fault tail through this. */
export function streamFaultAfterPartialText(provider: string, code: string, message: string): string {
  return `${API_ERROR_MESSAGE_PREFIX}: ${provider} ${STREAM_FAULT_AFTER_PARTIAL_MARKER} (${code}) — ${message}`
}

export function isContinuableStreamFaultText(text: string): boolean {
  return startsWithApiErrorPrefix(text) && text.includes(STREAM_FAULT_AFTER_PARTIAL_MARKER)
}

export function isContinuableStreamFaultMessage(msg: AssistantMessage): boolean {
  if (msg.isApiErrorMessage !== true) return false
  const content = msg.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    block =>
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string' &&
      ((block as { text: string }).text.includes(STREAM_FAULT_AFTER_PARTIAL_MARKER)),
  )
}

export function isStreamFaultRecoveryNudgeText(text: string): boolean {
  return text === STREAM_FAULT_RECOVERY_NUDGE
}

// ---------------------------------------------------------------------------
// Prompt-too-long predicates
// ---------------------------------------------------------------------------

export function isPromptTooLongMessage(msg: Message): boolean {
  if (msg.type !== 'assistant') return false
  if ((msg as AssistantMessage).isApiErrorMessage !== true) return false
  const content = (msg as AssistantMessage).message.content
  if (!Array.isArray(content)) return false
  return content.some(
    block =>
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string' &&
      (block as { text: string }).text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/**
 * Lenient, case-insensitive extraction of the actual and limit token counts
 * from raw prompt-too-long text, tolerating SDK prefixes and JSON envelopes.
 * Both keys are always present; both undefined when the pattern misses.
 */
export function parsePromptTooLongTokenCounts(raw: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  const match = /prompt is too long[\s\S]*?(\d+)\s*tokens\s*>\s*(\d+)/i.exec(raw)
  if (!match) return { actualTokens: undefined, limitTokens: undefined }
  return {
    actualTokens: Number.parseInt(match[1] as string, 10),
    limitTokens: Number.parseInt(match[2] as string, 10),
  }
}

/** actual − limit when both parse and the difference is positive. */
export function getPromptTooLongTokenGap(msg: Message): number | undefined {
  if (msg.type !== 'assistant') return undefined
  const details = (msg as AssistantMessage).errorDetails
  const content = (msg as AssistantMessage).message.content
  const texts: string[] = []
  if (typeof details === 'string') texts.push(details)
  if (Array.isArray(content)) {
    for (const block of content) {
      if ((block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        texts.push((block as { text: string }).text)
      }
    }
  }
  for (const text of texts) {
    const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(text)
    if (actualTokens !== undefined && limitTokens !== undefined) {
      const gap = actualTokens - limitTokens
      if (gap > 0) return gap
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Media-size predicates
// ---------------------------------------------------------------------------

export function isMediaSizeError(raw: string): boolean {
  if (raw.includes('image exceeds') && raw.includes('maximum')) return true
  if (raw.includes('image dimensions exceed') && raw.includes('many-image')) return true
  if (raw.includes('image dimensions exceed') && raw.includes('max allowed size')) return true
  return PDF_PAGES_PATTERN.test(raw)
}

export function isMediaSizeErrorMessage(msg: Message): boolean {
  if (msg.type !== 'assistant') return false
  if ((msg as AssistantMessage).isApiErrorMessage !== true) return false
  const details = (msg as AssistantMessage).errorDetails
  return typeof details === 'string' && isMediaSizeError(details)
}

// ---------------------------------------------------------------------------
// Response-shape helpers
// ---------------------------------------------------------------------------

export function isValidAPIMessage(value: unknown): value is BetaMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { content?: unknown; model?: unknown; usage?: unknown }
  return (
    Array.isArray(record.content) &&
    typeof record.model === 'string' &&
    typeof record.usage === 'object' &&
    record.usage !== null
  )
}

// ---------------------------------------------------------------------------
// Raw error → assistant error message
// ---------------------------------------------------------------------------

/** What a 429 carried, split by provenance: an extracted inner `message`
 *  IS the provider's own sentence (attributable as "Anthropic says"); any
 *  other non-empty tail is shown verbatim but never attributed — it can be
 *  SDK-synthesised text (e.g. the no-body fallback), not provider words.
 *  Null when nothing rode the error at all. */
function extract429Detail(message: string): { text: string; providerSentence: boolean } | null {
  return extractProviderDetail(429, message)
}

/** The same split for any status: the SDK's message is "<status> <body>";
 *  the body's inner `message` is the provider's sentence, a non-JSON tail
 *  is shown verbatim unattributed, and nothing else rides the row — the
 *  envelope (a brace-bearing blob) is never transcript text (L25). */
function extractProviderDetail(
  status: number | undefined,
  message: string,
): { text: string; providerSentence: boolean } | null {
  const prefix = `${status ?? ''} `
  const stripped = status !== undefined && message.startsWith(prefix) ? message.slice(prefix.length) : message
  const inner = /"message"\s*:\s*"([^"]+)"/.exec(stripped)
  if (inner?.[1]) return { text: inner[1], providerSentence: true }
  if (stripped.trim() !== '' && !/\{\s*"/.test(stripped)) return { text: stripped, providerSentence: false }
  return null
}

export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  _context?: { messages?: Message[]; messagesForAPI?: unknown[] },
): AssistantMessage {
  const message = messageOf(error)
  const status = statusOf(error)
  const nonInteractive = getIsNonInteractiveSession()

  // 1. Timeout.
  if (isTimeoutError(error)) {
    return createAssistantAPIErrorMessage({ content: API_TIMEOUT_ERROR_MESSAGE, error: 'unknown' })
  }

  // 2. Local image validation/resize failures (thrown before the call).
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({ content: getImageTooLargeErrorMessage() })
  }

  // 3. Capacity off-switch.
  if (message.includes(CUSTOM_OFF_SWITCH_MESSAGE)) {
    return createAssistantAPIErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'rate_limit',
    })
  }

  // 4/5 shared guard: 429 with rate-limit processing enabled.
  if (status === 429 && shouldProcessRateLimits(isClaudeAISubscriber())) {
    const headers = errorHeaders(error)
    const claim = headerValue(headers, 'anthropic-ratelimit-unified-representative-claim')
    const overageStatus = headerValue(headers, 'anthropic-ratelimit-unified-overage-status')
    const reset = headerValue(headers, 'anthropic-ratelimit-unified-reset')
    const overageReset = headerValue(headers, 'anthropic-ratelimit-unified-overage-reset')
    const overageDisabledReason = headerValue(
      headers,
      'anthropic-ratelimit-unified-overage-disabled-reason',
    )

    // 4. With quota headers: delegate to the limits service.
    if ((claim !== undefined && claim !== '') || (overageStatus !== undefined && overageStatus !== '')) {
      const limits: ClaudeAILimits = {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        ...(reset !== undefined && reset !== '' ? { resetsAt: Number(reset) } : {}),
        ...(overageReset !== undefined && overageReset !== ''
          ? { overageResetsAt: Number(overageReset) }
          : {}),
        ...(claim !== undefined && claim !== ''
          ? { rateLimitType: claim as ClaudeAILimits['rateLimitType'] }
          : {}),
        ...(overageStatus !== undefined && overageStatus !== ''
          ? { overageStatus: overageStatus as QuotaStatus }
          : {}),
        ...(overageDisabledReason !== undefined && overageDisabledReason !== ''
          ? { overageDisabledReason: overageDisabledReason as OverageDisabledReason }
          : {}),
      }
      const text = getRateLimitErrorMessage(limits, model)
      if (text !== null && text !== '') {
        // The remedy lines are COMPOSED HERE, once, and ride the message
        // text (the OpenAI lane's pattern): a transcript row is a record of
        // what was true when it printed, and the render side must never
        // recompute a settled row's remedies from live slot/account/lane
        // state (a slot flip rewrote history — FN-016 R9). The renderer
        // paints the first line as the refusal and the rest dim.
        return createAssistantAPIErrorMessage({
          content: `${text}${composeAnthropicWallRemedies()}`,
          error: 'rate_limit',
        })
      }
      // A silent fallback will handle it; the event still enters history.
      return createAssistantAPIErrorMessage({
        content: NO_RESPONSE_REQUESTED,
        error: 'rate_limit',
      })
    }

    // 5. Without quota headers — Mercury's one-line frame with the provider
    // attributed, the provider's exact sentence kept verbatim inside it, and
    // the raw wire text riding errorDetails (the transcript's detail row).
    if (message.includes(LONG_CONTEXT_EXTRA_USAGE_PHRASE)) {
      const hint = nonInteractive
        ? 'Enable extra usage in your Claude settings on the web, or switch to standard context with --model.'
        : 'Enable extra usage in your Claude settings on the web, or switch to standard context with /model.'
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: Anthropic says "${LONG_CONTEXT_EXTRA_USAGE_PHRASE}". ${hint}`,
        error: 'rate_limit',
        errorDetails: message,
      })
    }
    const detail429 = extract429Detail(message)
    return createAssistantAPIErrorMessage({
      content:
        detail429 === null
          ? `${API_ERROR_MESSAGE_PREFIX} (429, request rejected): Anthropic sent no detail — this may be a temporary capacity issue; check https://status.anthropic.com.`
          : detail429.providerSentence
            ? `${API_ERROR_MESSAGE_PREFIX} (429, request rejected): Anthropic says: ${detail429.text}`
            : `${API_ERROR_MESSAGE_PREFIX} (429, request rejected): ${detail429.text}`,
      error: 'rate_limit',
      errorDetails: message,
    })
  }

  // 6. Prompt too long — exact stable content; raw text into errorDetails;
  // the typed overflow signal stamped for the recovery ladder (the one
  // classifier owner reads status + sentence — never this branch's word).
  if (message.toLowerCase().includes('prompt is too long')) {
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails: message,
      overflow: classifyOverflowFault({ family: overflowFamilyOfModel(model), status, message }),
    })
  }

  // 7. PDF page limit.
  if (PDF_PAGES_PATTERN.test(message)) {
    return createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      error: 'invalid_request',
      errorDetails: message,
    })
  }

  // 8. Password-protected PDF.
  if (message.includes(PDF_PASSWORD_PHRASE)) {
    return createAssistantAPIErrorMessage({
      content: getPdfPasswordProtectedErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 9. Invalid PDF — without this, the bad document block stays in context
  // and every later call 400s.
  if (message.includes(PDF_INVALID_PHRASE)) {
    return createAssistantAPIErrorMessage({
      content: getPdfInvalidErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 10. Oversized image (bytes).
  if (status === 400 && message.includes('image exceeds') && message.includes('maximum')) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      errorDetails: message,
    })
  }

  // 11. Single-image dimension cap (8 000 px per side).
  if (
    status === 400 &&
    error instanceof Error &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('max allowed size')
  ) {
    const base =
      'An image exceeds the API limit of 8000px on any side. The oversized image is removed on retry.'
    return createAssistantAPIErrorMessage({
      content: nonInteractive
        ? base
        : `${base} You can also run /compact to drop old images, or simply continue.`,
      error: 'invalid_request',
      errorDetails: message,
    })
  }

  // 12. Many-image dimension cap (2 000 px in many-image requests).
  if (status === 400 && message.includes('image dimensions exceed') && message.includes('many-image')) {
    const base =
      'An image exceeds the stricter 2000-pixel limit that applies to requests with many images.'
    return createAssistantAPIErrorMessage({
      content: nonInteractive
        ? `${base} Start a new session with fewer images.`
        : `${base} Run /compact to drop old images, or start a new session.`,
      error: 'invalid_request',
      errorDetails: message,
    })
  }

  // 13. Rejected auto-mode beta header — inert while the constant is empty.
  if (
    AFK_MODE_BETA_HEADER !== '' &&
    status === 400 &&
    message.includes(AFK_MODE_BETA_HEADER) &&
    message.includes('anthropic-beta')
  ) {
    return createAssistantAPIErrorMessage({
      content: 'Flow is unavailable for your plan.',
      error: 'invalid_request',
    })
  }

  // 14. Request too large — the body cap is an overflow shape of its own
  // (a fold shrinks bytes as well as tokens; the ladder's retry tells the
  // truth when a single attachment is the cause).
  if (status === 413) {
    return createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
      overflow: classifyOverflowFault({ family: overflowFamilyOfModel(model), status, message }),
    })
  }

  // 15. Tool-use/tool-result adjacency violation.
  if (status === 400 && message.includes(ADJACENCY_PHRASE)) {
    const base = `${API_ERROR_MESSAGE_PREFIX} (400): a tool-use concurrency problem left a tool use without its result.`
    return createAssistantAPIErrorMessage({
      content: nonInteractive ? base : `${base} Run /rewind to recover from an earlier point.`,
      error: 'invalid_request',
    })
  }

  // 15b. Unexpected tool result — vestigial: falls through to the generic
  // tail (the classifier has a class for it; the message branch does not).

  // 16. Duplicate tool-use ids — pairing repair strips these before send, so
  // reaching here means a new corruption path; give a way out.
  if (status === 400 && message.includes(DUPLICATE_TOOL_USE_PHRASE)) {
    const base = `${API_ERROR_MESSAGE_PREFIX} (400): a duplicate tool-use id exists in conversation history.`
    return createAssistantAPIErrorMessage({
      content: nonInteractive ? base : `${base} Run /rewind to recover from an earlier point.`,
      error: 'invalid_request',
      errorDetails: message,
    })
  }

  // 17. Top-tier model unavailable on a consumer plan.
  if (
    isClaudeAISubscriber() &&
    status === 400 &&
    message.toLowerCase().includes('invalid model name') &&
    (isNonCustomOpusModel(model) || model === 'opus')
  ) {
    return createAssistantAPIErrorMessage({
      content:
        'The top-tier model is not available on your subscription tier. If you recently changed plans, run /logout then /logins for the change to take effect.',
      error: 'invalid_request',
    })
  }

  // 17b. The first-party door's client-contract gate: the subscription
  // endpoint refuses a model below a minimum client version it reads from
  // the attribution line's cc_version. The wire's remedy names the vendor
  // CLI's updater and never rides the row (nor errorDetails); the debug
  // log keeps the wire's whole text.
  if (status === 400 && isClientContractGateText(message)) {
    logForDebugging(`[api] client-contract gate on ${model} — the wire said: ${message}`)
    return createAssistantAPIErrorMessage({
      content: clientContractGateLine(message, model),
      error: 'invalid_request',
    })
  }

  // 18. Credit balance (the provider's longer possessive phrasing). The
  // content constant stays byte-identical — it is the equality-matched key
  // persisted transcripts and the render leg pin (the renderer respells the
  // frame for display); the provider's exact sentence rides errorDetails.
  if (message.includes(CREDIT_BALANCE_PROVIDER_PHRASE)) {
    return createAssistantAPIErrorMessage({
      content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
      error: 'billing_error',
      errorDetails: message,
    })
  }

  // 19. Disabled organisation via env key. Kind must be invalid_request, NOT
  // authentication_failed — an editor integration reacts to the latter by
  // opening a login flow, and login cannot fix a configuration problem.
  if (status === 400 && message.toLowerCase().includes('organization has been disabled')) {
    const { source } = getAnthropicApiKeyWithSource()
    if (
      source === 'ANTHROPIC_API_KEY' &&
      typeof process.env.ANTHROPIC_API_KEY === 'string' &&
      process.env.ANTHROPIC_API_KEY !== '' &&
      !isClaudeAISubscriber()
    ) {
      return createAssistantAPIErrorMessage({
        content: hasStoredOAuthToken()
          ? ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH
          : ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
        error: 'invalid_request',
      })
    }
  }

  // 19b. A configured apiKeyHelper that FAILED (FN-015 rank 48): the request
  // carried no credential at all, so the wire's 401 is the helper's failure
  // in costume — name the helper and its reason, never "invalid API key".
  if (status === 401 || message.toLowerCase().includes('x-api-key')) {
    const helperFailure = getApiKeyHelperFailure()
    if (helperFailure !== null && getAnthropicApiKeyWithSource().source === 'apiKeyHelper') {
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: the configured apiKeyHelper failed (${helperFailure.message}) — no credential was sent; fix the helper and retry`,
        error: 'authentication_failed',
      })
    }
  }

  // 20. Bad API key.
  if (message.toLowerCase().includes('x-api-key')) {
    const { source } = getAnthropicApiKeyWithSource()
    const external = source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper'
    return createAssistantAPIErrorMessage({
      content: external ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL : INVALID_API_KEY_ERROR_MESSAGE,
      error: 'authentication_failed',
    })
  }

  // 21. THE CREDENTIAL WALL (ledger L25, L23's inline arm): a revoked
  // sign-in — 401 or 403, both wire spellings — paints the estate's one
  // honest line (credentialWall's owner: the family, the switch door, the
  // reconnect door). The wire's payload never rides the row; it goes to
  // the debug log. Before the generic tails, which carry the message.
  const wall = classifyCredentialWall(status, message)
  if (wall !== undefined) {
    logForDebugging(`[api] credential wall (${wall}) on ${model} — the wire said: ${message}`)
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${credentialWallLine(routeOfModel(model), wall, { nonInteractive })}`,
      error: 'authentication_failed',
    })
  }

  // 22. Org not allowed for OAuth.
  if ((status === 401 || status === 403) && message.includes(OAUTH_ORG_NOT_ALLOWED_PHRASE)) {
    return createAssistantAPIErrorMessage({
      content: nonInteractive
        ? 'Your organization does not have access to Mercury. Log in again, or contact your administrator.'
        : 'Your account does not have access to Mercury — run /logins.',
      error: 'authentication_failed',
    })
  }

  // 22b. Expired claude.ai sign-in the estate has ALREADY observed dead
  // (blanked/dead refresh token, or past-expiry with none to spend) — the
  // same credential-wall line the revoked case speaks (one owner). Never a
  // probe; the same predicate the retry fail-fast and the /model row read,
  // so the surfaces agree. The wire's words go to the debug log, not the
  // row (L25: never a raw payload in the transcript).
  if (status === 401 && isAnthropicOAuthSignInExpired()) {
    logForDebugging(`[api] credential wall (sign-in, observed expired) on ${model} — the wire said: ${message}`)
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${credentialWallLine(routeOfModel(model), 'sign-in', { nonInteractive })}`,
      error: 'authentication_failed',
    })
  }

  // 23. Generic 401/403 — the provider's own SENTENCE rides the row,
  // attributed; the envelope it came in never does (L25: no raw payload in
  // the transcript — the debug log keeps the wire's whole text).
  if (status === 401 || status === 403) {
    logForDebugging(`[api] ${status} on ${model} — the wire said: ${message}`)
    const detail = extractProviderDetail(status, message)
    const family = providerNameOfModel(model)
    const evidence =
      detail === null
        ? `${API_ERROR_MESSAGE_PREFIX} (${status}): ${family} sent no detail`
        : detail.providerSentence
          ? `${API_ERROR_MESSAGE_PREFIX} (${status}): ${family} says: ${detail.text}`
          : `${API_ERROR_MESSAGE_PREFIX} (${status}): ${detail.text}`
    // When the active auth source shadows a saved login, /logins is a dead
    // end: the env token outranks the credential store. Same predicate as
    // the login-time warning, so the two surfaces cannot disagree.
    const authSource = getAuthTokenSource().source
    if (isEnvShadowedAuthSource(authSource)) {
      // The verb must exist on the operator's shell: `unset` is a POSIX builtin
      // that no Windows shell has (PowerShell: Remove-Item Env:\NAME; cmd: set
      // NAME=) — the only remedy handed to a wedged Windows operator was a
      // command that errored (TASK-017 S2, unset-remedy-does-not-exist-on-windows).
      const clearVerb =
        process.platform === 'win32'
          ? `clear ${authSource} (PowerShell: Remove-Item Env:\\${authSource} · cmd: set ${authSource}=)`
          : `unset ${authSource}`
      const fix = hasStoredOAuthToken()
        ? `restart Mercury (or ${clearVerb}) to use your saved login`
        : `${clearVerb} and then run /logins`
      return createAssistantAPIErrorMessage({
        content: `Authentication failed: ${authSource} is set and overrides /logins — ${fix}. ${evidence}`,
        error: 'authentication_failed',
      })
    }
    return createAssistantAPIErrorMessage({
      content: nonInteractive ? `Authentication failed. ${evidence}` : `Please run /logins. ${evidence}`,
      error: 'authentication_failed',
    })
  }

  // 25. 404. The full evidence rides the refusal — status · request id ·
  // model (the sovereign grammar) — because this error crosses seams: a
  // subagent's first-call 404 surfaces to the PARENT through this exact
  // text, and a bare "model issue" line strands the caller without the
  // request to cite. Never a silent fallback to another model.
  if (status === 404) {
    const switchCommand = nonInteractive ? '--model' : '/model'
    const requestId =
      (error as { request_id?: unknown } | null)?.request_id ??
      headerValue(errorHeaders(error), 'request-id') ??
      'unknown'
    return createAssistantAPIErrorMessage({
      content: `There is an issue with the selected model (${model}) — it may not exist or may be inaccessible (HTTP 404, request_id: ${String(requestId)}). Run \`${switchCommand}\` to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // 26. Any other connection error.
  if (isConnectionError(error)) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${formatConnectionFallback(error)}`,
      error: 'unknown',
    })
  }

  // 27/28. Any other Error / non-Error value. A gateway fronting this lane
  // may refuse an over-long request in its own family's sentence — the
  // classifier answers null for everything that is not an overflow.
  if (error instanceof Error) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'unknown',
      overflow: classifyOverflowFault({ family: overflowFamilyOfModel(model), status, message }),
    })
  }
  return createAssistantAPIErrorMessage({ content: API_ERROR_MESSAGE_PREFIX, error: 'unknown' })
}

/** The overflow signal's family word for a model on the home transport:
 *  the declared route, or 'unknown' for a gateway stranger. */
function overflowFamilyOfModel(model: string): OverflowFamily {
  try {
    const { declaredRouteOf } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    return declaredRouteOf(model) ?? 'unknown'
  } catch {
    return 'anthropic'
  }
}

// ---------------------------------------------------------------------------
// Class strings
// ---------------------------------------------------------------------------

export function classifyAPIError(error: unknown): string {
  const message = messageOf(error)
  const status = statusOf(error)
  const lower = message.toLowerCase()

  // Equality — and only for this class.
  if (message === SDK_REQUEST_ABORTED_MESSAGE) return 'aborted'
  if (isTimeoutError(error)) return 'api_timeout'
  // Own-constant matches (Mercury-synthesised messages classify correctly).
  if (message.includes(REPEATED_529_ERROR_MESSAGE)) return 'repeated_529'
  if (message.includes(CUSTOM_OFF_SWITCH_MESSAGE)) return 'capacity_off_switch'
  if (status === 429) return 'rate_limit'
  if (status === 529 || message.includes(OVERLOADED_TYPE_MARKER)) return 'server_overload'
  if (lower.includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase())) return 'prompt_too_long'
  if (PDF_PAGES_PATTERN.test(message)) return 'pdf_too_large'
  if (message.includes(PDF_PASSWORD_PHRASE)) return 'pdf_password_protected'
  if (
    (message.includes('image exceeds') && message.includes('maximum')) ||
    (message.includes('image dimensions exceed') && message.includes('many-image'))
  ) {
    return 'image_too_large'
  }
  if (message.includes(ADJACENCY_PHRASE)) return 'tool_use_mismatch'
  if (status === 400 && message.includes(UNEXPECTED_TOOL_RESULT_PHRASE)) {
    return 'unexpected_tool_result'
  }
  if (message.includes(DUPLICATE_TOOL_USE_PHRASE)) return 'duplicate_tool_use_id'
  if (lower.includes('invalid model name')) return 'invalid_model'
  if (lower.includes(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE.toLowerCase())) {
    return 'credit_balance_low'
  }
  if (lower.includes('x-api-key')) return 'invalid_api_key'
  if (isRevokedSignInText(message)) return 'token_revoked'
  if (message.includes(OAUTH_ORG_NOT_ALLOWED_PHRASE)) return 'oauth_org_not_allowed'
  if (status === 401 || status === 403) return 'auth_error'
  // The status bands apply to provider errors only; a provider error with no
  // status falls past them.
  if (error instanceof APIError && typeof status === 'number') {
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
  }
  const details = connectionDetailsFor(error)
  if (details?.isSSLError) return 'ssl_cert_error'
  if (isConnectionError(error) || details !== null) return 'connection_error'
  return 'unknown'
}

/** Duck-typed status read: any error object carrying a numeric `status`. */
function statusOfAny(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * The coarse mapper for retryable errors → the SDK assistant-error union.
 * Reads the status off ANY error object with a numeric `status` (a plain
 * `{status: 529}` categorises as rate_limit) — unlike the fine-grained
 * classifier, whose status bands are provider-error-only.
 */
export function categorizeRetryableAPIError(error: unknown): AssistantMessageError {
  const message = messageOf(error)
  const status = statusOfAny(error)
  if (status === 529 || message.includes(OVERLOADED_TYPE_MARKER)) return 'rate_limit'
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'authentication_failed'
  if (typeof status === 'number' && status >= 408) return 'server_error'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

export function getErrorMessageIfRefusal(
  stopReason: string | null | undefined,
  model: string,
  evidence?: { requestId?: string | null; raw?: unknown },
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') return undefined
  const nonInteractive = getIsNonInteractiveSession()
  // State only what the signal carries — the enum does not carry a cause, so
  // no policy violation is asserted.
  let content = nonInteractive
    ? 'The model ended the response early (stop_reason: refusal). Try rephrasing the request or a different approach.'
    : 'The model ended the response early (stop_reason: refusal). Press escape twice to edit your last message, or start a new session.'
  // The remedy suggests the SESSION FAMILY's light tier (the ratified
  // light-tier law) — never a cross-family push. A family recording no
  // light fact gets no model suggestion (honest absence). Late requires:
  // this error surface must not pull the model-truth graph at load.
  try {
    const { providerLightFact } =
      require('../../utils/model/providerFrontier.js') as typeof import('../../utils/model/providerFrontier.js')
    const { declaredRouteOf } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    const errorRoute = declaredRouteOf(model)
    const light = errorRoute === null ? undefined : providerLightFact(errorRoute)
    if (light !== undefined && model !== light.modelId) {
      content += ` If refusals repeat, consider running /model ${light.modelId}.`
    }
  } catch {
    // a broken projection never breaks the error surface — no suggestion
  }
  let payload = ''
  if (evidence !== undefined && 'raw' in evidence && evidence.raw !== undefined) {
    const serialized = jsonStringify(evidence.raw)
    payload = ` · payload: ${serialized ?? '[unserialisable]'}`
  }
  const errorDetails = `stop_reason: refusal · model: ${model} · request_id: ${evidence?.requestId ?? 'unknown'}${payload}`
  return createAssistantAPIErrorMessage({
    content,
    error: 'invalid_request',
    errorDetails,
  })
}

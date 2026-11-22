import { APIConnectionError, APIConnectionTimeoutError, APIError } from '../../utils/api/sdkErrors.js'
import { isBedrockThrottle } from './bedrockThrottle.js'
import { ANTHROPIC_WORKSPACE_FIX, needsAnthropicWorkspace } from '../providers/anthropic/anthropicWorkspace.js'

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { ANTHROPIC_IMAGE_LIMITS, API_PDF_MAX_PAGES, PDF_TARGET_RAW_SIZE } from '../../constants/apiLimits.js'
import type { AssistantMessage, FailoverCause, Message } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import { getAnthropicApiKeyWithSource, getApiKeyHelperFailure, getAuthTokenSource, hasStoredOAuthToken, isClaudeAISubscriber, isAnthropicOAuthSignInExpired, wireCredentialSource, type WireCredentialSource } from '../../utils/auth.js'
import { formatFileSize } from '../../utils/format.js'
import { isEnvShadowedAuthSource } from '../../utils/loginShadow.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { NO_RESPONSE_REQUESTED } from '../../utils/messages/rejectionText.js'
import { createAssistantAPIErrorMessage } from '../../utils/messages/factories.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { anthropicCarryWords, anthropicRefusalFactsOf, classifyAnthropicRefusal } from '../providers/anthropicRefusal.js'
import { clientContractGateText, modelRefusalFromError, noteModelRefusal, type ModelRefusalRequest } from '../providers/anthropic/modelRefusal.js'
import { classifyCredentialWall, credentialWallLine, isRevokedSignInText, type WireCredentialKind } from '../providers/credentialWall.js'
import { classifyOverflowFault, type OverflowFamily } from './overflowSignal.js'
import type { AnthropicLimits, OverageDisabledReason, QuotaStatus } from '../anthropicLimits.js'
import { getRateLimitErrorMessage, rateLimitTypeOfClaim } from '../anthropicLimits.js'
import { composeAnthropicWallRemedies } from '../rateLimitMessages.js'
import { shouldProcessRateLimits } from '../rateLimitMocking.js'
import {
  extractConnectionErrorDetails as connectionDetailsFor,
  formatAPIError as formatConnectionFallback,
} from './errorUtils.js'
import { retryAfterHeaderMs, errorHeaders } from './retryAfter.js'
import { providerWaitWords, stampProviderWait } from './recoveryBudget.js'
import { ImageResizeError, statedManyImageLimit } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../imageValidation.js'


import { API_ERROR_MESSAGE_PREFIX, startsWithApiErrorPrefix } from './errorPrefix.js'
import { providerAskedWaitMs } from './recoveryBudget.js'
import { passedOver } from '../../utils/passedOver.js'
import { clearEnvVarCommandWords } from '../../utils/platform/words.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'
export { API_ERROR_MESSAGE_PREFIX, startsWithApiErrorPrefix } from './errorPrefix.js'

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

export const STREAM_FAULT_RECOVERY_NUDGE =
  'The provider stream dropped mid-response after partial content. ' +
  'Pick up exactly where your output stopped rather than restarting. Do not apologise ' +
  'and do not restate anything you already produced. Finish the outstanding work and ' +
  'end with a complete final message.'

const STREAM_FAULT_RECOVERY_TAIL_CHARS = 160

export function streamFaultRecoveryTailLine(replyText: string): string | null {
  const settled = replyText.trimEnd()
  if (settled === '') return null
  const tail = settled.length > STREAM_FAULT_RECOVERY_TAIL_CHARS ? `…${settled.slice(-STREAM_FAULT_RECOVERY_TAIL_CHARS)}` : settled
  return `Your reply so far is the assistant message directly above this one; the stream was cut right after its last words: “${tail}”. Continue from exactly that point.`
}

export function streamFaultRecoveryContent(replyText: string): string | ContentBlockParam[] {
  const tailLine = streamFaultRecoveryTailLine(replyText)
  if (tailLine === null) return STREAM_FAULT_RECOVERY_NUDGE
  return [
    { type: 'text', text: STREAM_FAULT_RECOVERY_NUDGE },
    { type: 'text', text: tailLine },
  ]
}

export const EMPTY_REPLY_RECOVERY_NUDGE =
  '[System: the previous reply came back empty — no text and no tool call reached the user. ' +
  'Give the final answer now, or make the tool call you meant to make.]'

const REASONING_ONLY_RECOVERY_NUDGE =
  '[System: your last turn carried thinking only — say your reply, or call the tool you meant.]'

const REASONING_ONLY_FEWER_WORDS_NUDGE =
  '[System: your last turn carried thinking only — say your reply, or call the tool you meant; ' +
  'you ran out of output while thinking — answer in fewer words.]'

export const REASONING_CUT_MARKER = '[output ran out while thinking — no reply was written yet]'

export function reasoningOnlyRecoveryNudge(fewerWords: boolean): string {
  return fewerWords ? REASONING_ONLY_FEWER_WORDS_NUDGE : REASONING_ONLY_RECOVERY_NUDGE
}

export function isReasoningOnlyRecoveryNudgeText(text: string): boolean {
  return text === REASONING_ONLY_RECOVERY_NUDGE || text === REASONING_ONLY_FEWER_WORDS_NUDGE
}

export function reasoningOnlyNoticeLine(outputLimit: string | null, again: boolean, action: string): string {
  const head = outputLimit === null ? "the model's turn carried thinking only" : `thinking ran to the output limit (${outputLimit})`
  return `${head}${again ? ' again' : ''} — ${action}`
}

export const PROMPT_TOO_LONG_ERROR_MESSAGE: Unbuilt = unbuilt('src/services/api/errors.ts:104')

export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE: Unbuilt = unbuilt('src/services/api/errors.ts:106')

export const INVALID_API_KEY_ERROR_MESSAGE: Unbuilt =
  unbuilt('src/services/api/errors.ts:108')

export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL: Unbuilt =
  unbuilt('src/services/api/errors.ts:111')

export function invalidCredentialWords(source: WireCredentialSource): string {
  return notBuilt('src/services/api/errors.ts:114')
}

export function isInvalidCredentialWords(text: string): boolean {
  return notBuilt('src/services/api/errors.ts:129')
}

export const REPEATED_529_ERROR_MESSAGE: Unbuilt =
  unbuilt('src/services/api/errors.ts:133')

export const CUSTOM_OFF_SWITCH_MESSAGE: Unbuilt =
  unbuilt('src/services/api/errors.ts:136')

export const API_TIMEOUT_ERROR_MESSAGE: Unbuilt =
  unbuilt('src/services/api/errors.ts:139')

const SDK_REQUEST_ABORTED_MESSAGE = 'Request was aborted.'

const OVERLOADED_TYPE_MARKER = '"type":"overloaded_error"'
const ADJACENCY_PHRASE = '`tool_use` ids were found without `tool_result` blocks immediately after'
const UNEXPECTED_TOOL_RESULT_PHRASE = 'unexpected `tool_use_id` found in `tool_result`'
const DUPLICATE_TOOL_USE_PHRASE = '`tool_use` ids must be unique'
const PDF_PASSWORD_PHRASE = 'The PDF specified is password protected'
const PDF_INVALID_PHRASE = 'The PDF specified was not valid'
const CREDIT_BALANCE_PROVIDER_PHRASE = 'Your credit balance is too low'
const LONG_CONTEXT_EXTRA_USAGE_PHRASE = 'Extra usage is required for long context'
const PDF_PAGES_PATTERN = /maximum of \d+ PDF pages/


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

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined
  }
  const record = headers as Record<string, string>
  return record[name] ?? record[name.toLowerCase()]
}


function routeOfModel(model: string): string {
  try {
    const { declaredRouteOf } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    return declaredRouteOf(model) ?? 'gateway'
  } catch (error) {
    logError(new Error(`routeOfModel: ${error instanceof Error ? error.message : String(error)}`))
    return 'anthropic'
  }
}

function providerNameOfModel(model: string): string {
  const route = routeOfModel(model)
  try {
    const { providerDisplayName } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    return providerDisplayName(route)
  } catch (error) {
    logError(new Error(`providerNameOfModel: ${error instanceof Error ? error.message : String(error)}`))
    return route
  }
}


export function getPdfTooLargeErrorMessage(): string {
  return notBuilt('src/services/api/errors.ts:208')
}

export function getPdfPasswordProtectedErrorMessage(): string {
  return notBuilt('src/services/api/errors.ts:216')
}

export function getPdfInvalidErrorMessage(): string {
  return notBuilt('src/services/api/errors.ts:223')
}

export function getImageTooLargeErrorMessage(): string {
  return notBuilt('src/services/api/errors.ts:230')
}

export function getRequestTooLargeErrorMessage(): string {
  return notBuilt('src/services/api/errors.ts:237')
}


export function isClientContractGateText(text: string): boolean {
  return clientContractGateText(text)
}

export function clientContractGateLine(wireText: string, model: string): string {
  const refusal = modelRefusalFromError({ status: 400, message: wireText }, model)
  return `${API_ERROR_MESSAGE_PREFIX} (400): ${refusal?.words ?? `${model} was refused — pick another model with /model.`}`
}


export function streamFaultAfterPartialText(provider: string, code: string, message: string): string {
  return `${API_ERROR_MESSAGE_PREFIX}: ${provider} ${STREAM_FAULT_AFTER_PARTIAL_MARKER} (${code}) — ${message}`
}

export function streamFaultFactsOf(text: string): { provider: string; code: string; message: string } | null {
  if (!startsWithApiErrorPrefix(text)) return null
  const marker = ` ${STREAM_FAULT_AFTER_PARTIAL_MARKER} (`
  const at = text.indexOf(marker)
  if (at < 0) return null
  const provider = text.slice(API_ERROR_MESSAGE_PREFIX.length + 2, at)
  const rest = text.slice(at + marker.length)
  const close = rest.indexOf(') — ')
  if (close < 0) return null
  return { provider, code: rest.slice(0, close), message: rest.slice(close + 4) }
}

export function continuableStreamFaultTextOf(msg: AssistantMessage): string | null {
  if (msg.isApiErrorMessage !== true) return null
  const content = msg.message.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const text = (block as { type?: string; text?: unknown }).type === 'text' ? (block as { text?: unknown }).text : undefined
    if (typeof text === 'string' && text.includes(STREAM_FAULT_AFTER_PARTIAL_MARKER)) return text
  }
  return null
}

export function streamFaultNoticeLine(text: string | null, action: string): string {
  const facts = text === null ? null : streamFaultFactsOf(text)
  if (facts === null) return `The provider stream dropped after partial content — ${action}`
  return `${facts.provider} ended the stream after partial content — ${facts.message} (${facts.code}); ${action}`
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

export function isStreamFaultRecoveryNudgeEcho(text: string): boolean {
  return text.trim().startsWith(STREAM_FAULT_RECOVERY_NUDGE)
}

export function isEmptyReplyRecoveryNudgeText(text: string): boolean {
  return text === EMPTY_REPLY_RECOVERY_NUDGE
}

export function endsWithEmptyReplyRecoveryNudge(messages: readonly Message[]): boolean {
  const last = messages.at(-1)
  if (last === undefined || last.type !== 'user') return false
  const content = last.message.content
  if (typeof content === 'string') return isEmptyReplyRecoveryNudgeText(content)
  const tail = content.at(-1)
  return tail !== undefined && tail.type === 'text' && isEmptyReplyRecoveryNudgeText(tail.text)
}

function parsePromptTooLongTokenCounts(raw: string): {
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


function isManyImageRefusal(raw: string): boolean {
  return /many[- ]images?\b/i.test(raw)
}

export function isMediaSizeError(raw: string): boolean {
  if (raw.includes('image exceeds') && raw.includes('maximum')) return true
  if (raw.includes('image dimensions exceed') && isManyImageRefusal(raw)) return true
  if (raw.includes('image dimensions exceed') && raw.includes('max allowed size')) return true
  return PDF_PAGES_PATTERN.test(raw)
}


function extract429Detail(message: string): { text: string; providerSentence: boolean } | null {
  return extractProviderDetail(429, message)
}

function unescapeJsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string
  } catch {
    return body
  }
}
function extractProviderDetail(
  status: number | undefined,
  message: string,
): { text: string; providerSentence: boolean } | null {
  const prefix = `${status ?? ''} `
  const stripped = status !== undefined && message.startsWith(prefix) ? message.slice(prefix.length) : message
  const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(stripped)
  if (inner?.[1]) return { text: unescapeJsonString(inner[1]), providerSentence: true }
  if (stripped.trim() !== '' && !/\{\s*"/.test(stripped)) return { text: stripped, providerSentence: false }
  return null
}

export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  _context?: { messages?: Message[]; messagesForAPI?: unknown[]; modelRefusalRequest?: ModelRefusalRequest | undefined },
): AssistantMessage {
  const composed = composeAssistantMessageFromError(error, model, _context)
  const failover = homeFailoverCauseOf(error, composed)
  const row = failover === undefined ? composed : { ...composed, failover }
  if (row.error === 'authentication_failed' && classifyCredentialWall(statusOf(error), messageOf(error)) !== 'key-limit') return row
  const asked = providerAskedWaitMs(error)
  return asked === undefined ? row : { ...row, providerWaitEndsAtMs: Date.now() + asked }
}

function homeFailoverCauseOf(error: unknown, row: AssistantMessage): FailoverCause | undefined {
  if (row.overflowSignal !== undefined || row.apiError !== undefined) return undefined
  if (row.error === 'authentication_failed') return 'sign-in'
  const status = statusOf(error)
  if (status === 404) return 'unknown-model'
  if (isTimeoutError(error) || isConnectionError(error) || (error as { name?: unknown } | null)?.name === 'ReconnectBudgetSpentError') return 'unreachable'
  if (status !== undefined && status >= 500 && status !== 529) return 'unreachable'
  return undefined
}

function anthropicWireCredential(model: string, status: number | undefined): WireCredentialKind | undefined {
  if ((status !== 401 && status !== 403) || !['anthropic', 'gateway'].includes(routeOfModel(model))) return undefined
  if (isClaudeAISubscriber()) return 'sign-in'
  return wireCredentialSource().kind === 'none' ? undefined : 'key'
}

function composeAssistantMessageFromError(
  error: unknown,
  model: string,
  _context?: { messages?: Message[]; messagesForAPI?: unknown[]; modelRefusalRequest?: ModelRefusalRequest | undefined },
): AssistantMessage {
  return notBuilt('src/services/api/errors.ts:425')
}

function composeAuthFailureMessage(status: number, model: string, message: string, nonInteractive: boolean): AssistantMessage {
  logForDebugging(`[api] ${status} on ${model} — the wire said: ${message}`)
  const detail = extractProviderDetail(status, message)
  const family = providerNameOfModel(model)
  const evidence =
    detail === null
      ? `${API_ERROR_MESSAGE_PREFIX} (${status}): ${family} sent no detail`
      : detail.providerSentence
        ? `${API_ERROR_MESSAGE_PREFIX} (${status}): ${family} says: ${detail.text}`
        : `${API_ERROR_MESSAGE_PREFIX} (${status}): ${detail.text}`
  const authSource = getAuthTokenSource().source
  if (isEnvShadowedAuthSource(authSource)) {
    const clearVerb = clearEnvVarCommandWords(authSource)
    const fix = hasStoredOAuthToken()
      ? `restart Mercury (or ${clearVerb}) to use your saved login`
      : `${clearVerb} and then run /logins`
    return createAssistantAPIErrorMessage({
      content: `Authentication failed: ${authSource} is set and overrides /logins — ${fix}. ${evidence}`,
      error: 'authentication_failed',
    })
  }
  const credentialSource: WireCredentialSource = authSource === 'credentials.keyCommand'
    ? { kind: 'helper' }
    : wireCredentialSource(authSource === 'ANTHROPIC_AUTH_TOKEN' ? 'authorization' : 'x-api-key')
  if (status === 401 && (credentialSource.kind === 'env' || credentialSource.kind === 'helper')) {
    return createAssistantAPIErrorMessage({
      content: `${invalidCredentialWords(credentialSource)}. ${evidence}`,
      error: 'authentication_failed',
    })
  }
  return createAssistantAPIErrorMessage({
    content: nonInteractive ? `Authentication failed. ${evidence}` : `Run /logins. ${evidence}`,
    error: 'authentication_failed',
  })
}

function overflowFamilyOfModel(model: string): OverflowFamily {
  try {
    const { declaredRouteOf } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    return declaredRouteOf(model) ?? 'unknown'
  } catch (error) {
    logError(new Error(`overflowFamilyOfModel: ${error instanceof Error ? error.message : String(error)}`))
    return 'unknown'
  }
}


export function classifyAPIError(error: unknown): string {
  const message = messageOf(error)
  const status = statusOf(error)
  const lower = message.toLowerCase()

  if (message === SDK_REQUEST_ABORTED_MESSAGE) return 'aborted'
  if (isTimeoutError(error)) return 'api_timeout'
  if (message.includes(REPEATED_529_ERROR_MESSAGE)) return 'repeated_529'
  if (message.includes(CUSTOM_OFF_SWITCH_MESSAGE)) return 'capacity_off_switch'
  if (status === 429 || isBedrockThrottle(error)) return 'rate_limit'
  if (status === 529 || message.includes(OVERLOADED_TYPE_MARKER)) return 'server_overload'
  if (lower.includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase())) return 'prompt_too_long'
  if (PDF_PAGES_PATTERN.test(message)) return 'pdf_too_large'
  if (message.includes(PDF_PASSWORD_PHRASE)) return 'pdf_password_protected'
  if (
    (message.includes('image exceeds') && message.includes('maximum')) ||
    (message.includes('image dimensions exceed') && isManyImageRefusal(message))
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
  if (status === 401 || status === 403) return 'auth_error'
  if (error instanceof APIError && typeof status === 'number') {
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
  }
  const details = connectionDetailsFor(error)
  if (details?.isSSLError) return 'ssl_cert_error'
  if (isConnectionError(error) || details !== null) return 'connection_error'
  return 'unknown'
}


export function getErrorMessageIfRefusal(
  stopReason: string | null | undefined,
  model: string,
  evidence?: { requestId?: string | null; raw?: unknown },
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') return undefined
  const nonInteractive = getIsNonInteractiveSession()
  let content = nonInteractive
    ? 'The model ended the response early (stop_reason: refusal). Try rephrasing the request or a different approach.'
    : 'The model ended the response early (stop_reason: refusal). Use /rewind (or shift+up) to edit your last message, or start a new session.'
  try {
    const { providerLightFact } =
      require('../model/providerFrontier.js') as typeof import('../model/providerFrontier.js')
    const { declaredRouteOf } =
      require('../providers/routeLaw.js') as typeof import('../providers/routeLaw.js')
    const errorRoute = declaredRouteOf(model)
    const light = errorRoute === null ? undefined : providerLightFact(errorRoute)
    if (light !== undefined && model !== light.modelId) {
      content += ` If refusals repeat, try /model ${light.modelId}.`
    }
  } catch (error) {
    passedOver(error)
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

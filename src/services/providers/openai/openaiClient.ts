// ============================================================================
//  providers/openai/openaiClient — the native OpenAI Responses streaming
//  client + live model catalogue. NATIVE means the
//  documented HTTPS wire at the resolved account base (api.openai.com/v1 for
//  API keys · chatgpt.com/backend-api/codex for the subscription source) —
//  never a local executable, never an App Server, never a child process.
//
//  Laws (the zai transport's, held here):
//    - rides the existing HTTP owners: getProxyFetchOptions() +
//      getUserAgent(); its own bounded idle watchdog + AbortSignal
//      cancellation; NEVER the Anthropic OAuth/keychain machinery (OpenAI
//      account auth lives in openaiAccounts.ts);
//    - typed events out, faults as data (the generator never throws for
//      provider/transport trouble); HTTP errors map through
//      mapOpenaiHttpFailure; a stream ending without a terminal
//      response.completed/failed/incomplete is a typed truncation fault;
//    - RETURN-TO-BASELINE (TEMPER T2): every generator exit tears the
//      transport down — an abandoned stream never leaks its socket;
//    - tokens/keys arrive in prepared headers from the accounts owner and
//      never enter logs, errors or events.
// ============================================================================
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { SseDecoder } from '../sseDecoder.js'
import {
  mapOpenaiHttpFailure,
  ResponsesStreamFold,
  type OpenaiResponsesRequest,
  type OpenaiStreamEvent,
} from './openaiWire.js'
import { recordOpenaiRateHeaders } from './openaiLimitState.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { compatStreamIdleTimeoutMs } from '../streamIdleBudget.js'

// The byte-idle guard's budget: the one stream idle owner's default
// (providers/streamIdleBudget), so the status row and this guard agree.
const IDLE_TIMEOUT_MS = compatStreamIdleTimeoutMs()
/** One deadline per catalogue request (the provider-call deadline law —
 *  the sibling catalogues' bound): a black-holed /models used to hold the
 *  single-flight slot forever, so every later refresh returned the same
 *  pending promise and the GPT picker read "connecting" for the session. */
const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
/** Hard whole-request ceiling — long xhigh/max reasoning turns are real. */
const TOTAL_TIMEOUT_MS = 50 * 60_000

export interface OpenaiStreamOptions {
  baseUrl: string
  /** Prepared auth headers (accounts owner) — opaque here. */
  headers: Record<string, string>
  request: OpenaiResponsesRequest
  signal?: AbortSignal
  /** Proof seam — fixtures inject a fake fetch; production uses global fetch
   *  with the proxy options. */
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
}

/** Stream one Responses call as typed events. Never throws for provider
 *  trouble — faults are events. */
export async function* streamOpenaiResponses(
  options: OpenaiStreamOptions,
): AsyncGenerator<OpenaiStreamEvent> {
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const url = `${options.baseUrl.replace(/\/$/, '')}/responses`
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()

  const fold = new ResponsesStreamFold()

  try {
    let response: Response
    try {
      // the dispatcher in
      // getProxyFetchOptions comes from the BUNDLED undici — on Node it must
      // ride that SAME undici's fetch. Global fetch + the bundled dispatcher
      // dies pre-HTTP ('fetch failed' · cause 'invalid onRequestStart
      // method'), which broke EVERY OpenAI call on node runtimes (live-found
      // the operator's OAuth exchange; the same fault made the
      // catalogue read "connecting…" forever).
      const fetchImpl = options.fetchImpl ?? getApiFetch()
      const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': getUserAgent(),
          ...options.headers,
        },
        body: JSON.stringify(options.request),
        signal: controller.signal,
        ...(proxyOptions as Record<string, unknown>),
      } as RequestInit)
    } catch (error) {
      const cancelled = options.signal?.aborted === true
      yield {
        type: 'stream-fault',
        fault: cancelled
          ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled before response', retryable: false }
          : {
              kind: 'transport-error',
              code: 'fetch-failed',
              // Cause chain surfaced: 'fetch failed' alone hides which
              // pre-HTTP fault fired (DNS · TLS · refused · dispatcher).
              message: errorMessageWithCause(error),
              retryable: true,
            },
      }
      return
    }

    // Live usage observation (model-truth lane): every authenticated response
    // — success and failure alike — may carry the x-codex rate-limit header
    // family (used-percent / window-minutes / reset). Fold whatever the
    // source stated into the observed record; nothing stated, nothing
    // recorded. This is the weekly-meter derivation — push, never poll.
    recordOpenaiRateHeaders(response.headers)

    if (!response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      yield { type: 'stream-fault', fault: mapOpenaiHttpFailure(response.status, body, response.headers) }
      return
    }
    if (!response.body) {
      yield {
        type: 'stream-fault',
        fault: { kind: 'transport-error', code: 'no-body', message: 'response had no body', retryable: true },
      }
      return
    }

    const reader = response.body.getReader()
    const decoder = new SseDecoder()

    const readWithIdleGuard = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => reject(new Error('idle-timeout')), idleMs)
        idleTimer.unref?.()
      })
      try {
        return await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(idleTimer)
      }
    }

    readLoop: for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await readWithIdleGuard()
      } catch (error) {
        const isIdle = error instanceof Error && error.message === 'idle-timeout'
        const cancelled = options.signal?.aborted === true
        yield {
          type: 'stream-fault',
          fault: cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : isIdle
              ? { kind: 'timeout', code: 'idle-timeout', message: `no bytes for ${idleMs}ms`, retryable: true }
              : {
                  kind: 'transport-error',
                  code: 'read-failed',
                  message: error instanceof Error ? error.message : String(error),
                  retryable: true,
                },
        }
        try {
          await reader.cancel()
        } catch {
          /* already closed */
        }
        return
      }
      const results = chunk.done ? decoder.flush() : decoder.push(Buffer.from(chunk.value!))
      for (const item of results) {
        if (item.kind === 'fault') {
          yield {
            type: 'stream-fault',
            fault: {
              kind: 'truncated-stream',
              code: 'sse-dangling-event',
              message: `dangling SSE fragment: ${item.preview}`,
              retryable: false,
            },
          }
          continue
        }
        const payload = item.event.data
        if (payload.trim() === '[DONE]') break readLoop
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          yield {
            type: 'stream-fault',
            fault: {
              kind: 'truncated-stream',
              code: 'bad-json-chunk',
              message: `unparseable SSE chunk: ${payload.slice(0, 160)}`,
              retryable: false,
            },
          }
          continue
        }
        for (const event of fold.fold(parsed)) {
          yield event
        }
        if (fold.finished) break readLoop
      }
      if (chunk.done) break
    }

    if (!fold.finished) {
      yield {
        type: 'stream-fault',
        fault: {
          kind: 'truncated-stream',
          code: 'no-terminal-event',
          message: 'stream ended without response.completed/failed/incomplete',
          retryable: true,
        },
      }
    }
  } finally {
    clearTimeout(totalTimer)
    options.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}

// ── Live model catalogue (GET {base}/models) ────────────────────────────────

/** One live-discovered model record — the subscription backend's rich shape;
 *  the api.openai.com list is barer (id only) and the qualification owner
 *  composes the official capability table on top. */
export interface OpenaiLiveModel {
  id: string
  displayName?: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts: string[]
  /** true iff the source actually STATED a vocabulary array
   *  (`supported_reasoning_levels` present — possibly empty). A bare row
   *  (api.openai.com's id-only list) decodes to [] with stated=false; a
   *  known-empty vocabulary decodes to [] with stated=true. The two must
   *  never masquerade as each other: stated-empty means "effort is not
   *  selectable on this model", unstated means "vocabulary unknown". */
  reasoningEffortsStated: boolean
  /** Absent/'' means the source did not state visibility (treated visible).
   *  LIVE vocabulary: 'list' = shown,
   *  'hide' = hidden. */
  visibility?: string
  supportedInApi?: boolean
  /** LIVE semantics: ASCENDING rank — 1 is the top model. */
  priority?: number
  /** The window the source serves BY DEFAULT for a session on this model.
   *  Source-specific and NOT the model page's number — the same id can serve
   *  a smaller default on one source than its official page states; render
   *  SOURCE truth, never assume parity across sources or restate a
   *  remembered figure. (Dated illustration, observed/25 on a
   *  ChatGPT subscription: the served default sat at OpenAI's then-published
   *  long-context pricing boundary, well below the model page's window.
   *  True that day, not a law — THIS decoded field is the derivation.) */
  contextWindow?: number
  /** The CEILING the source declares for this model (`max_context_window`).
   *  Usually equal to `contextWindow`, but genuinely larger on some rows
   *  (observed: some rows declared a ceiling well above their
   *  served default). Dropping it under-reported the reachable ceiling, so
   *  it is decoded and DISPLAYED; the budget law lives at the one context
   *  resolver (capabilities.resolveContextWindow — item C ruling). */
  maxContextWindow?: number
  /** e.g. ['text','image'] — gates input_image mapping honestly. */
  inputModalities?: string[]
}

export interface OpenaiCatalogueResult {
  models: OpenaiLiveModel[]
  fetchedAtMs: number
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function decodeLiveModel(raw: unknown): OpenaiLiveModel | undefined {
  const o = asRecord(raw)
  if (!o) return undefined
  const id = typeof o.slug === 'string' ? o.slug : typeof o.id === 'string' ? o.id : ''
  if (!id) return undefined
  const efforts: string[] = []
  const stated = Array.isArray(o.supported_reasoning_levels)
  const levels = stated ? (o.supported_reasoning_levels as unknown[]) : []
  for (const level of levels) {
    if (typeof level === 'string') efforts.push(level)
    else {
      const rec = asRecord(level)
      const value =
        typeof rec?.effort === 'string'
          ? rec.effort
          : typeof rec?.value === 'string'
            ? rec.value
            : typeof rec?.level === 'string'
              ? rec.level
              : undefined
      if (value) efforts.push(value)
    }
  }
  const modalities = Array.isArray(o.input_modalities)
    ? o.input_modalities.filter((m): m is string => typeof m === 'string')
    : undefined
  return {
    id,
    ...(typeof o.display_name === 'string' ? { displayName: o.display_name } : {}),
    ...(typeof o.default_reasoning_level === 'string'
      ? { defaultReasoningEffort: o.default_reasoning_level }
      : {}),
    supportedReasoningEfforts: efforts,
    reasoningEffortsStated: stated,
    ...(typeof o.visibility === 'string' ? { visibility: o.visibility } : {}),
    ...(typeof o.supported_in_api === 'boolean' ? { supportedInApi: o.supported_in_api } : {}),
    ...(typeof o.priority === 'number' ? { priority: o.priority } : {}),
    ...(typeof o.context_window === 'number' ? { contextWindow: o.context_window } : {}),
    ...(typeof o.max_context_window === 'number'
      ? { maxContextWindow: o.max_context_window }
      : {}),
    ...(modalities ? { inputModalities: modalities } : {}),
  }
}

/** The `client_version` the subscription /models endpoint REQUIRES (live-
 *  proved: omitting it is a Pydantic 400 'Field required'). The
 *  whole-version form (prerelease tag stripped) matches the reference
 *  client's `client_version_to_whole()`. */
function openaiClientVersionParam(): string {
  return MACRO.VERSION.split('-')[0] ?? MACRO.VERSION
}

/** Fetch the live model list for an account source. Throws typed-ly (Error
 *  message carries a stable http-NNN code) — the catalogue owner maps it. */
export async function fetchOpenaiLiveModels(options: {
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<OpenaiCatalogueResult> {
  // pairing (see streamOpenaiResponses) — the catalogue fetch rode the
  // global fetch beside the bundled dispatcher and failed on every node run.
  const fetchImpl = options.fetchImpl ?? getApiFetch()
  const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
  // The one deadline door: a caller signal composes with the bound, and a
  // breach reads 'timed out after 15s — openai did not answer'.
  const response = await fetchWithProviderDeadline(
    fetchImpl,
    'openai',
    CATALOGUE_FETCH_TIMEOUT_MS,
    `${options.baseUrl.replace(/\/$/, '')}/models?client_version=${encodeURIComponent(openaiClientVersionParam())}`,
    {
    method: 'GET',
    headers: { 'user-agent': getUserAgent(), ...options.headers },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(proxyOptions as Record<string, unknown>),
  } as RequestInit)
  // The catalogue response is authenticated too — fold any stated usage bands.
  recordOpenaiRateHeaders(response.headers)
  if (!response.ok) {
    throw new Error(`http-${response.status}`)
  }
  const body = (await response.json()) as Record<string, unknown>
  const rows = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : []
  const models: OpenaiLiveModel[] = []
  for (const raw of rows) {
    const decoded = decodeLiveModel(raw)
    if (decoded) models.push(decoded)
  }
  return { models, fetchedAtMs: Date.now() }
}

import { cachedLocalModels, localModelRecord, refreshLocalDiscovery, type LocalModelRecord, type LocalServerKind } from '../providers/local/localDiscovery.js'
import { LOCAL_MODEL_PREFIX, localContextSourceWords } from '../providers/local/localCatalogue.js'
import { chooseLocalBatch, decideLocalWindow, localBatchSettingOf, localWindowSettingOf } from '../providers/local/localWindow.js'
import { ollamaChatBody, ollamaChatUrl, streamOllamaChat, type OllamaChatKnobs } from '../providers/local/ollamaChatTransport.js'
import { streamCompatChat, type CompatChatRequest, type CompatStreamEvent, type CompatStreamOptions } from '../providers/openaicompat/compatChatClient.js'
import { tokensWords } from '../localServer/localServerMemory.js'
import { settleModelSelection, type SettledSelection } from '../../utils/model/modelTransition.js'
import { rec, resolveSetupIo, seconds } from './setupIo.js'
import { SETUP_PROVE_MAX_TOKENS, SETUP_PROVE_PROMPT, type ProveResult, type ProveTimings, type SessionModelSlice, type SetupIo } from './setupTypes.js'

export type ProveIo = SetupIo & { root?: string; server?: LocalServerKind }

export function setupModelIdOf(tag: string, server?: LocalServerKind): string {
  const listing = cachedLocalModels().filter(m => m.id.toLowerCase() === tag.toLowerCase())
  const collides = listing.length > 1
  return collides && server !== undefined ? `${LOCAL_MODEL_PREFIX}${server}/${tag}` : `${LOCAL_MODEL_PREFIX}${tag}`
}

export function proveRecordFor(tag: string, root: string | undefined, server: LocalServerKind | undefined): LocalModelRecord | undefined {
  if (root !== undefined || server !== undefined) {
    const baseUrl = root !== undefined ? `${root.replace(/\/+$/, '')}/v1` : undefined
    const hit = cachedLocalModels().find(m => m.id === tag && (server === undefined || m.server === server) && (baseUrl === undefined || m.baseUrl === baseUrl))
    if (hit) return hit
  }
  return localModelRecord(tag)
}

export function proveRequestOf(record: Pick<LocalModelRecord, 'id'>): CompatChatRequest {
  return { model: record.id, messages: [{ role: 'user', content: SETUP_PROVE_PROMPT }], extra: { max_tokens: SETUP_PROVE_MAX_TOKENS } }
}

export function proveKnobsOf(record: LocalModelRecord): OllamaChatKnobs & { window?: number } {
  const held = decideLocalWindow(record, 64, localWindowSettingOf(record))
  const window = held.window
  return {
    ...(window !== undefined ? { numCtx: window, window } : {}),
    numBatch: chooseLocalBatch(localBatchSettingOf(record), window),
    ...(record.thinkingDeclared === true ? { think: false } : {}),
  }
}

export function proveWillRun(record: LocalModelRecord): string {
  const model = setupModelIdOf(record.id, record.server)
  const request = proveRequestOf(record)
  if (record.server === 'ollama') {
    const { window: _window, ...knobs } = proveKnobsOf(record)
    return `/model ${model} · POST ${ollamaChatUrl(record.baseUrl)} ${JSON.stringify(ollamaChatBody(request, knobs))}`
  }
  const { extra, ...core } = request
  return `/model ${model} · POST ${record.baseUrl}/chat/completions ${JSON.stringify({ ...core, ...(extra ?? {}), stream: true })}`
}

function durationsOf(row: Record<string, unknown>): Partial<ProveTimings> {
  const ns = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v / 1e6 : undefined)
  const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const load = ns(row.load_duration)
  const promptMs = ns(row.prompt_eval_duration)
  const evalMs = ns(row.eval_duration)
  const promptTokens = count(row.prompt_eval_count)
  const evalTokens = count(row.eval_count)
  return {
    ...(load !== undefined ? { loadMs: load } : {}),
    ...(promptMs !== undefined ? { promptMs } : {}),
    ...(evalMs !== undefined ? { evalMs } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(evalTokens !== undefined ? { evalTokens } : {}),
  }
}

function observingFetch(fetchImpl: typeof fetch, onHeaders: () => void, onRow: (row: Record<string, unknown>) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetchImpl(input, init)
    onHeaders()
    if (!response.body) return response
    let rest = ''
    const observe = (text: string, flush: boolean): void => {
      rest += text
      const lines = rest.split('\n')
      rest = flush ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        const trimmed = line.trim().replace(/^data:\s*/, '')
        if (trimmed === '' || trimmed === '[DONE]') continue
        try {
          const row = rec(JSON.parse(trimmed))
          if (row) onRow(row)
        } catch {
          continue
        }
      }
    }
    const decoder = new TextDecoder()
    const observed = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          observe(decoder.decode(chunk, { stream: true }), false)
          controller.enqueue(chunk)
        },
        flush() {
          observe(decoder.decode(), true)
        },
      }),
    )
    return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers })
  }) as typeof fetch
}

export function proveTimingWords(t: ProveTimings): string {
  const parts: string[] = []
  if (t.loadMs !== undefined) parts.push(`load ${seconds(t.loadMs)}`)
  if (t.promptTokens !== undefined && t.promptMs !== undefined) {
    const pace = t.promptMs > 0 ? ` (${Math.round((t.promptTokens / t.promptMs) * 1000)} tok/s)` : ''
    parts.push(`ingest ${t.promptTokens} tokens in ${seconds(t.promptMs)}${pace}`)
  } else if (t.firstByteMs !== undefined) parts.push(`first byte ${seconds(t.firstByteMs)}`)
  if (t.evalTokens !== undefined && t.evalMs !== undefined) parts.push(`reply ${t.evalTokens} tokens in ${seconds(t.evalMs)}`)
  parts.push(`total ${seconds(t.totalMs)}`)
  return parts.join(' · ')
}

export async function pickAndProve(tag: string, seam: ProveIo = {}): Promise<ProveResult> {
  const io = resolveSetupIo(seam)
  const started = io.now()
  await refreshLocalDiscovery({ force: true, env: io.env, fetchImpl: io.fetchImpl, timeoutMs: io.timeoutMs, now: io.now, ...(io.signal !== undefined ? { signal: io.signal } : {}) })
  const record = proveRecordFor(tag, seam.root, seam.server)
  if (!record) {
    const model = `${LOCAL_MODEL_PREFIX}${tag}`
    return { model, wireId: tag, server: seam.server ?? 'ollama', settled: 'unavailable', saved: '', ok: false, firstLine: '', fault: `${tag} is not listed by any local server`, timings: { totalMs: io.now() - started }, words: `${tag} is not listed by any local server` }
  }
  const model = setupModelIdOf(record.id, record.server)
  let settled: ProveResult['settled'] = 'unavailable'
  if (io.setAppState) {
    let landed: SettledSelection = { kind: 'no-op', patch: null, receipt: null }
    io.setAppState(<S extends SessionModelSlice>(prev: S): S => {
      landed = settleModelSelection(prev, model, { turnActive: prev.foregroundTurnActive || prev.pendingModelSwitch !== null })
      return landed.patch ? { ...prev, ...landed.patch } : prev
    })
    settled = landed.kind
  }
  const saved = io.persist(model).sentence
  const request = proveRequestOf(record)
  const timings: ProveTimings = { totalMs: 0 }
  let doneRow: Record<string, unknown> | undefined
  const turnStarted = io.now()
  const fetchImpl = observingFetch(
    io.fetchImpl,
    () => {
      timings.firstByteMs = io.now() - turnStarted
    },
    row => {
      if (row.done === true) doneRow = row
    },
  )
  const base: CompatStreamOptions = { url: '', request, fetchImpl, ...(io.signal !== undefined ? { signal: io.signal } : {}) }
  let window: number | undefined
  let stream: AsyncGenerator<CompatStreamEvent>
  if (record.server === 'ollama') {
    const { window: held, ...knobs } = proveKnobsOf(record)
    window = held
    stream = streamOllamaChat({ ...base, url: ollamaChatUrl(record.baseUrl), firstByte: { cold: true, promptTokens: 64, model: record.id } }, knobs)
  } else {
    stream = streamCompatChat({ ...base, url: `${record.baseUrl}/chat/completions` })
  }
  let text = ''
  let fault: string | undefined
  let finished = false
  for await (const event of stream) {
    if (event.type === 'text-delta') text += event.text
    else if (event.type === 'stream-fault') fault = event.fault.message
    else if (event.type === 'finish') finished = true
  }
  timings.totalMs = io.now() - turnStarted
  if (doneRow) Object.assign(timings, durationsOf(doneRow))
  const firstLine = text
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? ''
  const ok = fault === undefined && finished && firstLine !== ''
  const windowWords =
    record.server === 'ollama'
      ? window !== undefined
        ? `${tokensWords(window)} window`
        : 'server-default window'
      : record.contextWindow !== undefined
        ? `${tokensWords(record.contextWindow.tokens)} window (${localContextSourceWords(record.contextWindow.source)})`
        : 'window not stated'
  const words = ok ? `${firstLine.slice(0, 40)} · ${model} · ${windowWords} · reply in ${seconds(timings.totalMs)}` : `no reply from ${model}: ${fault ?? (finished ? 'an empty reply' : 'the stream ended early')}`
  return {
    model,
    wireId: record.id,
    server: record.server,
    settled,
    saved,
    ok,
    firstLine,
    ...(fault !== undefined ? { fault } : {}),
    ...(window !== undefined ? { window } : {}),
    timings,
    words,
  }
}

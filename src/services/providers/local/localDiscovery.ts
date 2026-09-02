// ============================================================================
//  providers/local/localDiscovery — the bounded LIVE discovery of locally
//  served models (Ollama · LM Studio · vLLM · llama.cpp-server).
// ----------------------------------------------------------------------------
//  Live over static (law 1): which local models exist is only ever the
//  servers' own answer. Every probe is a loopback GET/POST bounded by a
//  short per-request timeout, run in parallel, never on the first-paint
//  path (boot kicks it fire-and-forget; /model open refreshes behind a
//  short TTL). Nothing is downloaded, nothing bundled, nothing started.
//
//  The documented shapes (all fetched/read):
//    Ollama (:11434)   — GET /api/version {version}; GET /api/tags {models:
//      [{name, model, details{family, parameter_size, quantization_level},
//      capabilities?}]}; GET /api/ps {models: [{name, model, context_length,
//      expires_at}]} (the SERVED context of a loaded model); POST /api/show
//      {model} → {capabilities: ['completion','tools','thinking','vision',
//      …], model_info{'general.architecture', '<arch>.context_length'},
//      parameters ('num_ctx N' when a Modelfile sets it)}. The server's
//      default context is 4096 tokens (docs.ollama.com/faq), raised by
//      OLLAMA_CONTEXT_LENGTH or num_ctx — the OpenAI-compatible surface
//      cannot set it per request. Chat rides /v1/chat/completions (api key
//      required-but-ignored; tool_choice unsupported).
//    LM Studio (:1234) — GET /api/v1/models (0.4+) {models: [{key,
//      display_name, type 'llm'|'embedding', max_context_length,
//      loaded_instances: [{config{context_length}}], capabilities{vision,
//      trained_for_tool_use}, reasoning?{allowed_options}}]}; older builds
//      GET /api/v0/models {data: [{id, type, state, max_context_length}]};
//      auth is OFF by default (an API token can be required in Server
//      Settings). Chat rides /v1/chat/completions.
//    vLLM (:8000)      — GET /v1/models {data: [{id, owned_by 'vllm',
//      max_model_len, root}]} — max_model_len IS the served window;
//      --api-key optional.
//    llama.cpp (:8080) — GET /health {status:'ok'} (public; 503 while
//      loading); GET /v1/models {data: [{id, owned_by 'llamacpp', meta
//      {n_ctx_train, …} | null}]}; GET /props {default_generation_settings
//      {n_ctx}, modalities{vision}, build_info, model_path} — n_ctx is the
//      served slot context; router mode GET /models {data: [{id, status
//      {value 'loaded'|'unloaded'|'loading'|'sleeping'|'downloading'}}]}.
//
//  Context truth per model is SERVED-first: a loaded instance's stated
//  length, else a Modelfile/server setting, else the server's documented
//  default (Ollama), else the model's trained maximum LABELLED as such —
//  never an invented number; absent means absent.
//
//  Laws: a bounded cache (one snapshot, short TTL, single-flight); reads are
//  sync + free; the `io` seam injects env/fetch/clock for hermetic proof;
//  MERCURY_LOCAL_PROBE_TARGETS pins the probe set (fixture ports — `none`
//  disables probing); MERCURY_LOCAL_BASE_URL adds an operator-named server
//  whose kind is sniffed. Values that could be secrets never enter a record
//  (an API token only rides the probe headers).
// ============================================================================
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { getApiFetch } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import type { LocalServerKind } from '../openaicompat/compatWire.js'
import { resolveLocalApiKey } from './localAccounts.js'

export type { LocalServerKind }

/** The default probe set — the servers' documented default ports. */
export const DEFAULT_LOCAL_PROBE_TARGETS: readonly { kind: LocalServerKind; root: string }[] = [
  { kind: 'ollama', root: 'http://127.0.0.1:11434' },
  { kind: 'lmstudio', root: 'http://127.0.0.1:1234' },
  { kind: 'vllm', root: 'http://127.0.0.1:8000' },
  { kind: 'llamacpp', root: 'http://127.0.0.1:8080' },
]

/** Per-request bound: a loopback answer arrives in milliseconds; a closed
 *  port refuses instantly; a wedged server must never hold a paint. */
export const LOCAL_PROBE_TIMEOUT_MS = 900
/** Ollama's documented default context window (docs.ollama.com/faq). */
export const OLLAMA_DEFAULT_CONTEXT = 4096
/** How many Ollama models get the per-model /api/show probe. */
const OLLAMA_SHOW_BOUND = 32

export type LocalContextSource = 'served' | 'modelfile' | 'server-default' | 'model-max'

export interface LocalModelRecord {
  /** The id exactly as the server lists it (the wire model name). */
  id: string
  displayName?: string
  server: LocalServerKind
  /** The OpenAI-compatible base this model is served from ('…/v1'). */
  baseUrl: string
  /** The context window with the source it came from (see the header). */
  contextWindow?: { tokens: number; source: LocalContextSource }
  /** The trained maximum when the server states it separately. */
  modelMaxContext?: number
  /** Stated capability flags — absent = the server stated nothing. */
  toolsDeclared?: boolean
  thinkingDeclared?: boolean
  visionDeclared?: boolean
  /** Load state when the server states one. */
  loaded?: boolean
  family?: string
  parameterSize?: string
  quantization?: string
}

export interface LocalServerRecord {
  kind: LocalServerKind
  /** The server root ('http://127.0.0.1:11434'). */
  root: string
  /** The OpenAI-compatible base ('http://127.0.0.1:11434/v1'). */
  baseUrl: string
  /** Display words ('Ollama 0.11.4'). */
  label: string
  version?: string
  models: LocalModelRecord[]
}

export interface LocalDiscoverySnapshot {
  servers: LocalServerRecord[]
  probedAtMs: number
  /** How many targets were probed (0 = probing disabled). */
  targetCount: number
}

export interface LocalDiscoveryIo {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

const KINDS: readonly LocalServerKind[] = ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'openai-compatible']
function isKind(v: string): v is LocalServerKind {
  return (KINDS as readonly string[]).includes(v)
}

/** The probe targets: MERCURY_LOCAL_PROBE_TARGETS (CSV of kind=url; `none`
 *  ⇒ nothing) else the documented defaults; MERCURY_LOCAL_BASE_URL adds an
 *  operator-named server (kind sniffed). The quoted spellings key the
 *  flag-registry consumer-liveness sweep. */
export function localProbeTargets(
  env: NodeJS.ProcessEnv = process.env,
): { kind: LocalServerKind; root: string }[] {
  const pinned = env['MERCURY_LOCAL_PROBE_TARGETS']?.trim()
  let targets: { kind: LocalServerKind; root: string }[]
  if (pinned === undefined || pinned === '') {
    targets = [...DEFAULT_LOCAL_PROBE_TARGETS]
  } else if (pinned.toLowerCase() === 'none') {
    targets = []
  } else {
    targets = []
    for (const entry of pinned.split(',')) {
      const [kindRaw, ...rest] = entry.split('=')
      const kind = (kindRaw ?? '').trim().toLowerCase()
      const root = rest.join('=').trim().replace(/\/+$/, '')
      if (isKind(kind) && root) targets.push({ kind, root })
    }
  }
  const override = env['MERCURY_LOCAL_BASE_URL']?.trim()
  if (override) {
    const root = override.replace(/\/+$/, '').replace(/\/v1$/, '')
    if (!targets.some(t => t.root === root)) targets.push({ kind: 'openai-compatible', root })
  }
  return targets
}

// ── Bounded HTTP ────────────────────────────────────────────────────────────

async function probeJson(
  url: string,
  io: LocalDiscoveryIo,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<unknown | undefined> {
  const fetchImpl = io.fetchImpl ?? getApiFetch()
  const timeoutMs = io.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS
  const key = resolveLocalApiKey(io.env ?? process.env)
  try {
    // The one deadline door (field F-6.2): the bound and the honest breach
    // words travel together, even though this probe's catch answers with
    // silence rather than a sentence.
    const response = await fetchWithProviderDeadline(fetchImpl, 'local', timeoutMs, url, {
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': getUserAgent(),
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { authorization: `Bearer ${key.key}` } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    } as RequestInit)
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  }
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}
function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined
}

// ── Ollama ──────────────────────────────────────────────────────────────────

export async function probeOllama(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const tags = rec(await probeJson(`${root}/api/tags`, io))
  if (!tags || !Array.isArray(tags.models)) return undefined
  const [versionBody, psBody] = await Promise.all([
    probeJson(`${root}/api/version`, io),
    probeJson(`${root}/api/ps`, io),
  ])
  const version = str(rec(versionBody)?.version)
  const served = new Map<string, number>()
  for (const loaded of (Array.isArray(rec(psBody)?.models) ? (rec(psBody)!.models as unknown[]) : [])) {
    const l = rec(loaded)
    const name = str(l?.model) ?? str(l?.name)
    const ctx = num(l?.context_length)
    if (name && ctx) served.set(name, ctx)
  }
  const listed = (tags.models as unknown[]).map(rec).filter((m): m is Record<string, unknown> => m !== undefined)
  const baseUrl = `${root}/v1`
  const models = await Promise.all(
    listed.slice(0, OLLAMA_SHOW_BOUND).map(async (m): Promise<LocalModelRecord | undefined> => {
      const id = str(m.model) ?? str(m.name)
      if (!id) return undefined
      const details = rec(m.details)
      const show = rec(await probeJson(`${root}/api/show`, io, { method: 'POST', body: { model: id } }))
      const capabilities = strList(show?.capabilities) ?? strList(m.capabilities)
      const info = rec(show?.model_info)
      const arch = str(info?.['general.architecture'])
      const modelMax = arch ? num(info?.[`${arch}.context_length`]) : undefined
      const params = str(show?.parameters)
      const numCtx = params ? num(Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(params)?.[1])) : undefined
      const servedCtx = served.get(id)
      const contextWindow: LocalModelRecord['contextWindow'] = servedCtx
        ? { tokens: servedCtx, source: 'served' }
        : numCtx
          ? { tokens: numCtx, source: 'modelfile' }
          : { tokens: OLLAMA_DEFAULT_CONTEXT, source: 'server-default' }
      return {
        id,
        server: 'ollama',
        baseUrl,
        contextWindow,
        ...(modelMax !== undefined ? { modelMaxContext: modelMax } : {}),
        ...(capabilities
          ? {
              toolsDeclared: capabilities.includes('tools'),
              thinkingDeclared: capabilities.includes('thinking'),
              visionDeclared: capabilities.includes('vision'),
            }
          : {}),
        loaded: served.has(id),
        ...(str(details?.family) ? { family: str(details?.family)! } : {}),
        ...(str(details?.parameter_size) ? { parameterSize: str(details?.parameter_size)! } : {}),
        ...(str(details?.quantization_level) ? { quantization: str(details?.quantization_level)! } : {}),
      }
    }),
  )
  return {
    kind: 'ollama',
    root,
    baseUrl,
    label: version ? `Ollama ${version}` : 'Ollama',
    ...(version ? { version } : {}),
    models: models.filter((m): m is LocalModelRecord => m !== undefined),
  }
}

// ── LM Studio ───────────────────────────────────────────────────────────────

export async function probeLmStudio(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const baseUrl = `${root}/v1`
  const v1 = rec(await probeJson(`${root}/api/v1/models`, io))
  if (v1 && Array.isArray(v1.models)) {
    const models: LocalModelRecord[] = []
    for (const raw of v1.models as unknown[]) {
      const m = rec(raw)
      const id = str(m?.key)
      if (!m || !id) continue
      if (str(m.type) === 'embedding') continue
      const instances = Array.isArray(m.loaded_instances) ? (m.loaded_instances as unknown[]).map(rec) : []
      const servedCtx = instances.map(i => num(rec(i?.config)?.context_length)).find((n): n is number => n !== undefined)
      const modelMax = num(m.max_context_length)
      const caps = rec(m.capabilities)
      const quant = rec(m.quantization)
      models.push({
        id,
        ...(str(m.display_name) ? { displayName: str(m.display_name)! } : {}),
        server: 'lmstudio',
        baseUrl,
        ...(servedCtx
          ? { contextWindow: { tokens: servedCtx, source: 'served' } }
          : modelMax
            ? { contextWindow: { tokens: modelMax, source: 'model-max' } }
            : {}),
        ...(modelMax !== undefined ? { modelMaxContext: modelMax } : {}),
        ...(typeof caps?.trained_for_tool_use === 'boolean' ? { toolsDeclared: caps.trained_for_tool_use } : {}),
        ...(typeof caps?.vision === 'boolean' ? { visionDeclared: caps.vision } : {}),
        ...(rec(m.reasoning) ? { thinkingDeclared: true } : {}),
        loaded: instances.length > 0,
        ...(str(m.architecture) ? { family: str(m.architecture)! } : {}),
        ...(str(m.params_string) ? { parameterSize: str(m.params_string)! } : {}),
        ...(str(quant?.name) ? { quantization: str(quant?.name)! } : {}),
      })
    }
    return { kind: 'lmstudio', root, baseUrl, label: 'LM Studio', models }
  }
  const v0 = rec(await probeJson(`${root}/api/v0/models`, io))
  if (v0 && Array.isArray(v0.data)) {
    const models: LocalModelRecord[] = []
    for (const raw of v0.data as unknown[]) {
      const m = rec(raw)
      const id = str(m?.id)
      if (!m || !id) continue
      if (str(m.type) === 'embeddings') continue
      const modelMax = num(m.max_context_length)
      models.push({
        id,
        server: 'lmstudio',
        baseUrl,
        ...(modelMax ? { contextWindow: { tokens: modelMax, source: 'model-max' }, modelMaxContext: modelMax } : {}),
        ...(str(m.state) ? { loaded: str(m.state) === 'loaded' } : {}),
        ...(str(m.arch) ? { family: str(m.arch)! } : {}),
        ...(str(m.quantization) ? { quantization: str(m.quantization)! } : {}),
      })
    }
    return { kind: 'lmstudio', root, baseUrl, label: 'LM Studio', models }
  }
  return undefined
}

// ── vLLM ────────────────────────────────────────────────────────────────────

function openaiModelList(body: unknown): Record<string, unknown>[] | undefined {
  const o = rec(body)
  if (!o || !Array.isArray(o.data)) return undefined
  return (o.data as unknown[]).map(rec).filter((m): m is Record<string, unknown> => m !== undefined)
}

export async function probeVllm(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const list = openaiModelList(await probeJson(`${root}/v1/models`, io))
  if (!list) return undefined
  const baseUrl = `${root}/v1`
  const models: LocalModelRecord[] = []
  for (const m of list) {
    const id = str(m.id)
    if (!id) continue
    const served = num(m.max_model_len)
    models.push({
      id,
      server: 'vllm',
      baseUrl,
      ...(served ? { contextWindow: { tokens: served, source: 'served' } } : {}),
    })
  }
  return { kind: 'vllm', root, baseUrl, label: 'vLLM', models }
}

// ── llama.cpp-server ────────────────────────────────────────────────────────

export async function probeLlamaCpp(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const [v1Body, propsBody, routerBody] = await Promise.all([
    probeJson(`${root}/v1/models`, io),
    probeJson(`${root}/props`, io),
    probeJson(`${root}/models`, io),
  ])
  const list = openaiModelList(v1Body)
  const props = rec(propsBody)
  if (!list && !props) return undefined
  const baseUrl = `${root}/v1`
  const servedCtx = num(rec(props?.default_generation_settings)?.n_ctx)
  const vision = typeof rec(props?.modalities)?.vision === 'boolean' ? (rec(props?.modalities)!.vision as boolean) : undefined
  const build = str(props?.build_info)
  const models: LocalModelRecord[] = []
  const routerList = openaiModelList(routerBody)
  if (routerList && routerList.length > 0) {
    for (const m of routerList) {
      const id = str(m.id)
      if (!id) continue
      const status = str(rec(m.status)?.value)
      const loaded = status === 'loaded'
      models.push({
        id,
        server: 'llamacpp',
        baseUrl,
        ...(loaded && servedCtx ? { contextWindow: { tokens: servedCtx, source: 'served' } } : {}),
        ...(status ? { loaded } : {}),
        ...(vision !== undefined ? { visionDeclared: vision } : {}),
      })
    }
  } else if (list) {
    for (const m of list) {
      const id = str(m.id)
      if (!id) continue
      const meta = rec(m.meta)
      const trained = num(meta?.n_ctx_train)
      models.push({
        id,
        server: 'llamacpp',
        baseUrl,
        ...(servedCtx
          ? { contextWindow: { tokens: servedCtx, source: 'served' } }
          : trained
            ? { contextWindow: { tokens: trained, source: 'model-max' } }
            : {}),
        ...(trained !== undefined ? { modelMaxContext: trained } : {}),
        loaded: meta !== undefined,
        ...(vision !== undefined ? { visionDeclared: vision } : {}),
      })
    }
  }
  return {
    kind: 'llamacpp',
    root,
    baseUrl,
    label: build ? `llama.cpp ${build}` : 'llama.cpp',
    ...(build ? { version: build } : {}),
    models,
  }
}

// ── An operator-named server: sniff the kind, then the kind's probe ─────────

export async function probeOpenaiCompatible(root: string, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  const ollama = await probeOllama(root, io)
  if (ollama) return ollama
  const lmstudio = await probeLmStudio(root, io)
  if (lmstudio) return lmstudio
  const llamacpp = rec(await probeJson(`${root}/props`, io)) ? await probeLlamaCpp(root, io) : undefined
  if (llamacpp) return llamacpp
  const list = openaiModelList(await probeJson(`${root}/v1/models`, io))
  if (!list) return undefined
  if (list.some(m => str(m.owned_by) === 'vllm' || num(m.max_model_len) !== undefined)) return probeVllm(root, io)
  if (list.some(m => str(m.owned_by) === 'llamacpp')) return probeLlamaCpp(root, io)
  const baseUrl = `${root}/v1`
  const models: LocalModelRecord[] = []
  for (const m of list) {
    const id = str(m.id)
    if (id) models.push({ id, server: 'openai-compatible', baseUrl })
  }
  return { kind: 'openai-compatible', root, baseUrl, label: 'OpenAI-compatible server', models }
}

async function probeTarget(target: { kind: LocalServerKind; root: string }, io: LocalDiscoveryIo): Promise<LocalServerRecord | undefined> {
  switch (target.kind) {
    case 'ollama':
      return probeOllama(target.root, io)
    case 'lmstudio':
      return probeLmStudio(target.root, io)
    case 'vllm':
      return probeVllm(target.root, io)
    case 'llamacpp':
      return probeLlamaCpp(target.root, io)
    case 'openai-compatible':
      return probeOpenaiCompatible(target.root, io)
  }
}

/** Probe every target in parallel; a target that does not answer is simply
 *  absent (no phantom rows). Never throws. */
export async function discoverLocalServers(io: LocalDiscoveryIo = {}): Promise<LocalDiscoverySnapshot> {
  const env = io.env ?? process.env
  const targets = localProbeTargets(env)
  const results = await Promise.all(targets.map(t => probeTarget(t, io).catch(() => undefined)))
  const servers = results.filter((s): s is LocalServerRecord => s !== undefined)
  return { servers, probedAtMs: io.now?.() ?? Date.now(), targetCount: targets.length }
}

// ── The bounded cache (one snapshot; short TTL; single-flight) ──────────────

/** Local state changes often (models pulled, servers started) — a short
 *  TTL keeps /model honest without a probe per keystroke. */
export const LOCAL_DISCOVERY_TTL_MS = 60_000

let cached: LocalDiscoverySnapshot | null = null
let inFlight: Promise<LocalDiscoverySnapshot> | null = null

/** Sync cache read — free; null when never probed. */
export function getCachedLocalDiscovery(): LocalDiscoverySnapshot | null {
  return cached
}

/** Async refresh honoring the TTL (force bypasses). Single-flight. */
export function refreshLocalDiscovery(opts?: LocalDiscoveryIo & { force?: boolean }): Promise<LocalDiscoverySnapshot> {
  const now = opts?.now ?? Date.now
  if (!opts?.force && cached && now() - cached.probedAtMs < LOCAL_DISCOVERY_TTL_MS) return Promise.resolve(cached)
  if (inFlight) return inFlight
  const { force: _force, ...io } = opts ?? {}
  inFlight = (async (): Promise<LocalDiscoverySnapshot> => {
    try {
      const snapshot = await discoverLocalServers(io)
      cached = snapshot
      // A discovery snapshot decides a local id's served window
      // (capabilities.ts) — surfaces re-derive on the change.
      bumpCatalogueEpoch()
      return snapshot
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Every discovered model, in server order (the picker's order). */
export function cachedLocalModels(): LocalModelRecord[] {
  return cached ? cached.servers.flatMap(s => s.models) : []
}

/** The record for a wire model name. A `<server>/<id>` spelling (the form
 *  the picker mints when two servers list the SAME id) resolves to exactly
 *  that server's record — without the namespace the first server listing a
 *  colliding id silently won every resolution and the other server's model
 *  was unreachable. A bare id resolves first-listed (unambiguous when no
 *  collision exists — the picker persists bare ids only for those); a
 *  qualified miss falls through to the bare match so a genuine id that
 *  merely starts with a server word stays reachable. */
export function localModelRecord(wireId: string): LocalModelRecord | undefined {
  const lower = wireId.trim().toLowerCase()
  const slash = lower.indexOf('/')
  if (slash > 0) {
    const kind = lower.slice(0, slash)
    if ((KINDS as readonly string[]).includes(kind)) {
      const rest = lower.slice(slash + 1)
      const qualified = cachedLocalModels().find(m => m.server === kind && m.id.toLowerCase() === rest)
      if (qualified) return qualified
    }
  }
  return cachedLocalModels().find(m => m.id.toLowerCase() === lower)
}

/** The server record a model belongs to. */
export function localServerFor(model: LocalModelRecord): LocalServerRecord | undefined {
  return cached?.servers.find(s => s.baseUrl === model.baseUrl && s.kind === model.server)
}

/** Proof seam — clears cache + in-flight state. */
export function __resetLocalDiscoveryForTest(): void {
  cached = null
  inFlight = null
}

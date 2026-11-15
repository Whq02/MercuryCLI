import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { startEngineRules } from './fixtures/engineRules.mjs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = mkdtempSync(resolve(process.env.MERCURY_CONFIG_DIR, 'tensorfold-llmhost-dialect-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['MERCURY_HOME', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_MODELS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1') throw new Error(`TensorFold dialect proof refused non-loopback fetch: ${url.origin}`)
  return realFetch(input, init)
}) as typeof fetch

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}

type StandIn = { baseUrl: string; asked: string[]; close(): void }
function stand(route: (path: string) => unknown | undefined, headers: Record<string, string> = {}): StandIn {
  const asked: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request: Request) {
      const path = new URL(request.url).pathname
      asked.push(path)
      const body = route(path)
      return body === undefined ? Response.json({ error: { message: `unknown path ${path}` } }, { status: 404, headers }) : Response.json(body, { headers })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, asked, close: () => server.stop(true) }
}

const MODEL = 'qwen3.8-27b'
const WINDOW = 131072
const row = (owner: string, id = MODEL): Record<string, unknown> => ({ id, object: 'model', created: 1794700000, owned_by: owner, capabilities: { reasoning: true, prompt_cache: true, thinking_switch: true }, context_length: WINDOW, max_model_len: WINDOW, reasoning: { default_enabled: true, supported_efforts: ['low', 'medium', 'xhigh', 'none'] }, input_types: ['text'] })
const ollamaRoutes = (path: string, models: string[]): unknown | undefined =>
  path === '/api/tags' || path === '/api/ps' ? { models: models.map(name => ({ name, model: name })) }
    : path === '/api/show' ? { modelfile: '', parameters: '', template: '', details: {} }
      : path === '/api/version' ? { version: '1.2.9' } : undefined
const tensorFold = (answersOllama: boolean): StandIn => stand(path => path === '/v1/models' ? { object: 'list', data: [row('tensorfold')] } : answersOllama ? ollamaRoutes(path, [MODEL]) : undefined, { server: 'TensorFold' })

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { inspectCompatServer } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
const { hostModelEfforts } = await import('../../src/services/providers/openaicompat/compatEffort.ts')
const { buildHostedExtras, LOCAL_SERVER_EFFORTS } = await import('../../src/services/providers/openaicompat/compatWire.ts')

const engine = tensorFold(true)
const older = tensorFold(false)
const ollama = await startEngineRules('ollama')
const vllm = await startEngineRules('vllm')
const empty = stand(path => path === '/v1/models' ? { object: 'list', data: [] } : ollamaRoutes(path, []))
const mixed = stand(path => path === '/v1/models' ? { object: 'list', data: [row('tensorfold'), row('library', 'qwen3.5:9b')] } : ollamaRoutes(path, [MODEL, 'qwen3.5:9b']))
try {
  const tags = await (await realFetch(`${engine.baseUrl.replace(/\/v1$/, '')}/api/tags`)).json() as { models?: unknown[] }
  check('the stand-in answers /api/tags with a models list beside its own /v1/models, as TensorFold does from 1.2.9', Array.isArray(tags.models) && tags.models.length === 1, tags)
  engine.asked.length = 0
  const detected = await inspectCompatServer({ baseUrl: engine.baseUrl }, { detect: true })
  check('a TensorFold engine that answers Ollama\u2019s API is proposed as vllm, as an engine that does not is', detected.dialect === 'vllm', detected.dialect)
  check('the detecting probe asks it /api/tags once and none of Ollama\u2019s other routes', engine.asked.filter(path => path.startsWith('/api/')).join(',') === '/api/tags', engine.asked)
  engine.asked.length = 0
  const reading = await inspectCompatServer({ baseUrl: engine.baseUrl, dialect: detected.dialect ?? 'chat-completions' })
  const levels = hostModelEfforts(MODEL, detected.dialect ?? 'chat-completions', reading.efforts?.[MODEL])
  check('under the proposed dialect the model has the six effort levels', JSON.stringify(levels) === JSON.stringify(LOCAL_SERVER_EFFORTS.vllm) && levels.length === 6, { stated: reading.efforts, levels })
  const extras = buildHostedExtras({ wireModel: MODEL, effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: undefined, dialect: detected.dialect ?? 'chat-completions', vocabulary: levels })
  check('a request at effort high carries reasoning_effort high', extras.reasoning_effort === 'high', extras)
  check('its window is the one its model list serves', reading.contextWindows[MODEL] === WINDOW && reading.models.join() === MODEL, reading)
  check('under the proposed dialect the probe reads the model list alone', engine.asked.join(',') === '/v1/models', engine.asked)

  const before = await inspectCompatServer({ baseUrl: older.baseUrl }, { detect: true })
  check('a TensorFold engine without Ollama\u2019s routes, as 1.2.8 and earlier answer, is proposed as vllm', before.dialect === 'vllm', before.dialect)

  const ollamaDetected = await inspectCompatServer({ baseUrl: ollama.baseUrl }, { detect: true })
  check('an Ollama server is proposed as ollama', ollamaDetected.dialect === 'ollama', ollamaDetected.dialect)
  check('and its tools, images and thinking still read from /api/show', ollamaDetected.capabilities?.[ollama.model]?.tools === true && ollamaDetected.capabilities?.[ollama.model]?.images === true && ollamaDetected.capabilities?.[ollama.model]?.reasoning === true && ollamaDetected.contextWindows[ollama.model] === 131072, ollamaDetected)
  const vllmDetected = await inspectCompatServer({ baseUrl: vllm.baseUrl }, { detect: true })
  check('a vLLM server is proposed as vllm', vllmDetected.dialect === 'vllm', vllmDetected.dialect)
  const emptyDetected = await inspectCompatServer({ baseUrl: empty.baseUrl }, { detect: true })
  check('a server that answers /api/tags and lists no model is proposed as ollama', emptyDetected.dialect === 'ollama' && emptyDetected.models.length === 0, emptyDetected)
  const mixedDetected = await inspectCompatServer({ baseUrl: mixed.baseUrl }, { detect: true })
  check('a server that answers /api/tags and lists another owner\u2019s model beside a TensorFold one is proposed as ollama', mixedDetected.dialect === 'ollama', mixedDetected.dialect)
} finally {
  engine.close()
  older.close()
  empty.close()
  mixed.close()
  await Promise.all([ollama.close(), vllm.close()])
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-tensorfold-llmhost-dialect: ${checks} checks, ${failures} failed`)
process.exitCode = failures ? 1 : 0

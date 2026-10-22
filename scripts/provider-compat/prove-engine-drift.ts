import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { startEngineRules } from './fixtures/engineRules.mjs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = mkdtempSync(resolve(process.env.MERCURY_CONFIG_DIR, 'engine-drift-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['MERCURY_HOME', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_MODELS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1') throw new Error(`Engine drift proof refused non-loopback fetch: ${url.origin}`)
  return realFetch(input, init)
}) as typeof fetch

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { inspectCompatServer } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
const { readCompatPrefillSpeed } = await import('../../src/services/providers/openaicompat/compatPrefill.ts')

const current = await startEngineRules('sglang')
const legacy = await startEngineRules('sglang', { legacyOnly: true })
const dark = await startEngineRules('sglang', { images: false, tools: false, reasoning: false })
try {
  const root = current.baseUrl.replace(/\/v1$/, '')
  const today = await (await realFetch(`${root}/model_info`)).json() as Record<string, unknown>
  check('the SGLang fixture answers /model_info with the fields the server source names today and no context_length', today.model_path === current.model && today.served_model_name === current.model && typeof today.has_image_understanding === 'boolean' && 'tool_call_parser' in today && 'reasoning_parser' in today && !('context_length' in today), today)
  check('the SGLang fixture retires /get_model_info like the server source says it will', (await realFetch(`${root}/get_model_info`)).status === 404)
  const legacyRoot = legacy.baseUrl.replace(/\/v1$/, '')
  check('the legacy SGLang fixture serves only the retired path', (await realFetch(`${legacyRoot}/model_info`)).status === 404 && (await realFetch(`${legacyRoot}/get_model_info`)).status === 200)

  const reading = await inspectCompatServer({ baseUrl: current.baseUrl, dialect: 'sglang' })
  check('a current SGLang server still yields its image, tool and reasoning facts through /model_info', reading.capabilities?.[current.model]?.images === true && reading.capabilities?.[current.model]?.tools === true && reading.capabilities?.[current.model]?.reasoning === true, reading)
  check('the context window of a current SGLang server comes from max_model_len on /v1/models', reading.contextWindows[current.model] === 131072, reading.contextWindows)
  const detected = await inspectCompatServer({ baseUrl: current.baseUrl }, { detect: true })
  check('a current SGLang server is still recognised as SGLang without a declared dialect', detected.dialect === 'sglang', detected)
  const darkReading = await inspectCompatServer({ baseUrl: dark.baseUrl, dialect: 'sglang' })
  check('explicit false facts on /model_info stay false', darkReading.capabilities?.[dark.model]?.images === false && darkReading.capabilities?.[dark.model]?.tools === false && darkReading.capabilities?.[dark.model]?.reasoning === false, darkReading)

  const legacyReading = await inspectCompatServer({ baseUrl: legacy.baseUrl, dialect: 'sglang' })
  check('an older SGLang server that only serves /get_model_info still yields its facts', legacyReading.capabilities?.[legacy.model]?.images === true && legacyReading.capabilities?.[legacy.model]?.tools === true && legacyReading.capabilities?.[legacy.model]?.reasoning === true, legacyReading)
  const legacyDetected = await inspectCompatServer({ baseUrl: legacy.baseUrl }, { detect: true })
  check('an older SGLang server is still recognised as SGLang', legacyDetected.dialect === 'sglang', legacyDetected)

  const speed = await readCompatPrefillSpeed({ baseUrl: current.baseUrl, dialect: 'sglang' }, current.model)
  check('the prefill speed of a current SGLang server reads through /model_info and /metrics', speed === 500, speed)
  const legacySpeed = await readCompatPrefillSpeed({ baseUrl: legacy.baseUrl, dialect: 'sglang' }, legacy.model)
  check('the prefill speed of an older SGLang server reads through the retired path', legacySpeed === 500, legacySpeed)
  const infoRequests = current.requests.length
  check('the engine fixture logs no chat requests for discovery reads', infoRequests === 0, infoRequests)
} finally {
  await Promise.all([current.close(), legacy.close(), dark.close()])
  globalThis.fetch = realFetch
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-engine-drift: ${checks} checks, ${failures} failed`)
process.exitCode = failures ? 1 : 0

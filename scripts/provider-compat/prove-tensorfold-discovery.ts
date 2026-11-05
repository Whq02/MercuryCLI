#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'tensorfold-discovery-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json', server: 'fixture' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}`, port })
    })
  })
}
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): true {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
  return true
}

const FIXTURES = join(import.meta.dir, 'fixtures', 'tensorfold')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

function tensorFoldRoutes(opts: { model: string; window: number; key?: string; reasoning?: unknown }): Route {
  const models = { object: 'list', data: [{ id: opts.model, object: 'model', created: 1793822261, owned_by: 'tensorfold', context_length: opts.window, max_model_len: opts.window, ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}) }] }
  const openHealth = { ...(fixture('health-open.json') as Record<string, unknown>), model: opts.model, model_ids: [opts.model] }
  return (req, _body, res) => {
    const url = req.url ?? ''
    const headers = { server: 'TensorFold' }
    if (req.method === 'GET' && (url === '/health' || url === '/')) return json(res, 200, opts.key !== undefined ? { status: 'ok' } : openHealth, headers)
    if (req.method === 'GET' && /\/models$/.test(url)) {
      if (opts.key !== undefined && req.headers.authorization !== `Bearer ${opts.key}`) {
        return json(res, 401, { error: { message: 'A valid API key is required', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }, { ...headers, 'www-authenticate': 'Bearer' })
      }
      return json(res, 200, models, headers)
    }
    if (req.method === 'GET' && (url === '/memory' || url === '/v1/memory')) {
      if (opts.key !== undefined) return json(res, 401, { error: { message: 'A valid API key is required', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }, headers)
      return json(res, 200, fixture('memory.json'), headers)
    }
    if (req.method === 'GET' && url === '/props') return json(res, 404, { error: { message: 'unknown path /props' } }, headers)
    return json(res, 404, { error: { message: `unknown path ${url}` } }, headers)
  }
}

const KEY = 'fixture-key-0123456789abcdef0123456789abcdef'
const onLlamaPort = await serve(tensorFoldRoutes({ model: 'qwen3.5-2b', window: 32768, reasoning: { default_enabled: true } }))
const onVllmPort = await serve(tensorFoldRoutes({ model: 'nemotron-lightning', window: 262144, reasoning: { default_enabled: true, supported_efforts: ['high', 'medium', 'low', 'none'] } }))
const onLmStudioPort = await serve(tensorFoldRoutes({ model: 'qwen3.8-27b', window: 131072, reasoning: { default_enabled: true, supported_efforts: ['xhigh', 'medium', 'low', 'none'] } }))
const remembered = await serve(tensorFoldRoutes({ model: 'qwen3.5-2b', window: 32768 }))
const overridden = await serve(tensorFoldRoutes({ model: 'qwen3.8-27b', window: 131072, reasoning: { default_enabled: true, supported_efforts: ['xhigh', 'medium', 'low', 'none'] } }))
const keyed = await serve(tensorFoldRoutes({ model: 'qwen3.8-27b', window: 131072, key: KEY, reasoning: { default_enabled: true, supported_efforts: ['xhigh', 'medium', 'low', 'none'] } }))

const llamacpp = await serve((req, _body, res) => {
  const url = req.url ?? ''
  if (url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'qwen3.5-9b-q4', object: 'model', created: 1, owned_by: 'llamacpp', meta: { n_ctx: 32768, n_ctx_train: 262144, size: 6000000000, n_params: 9000000000 } }] })
  if (url === '/props') return json(res, 200, { build_info: 'b7000-abc', default_generation_settings: { n_ctx: 32768 }, modalities: { vision: false } })
  if (url === '/models') return json(res, 200, { object: 'list', data: [] })
  if (url === '/health') return json(res, 200, { status: 'ok' })
  return false
})
const lmstudio = await serve((req, _body, res) => {
  const url = req.url ?? ''
  if (url === '/api/v1/models') return json(res, 200, { models: [{ key: 'qwen3.5-9b', type: 'llm', display_name: 'Qwen3.5 9B', max_context_length: 262144, loaded_instances: [{ id: 'i1', config: { context_length: 32768 } }], capabilities: { trained_for_tool_use: true, vision: false } }] })
  return false
})
const vllm = await serve((req, _body, res) => {
  const url = req.url ?? ''
  if (url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'Qwen/Qwen3.8-27B-FP8', object: 'model', created: 1, owned_by: 'vllm', max_model_len: 131072 }] })
  return false
})

process.env.MERCURY_LOCAL_PROBE_TARGETS = [`llamacpp=${onLlamaPort.root}`, `vllm=${onVllmPort.root}`, `lmstudio=${onLmStudioPort.root}`, `llamacpp=${llamacpp.root}`, `lmstudio=${lmstudio.root}`, `vllm=${vllm.root}`].join(',')
process.env.MERCURY_LOCAL_BASE_URL = `${overridden.root}/v1`

section('§0 the hosts store and the remembered port (red on the base: the seam stubs throw)')
let stored = false
try {
  const hosts = await import('../../src/services/providers/local/tensorfoldHosts.js')
  hosts.rememberTensorFoldPort(remembered.port)
  await hosts.rememberTensorFoldHost({ name: 'studio', baseUrl: keyed.root, origin: 'typed', key: KEY, version: '1.2.2', chip: 'Apple M3 Ultra' })
  check('the remembered port is listed', hosts.tensorFoldPorts().includes(remembered.port))
  check('the host is listed without its key', hosts.tensorFoldHosts().some(host => host.name === 'studio' && !('key' in host) && host.keyRef === 'stored'))
  check('the host key is read back for its address', hosts.tensorFoldHostKey(keyed.root) === KEY)
  const mode = statSync(join(HOME, 'local-setup', 'tensorfold-hosts.json')).mode & 0o777
  check('the hosts store is private (0600)', mode === 0o600, mode.toString(8))
  stored = true
} catch (error) {
  check('the hosts store writes', false, error instanceof Error ? error.message : String(error))
}

section('§1 every TensorFold fixture reads TensorFold 1.2.2 with its window (red on the base: llama.cpp, LM Studio, vLLM misfilings)')
const { discoverLocalServers, localProbeTargets, readServed, __resetLocalDiscoveryForTest } = await import('../../src/services/providers/local/localDiscovery.js')
__resetLocalDiscoveryForTest()
const targets = localProbeTargets()
check('the remembered port is a tensorfold probe target', targets.some(t => t.kind === 'tensorfold' && t.root === remembered.root), JSON.stringify(targets))
check('the remembered host is a tensorfold probe target', targets.some(t => t.kind === 'tensorfold' && t.root === keyed.root))
const snapshot = await discoverLocalServers({ timeoutMs: 3000 })
const byRoot = new Map(snapshot.servers.map(server => [server.root, server] as const))
const expectTensorFold = (name: string, root: string, model: string, window: number, keyedServer = false): void => {
  const server = byRoot.get(root)
  check(`${name}: kind tensorfold`, server?.kind === 'tensorfold', server === undefined ? 'not discovered' : `${server.kind} · ${server.label}`)
  check(`${name}: label TensorFold 1.2.2`, server?.label === 'TensorFold 1.2.2', server?.label)
  const row = server?.models.find(m => m.id === model)
  check(`${name}: ${model} listed with its ${window} window as served`, row?.contextWindow?.tokens === window && row.contextWindow.source === 'served', JSON.stringify(row?.contextWindow))
  check(`${name}: keyed ${keyedServer}`, server?.engine?.keyed === keyedServer, JSON.stringify(server?.engine))
}
expectTensorFold('the 8080 llama.cpp target', onLlamaPort.root, 'qwen3.5-2b', 32768)
expectTensorFold('the 8000 vLLM target', onVllmPort.root, 'nemotron-lightning', 262144)
expectTensorFold('the 1234 LM Studio target', onLmStudioPort.root, 'qwen3.8-27b', 131072)
expectTensorFold('MERCURY_LOCAL_BASE_URL', overridden.root, 'qwen3.8-27b', 131072)
if (stored) {
  expectTensorFold('the remembered port', remembered.root, 'qwen3.5-2b', 32768)
  expectTensorFold('the keyed network address', keyed.root, 'qwen3.8-27b', 131072, true)
  const keyedServer = byRoot.get(keyed.root)
  check('the keyed server reads its model and window under the host key while /health shows status only', keyedServer?.models[0]?.id === 'qwen3.8-27b' && keyedServer.engine?.device === undefined)
}
const open = byRoot.get(onLlamaPort.root)
check('the open /health fills backend, device, in-use bytes and streams', open?.engine?.backend === 'metal' && open.engine.device === 'Apple M5 Pro' && open.engine.inUseBytes === 3167980568 && open.engine.streams === 8, JSON.stringify(open?.engine))
check('a thinking model without a listed vocabulary declares thinking with no efforts', open?.models[0]?.thinkingDeclared === true && open.models[0].efforts?.length === 0, JSON.stringify(open?.models[0]))
const listed = byRoot.get(onLmStudioPort.root)?.models[0]
check('a listed supported_efforts rides on the record', JSON.stringify(listed?.efforts) === JSON.stringify(['xhigh', 'medium', 'low', 'none']), JSON.stringify(listed?.efforts))

section('§2 the other engines keep their labels')
check('llama.cpp stays llama.cpp', byRoot.get(llamacpp.root)?.kind === 'llamacpp' && byRoot.get(llamacpp.root)?.label === 'llama.cpp b7000-abc', byRoot.get(llamacpp.root)?.label)
check('LM Studio stays LM Studio', byRoot.get(lmstudio.root)?.kind === 'lmstudio' && byRoot.get(lmstudio.root)?.label === 'LM Studio', byRoot.get(lmstudio.root)?.label)
check('vLLM stays vLLM with its window', byRoot.get(vllm.root)?.kind === 'vllm' && byRoot.get(vllm.root)?.models[0]?.contextWindow?.tokens === 131072, byRoot.get(vllm.root)?.label)
check('no server is listed twice', new Set(snapshot.servers.map(s => s.root)).size === snapshot.servers.length)

section('§3 readServed re-reads a TensorFold window')
const record = open?.models[0]
if (record) {
  const served = await readServed(record, { timeoutMs: 3000 })
  check('readServed answers the served window and the in-use bytes', served?.tokens === 32768 && served.bytes === 3167980568, JSON.stringify(served))
} else check('a TensorFold record to re-read', false)

section('§4 the key resolves per host, the generic key stays for the rest')
const { resolveLocalApiKeyFor, resolveLocalApiKey } = await import('../../src/services/providers/local/localAccounts.js')
check('the keyed host resolves its own key', resolveLocalApiKeyFor(keyed.root)?.key === KEY && resolveLocalApiKeyFor(keyed.root)?.source === 'host')
check('another root resolves no key', resolveLocalApiKeyFor(onLlamaPort.root) === undefined && resolveLocalApiKey() === undefined)

section('§5 a keyed host\'s turn carries its key; this Mac\'s own shared server is found through its key file (red on the fold: the lane profile sent the generic key, the probes sent none)')
{
  const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.js')
  const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.js')
  const keyedRecord = localRecordFor('local/tensorfold/qwen3.8-27b') ?? byRoot.get(keyed.root)?.models[0]
  const profile = keyedRecord === undefined ? undefined : localLaneProfileFor({ ...keyedRecord, baseUrl: `${keyed.root}/v1` })
  const credential = await profile?.resolveCredential()
  check('the lane profile resolves the keyed host\'s own key for the turn (Authorization: Bearer <key>)', credential !== undefined && credential !== null && 'apiKey' in credential && credential.apiKey === KEY, JSON.stringify(credential))
  const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
  const { writeTensorFoldKeyFile } = await import('../../src/services/providers/local/tensorfoldKeyFile.js')
  const sharedKey = writeTensorFoldKeyFile({ path: join(HOME, 'local-setup', 'tensorfold', 'api-key') })
  const shared = await serve(tensorFoldRoutes({ model: 'qwen3.5-2b', window: 32768, key: sharedKey.key }))
  mkdirSync(join(HOME, 'tensorfold'), { recursive: true })
  writeFileSync(join(HOME, 'tensorfold', 'served.json'), JSON.stringify({ repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', name: 'qwen3.5-2b', port: shared.port, window: 32768, pid: 1, startedAt: '2026-11-05T00:00:00.000Z', project: HOME, keyFile: sharedKey.path }) + '\n')
  chmodSync(join(HOME, 'tensorfold', 'served.json'), 0o600)
  check('the shared server\'s key resolves from its key file for its loopback root', resolveLocalApiKeyFor(shared.root)?.key === sharedKey.key && resolveLocalApiKeyFor(shared.root)?.source === 'shared')
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `llamacpp=${shared.root}`
  __resetLocalDiscoveryForTest()
  const own = await discoverLocalServers({ timeoutMs: 3000 })
  const sharedServer = own.servers.find(server => server.root === shared.root)
  check('this Mac\'s discovery finds its own shared server through the llama.cpp target with the key file\'s key', sharedServer?.kind === 'tensorfold' && sharedServer.models[0]?.id === 'qwen3.5-2b' && sharedServer.engine?.keyed === true, JSON.stringify(sharedServer?.label))
  shared.server.close()
}

for (const fixtureServer of [onLlamaPort, onVllmPort, onLmStudioPort, remembered, overridden, keyed, llamacpp, lmstudio, vllm]) fixtureServer.server.close()
console.log(`\nprove-tensorfold-discovery: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

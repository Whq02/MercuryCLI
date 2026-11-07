#!/usr/bin/env bun
// gate-watch: src/services/providers/local/tensorfoldUsage.ts src/services/providers/local/localDiscovery.ts src/services/tensorfold/serve.ts scripts/provider-compat/fixtures/tensorfold/*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { DOMElement, DOMNode } from '../../src/ink/dom.js'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'usage-tensorfold-rows-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|XAI_|MODEL_API_KEY|MISTRAL_|NOUS_|MERCURY_COMPAT_|MERCURY_LOCAL_|MERCURY_MODEL|MERCURY_USAGE_|MERCURY_MOCK_LIMITS|MERCURY_AUTH_SCOPE_DIR|NODE_ENV|CI)/.test(name)) delete process.env[name]
}
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }
const { pinSourceRef } = await import('../lib/settingsPopupHarness.ts')
pinSourceRef()

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string; port: number }> {
  return new Promise(resolvePort => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += String(chunk) })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(j({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePort({ server, root: `http://127.0.0.1:${port}`, port })
    })
  })
}
function json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}): true {
  res.writeHead(200, { 'content-type': 'application/json', ...headers })
  res.end(j(body))
  return true
}
const sse = (obj: unknown): string => `data: ${j(obj)}\n\n`
const FIXTURES = join(ROOT, 'scripts/provider-compat/fixtures/tensorfold')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
const FINISH = fixture('stream-finish-chunk.json')
const USAGE = fixture('stream-usage-chunk.json')
const HEALTH = fixture('health-open.json')
const WINDOW = 32768
const MODEL = 'qwen3.5-2b'
const OLLAMA_MODEL = 'qwen3.5:9b'

const tensorfold = await serve((req, _body, res) => {
  const url = req.url ?? ''
  if (req.method === 'GET' && url === '/health') return json(res, HEALTH, { server: 'TensorFold' })
  if (req.method === 'GET' && /\/models$/.test(url)) return json(res, { object: 'list', data: [{ id: MODEL, object: 'model', created: 1793822261, owned_by: 'tensorfold', context_length: WINDOW, max_model_len: WINDOW, reasoning: { default_enabled: true } }] }, { server: 'TensorFold' })
  if (req.method === 'POST' && url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream', server: 'TensorFold' })
    res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
    res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta: { reasoning_content: 'Thinking.' }, finish_reason: null }] }))
    res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta: { content: 'Hello.' }, finish_reason: null }] }))
    res.write(sse({ ...FINISH, tensorfold: { ...(FINISH.tensorfold as Record<string, unknown>), reasoning_effort: 'xhigh', enable_thinking: true } }))
    res.write(sse({ ...USAGE, usage: { prompt_tokens: 640, completion_tokens: 3, total_tokens: 643, prompt_tokens_details: { cached_tokens: 512 }, completion_tokens_details: { reasoning_tokens: 2 } } }))
    res.write('data: [DONE]\n\n')
    res.end()
    return true
  }
  return false
})
const ollama = await serve((req, _body, res) => {
  const url = req.url ?? ''
  if (url === '/api/tags') return json(res, { models: [{ name: OLLAMA_MODEL, model: OLLAMA_MODEL, size: 1024, details: { family: 'qwen3' } }] })
  if (url === '/api/version') return json(res, { version: '0.40.5' })
  if (url === '/api/ps') return json(res, { models: [] })
  if (url === '/api/show') return json(res, { parameters: '', model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144 }, capabilities: ['completion', 'tools'] })
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${tensorfold.root},ollama=${ollama.root}`
const ADDRESS = `127.0.0.1:${tensorfold.port}`

async function stub(path: string, fixtureExports: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixtureExports() }))
}
await stub('../../src/services/providers/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/services/providers/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/hooks/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
await stub('../../src/components/ConfigurableShortcutHint.js', () => ({ ConfigurableShortcutHint: () => null }))

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const usageLedger = await import('../../src/services/providers/local/tensorfoldUsage.ts')
const { sessionModelSpendRows } = await import('../../src/services/engine-connector/modelSpendFacts.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { providerFamilyPresences } = await import('../../src/services/providers/providerUsage.ts')
const { Usage, usageCompactLines, usageSectionPlan } = await import('../../src/components/Settings/Usage.js')
const { Box, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { default: squashText } = await import('../../src/ink/squash-text-nodes.js')
type UsageFacts = import('../../src/services/engine-connector/types.ts').UsageFactsV1
type Connector = import('../../src/services/engine-connector/types.ts').EngineConnectorV1
type Snapshot = import('../../src/services/providers/local/localDiscovery.ts').LocalDiscoverySnapshot
type Served = import('../../src/services/tensorfold/contracts.ts').TensorFoldServed

const SESSION_MODEL = `local/${MODEL}`
function focus(model: string): void {
  const overrides: Record<string, unknown> = {
    usage: (): UsageFacts => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false, modelSpend: sessionModelSpendRows() }),
    modelFacts: () => ({ effective: model, effectiveSource: 'live', main: model, setting: model, sessionPin: null, effort: 'high', pendingSwitch: null }),
  }
  const connector = new Proxy(noSessionConnector(), {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Connector
  setFocusedSessionConnector(connector)
}

function textRuns(node: DOMNode): string[] {
  if (node.nodeName === '#text') return []
  if (node.nodeName === 'ink-text') return [squashText(node)]
  return node.childNodes.flatMap(textRuns)
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    flushPendingSyncWork()
    await new Promise<void>(r => setTimeout(r, 10))
  }
}
async function mountPopup(width: number, rowBudget: number, openToken: number) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 178, rows: 51 }) as unknown as NodeJS.WriteStream
  const root = React.createRef<DOMElement>()
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(StdinContext.Provider, { value: context }, React.createElement(Box, { ref: root, flexDirection: 'column' }, React.createElement(Usage, { width, rowBudget, openToken } as never)))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(r => { painted = r })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    runs: () => (root.current ? textRuns(root.current).filter(run => run !== '') : []),
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}
function localRuns(runs: readonly string[]): string[] {
  const start = runs.indexOf('Local models usage')
  if (start < 0) return []
  const end = runs.findIndex((run, index) => index > start && run.startsWith('local · no metering'))
  return runs.slice(start, end < 0 ? runs.length : end + 1)
}
const SERVING_IDLE = `serving ${MODEL} on ${ADDRESS} · 32k ctx · 3.0 GiB in use · idle`
const SERVING = `serving ${MODEL} on ${ADDRESS} · 32k ctx · 3.0 GiB in use`
const LAST_TURN = `last turn · ${MODEL} · ~109 tok/s · first token in 58 ms · prefill 58 ms · 640 in (512 cached) · 3 out (2 thinking) · effort xhigh`
const THIS_SESSION = `this session · 2 turns · ~109 tok/s on average · 1,280 in (1,024 cached · 80%) · 6 out`
const ABSENT = `${MODEL} is not served · /tensorfold serves it`
const serving = usageLedger.tensorFoldServing as unknown as typeof usageLedger.tensorFoldServing | undefined
const servingLine = usageLedger.tensorFoldServingLine as unknown as typeof usageLedger.tensorFoldServingLine | undefined
const turnsOn = (address: string): never => [{ model: MODEL, address }] as never

await refreshLocalDiscovery({ force: true })
const record = localRecordFor(SESSION_MODEL)
check('the fixture is discovered as a TensorFold record with its served window, beside an Ollama server', record?.server === 'tensorfold' && record.contextWindow?.tokens === WINDOW && localRecordFor(`local/${OLLAMA_MODEL}`)?.server === 'ollama', j(record))
check('the local family is present for the panel (a server answers)', providerFamilyPresences().some(family => family.id === 'local' && family.credentialed))
if (record === undefined) {
  tensorfold.server.close()
  ollama.server.close()
  process.exit(1)
}

section('§1 RED ON THE BASE: a TensorFold session before any turn — the panel names the loaded model, where it serves, its window, its memory, and that it is idle')
focus(SESSION_MODEL)
{
  const board = await mountPopup(116, 40, 1)
  const local = localRuns(board.runs())
  const slot = local.indexOf('TensorFold')
  check('the local section carries a TensorFold slot after the Servers slot', slot > local.indexOf('Servers') && slot > 0, j(local))
  check(`its first row is the serving row: "${SERVING_IDLE}"`, local[slot + 1] === SERVING_IDLE, j(local.slice(slot)))
  check('no turn yet: the serving row is the only TensorFold row (no last-turn or session line invented)', slot > 0 && local[slot + 2]?.startsWith('local · no metering') === true, j(local.slice(slot)))
  check('the Servers slot keeps its rows: the two server rows and "This session: 0 tokens."', local.some(run => run.startsWith(`TensorFold 1.2.2 · TensorFold at ${tensorfold.root} · 1 model`)) && local.some(run => run.startsWith(`Ollama 0.40.5 · Ollama at ${ollama.root} · 1 model`)) && local.includes('This session: 0 tokens.'), j(local))
  check('the section ends with the unchanged footer, and no dollar figure anywhere in it (a local road is not priced)', local.at(-1) === 'local · no metering — keyless.' && !local.some(run => run.includes('$')), j(local))
  check('the frame paints the slot heading and the serving row as their own lines', board.frame().split('\n').some(line => line.trim() === 'TensorFold') && board.frame().split('\n').some(line => line.trim() === SERVING_IDLE), board.frame())
  board.close()
}

section('§2 two turns through the local lane: the serving row drops idle, the ledger lines sit under it, the token counts agree')
{
  const profile = localLaneProfileFor(record)
  for (let turn = 0; turn < 2; turn++) {
    for await (const _item of compatChatCallModel(profile, {
      messages: [{ type: 'user', message: { role: 'user', content: 'hi' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
      systemPrompt: ['sys'] as never,
      thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: { model: SESSION_MODEL, querySource: 'user', effortValue: 'high', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
    })) { void _item }
  }
  check('the ledger holds the two turns', usageLedger.tensorFoldTurnReadings().length === 2, String(usageLedger.tensorFoldTurnReadings().length))
  const board = await mountPopup(116, 40, 2)
  const local = localRuns(board.runs())
  const slot = local.indexOf('TensorFold')
  check(`the TensorFold slot reads, in order: the serving row without idle, the last turn, the session`, slot > 0 && local[slot + 1] === SERVING && local[slot + 2] === LAST_TURN && local[slot + 3] === THIS_SESSION, j(local.slice(slot)))
  check('the Servers slot keeps the session tally and its per-model row (the tokens the session sent and received)', local.some(run => run.startsWith('This session: 1,280 input · 6 output tokens')) && local.some(run => run.includes(`${SESSION_MODEL}: 1,280 input · 6 output tokens`)), j(local))
  check('the ledger lines are no longer under the Servers slot', local.findIndex(run => run.startsWith('last turn ·')) > slot, j(local))
  check('the footer still closes the section', local.at(-1) === 'local · no metering — keyless.', j(local))
  board.close()
}

section('§3 the facts behind the row, from the tensorfold service\'s own readers (injected): serving, draining, keyed, loading, absent, and not TensorFold at all')
if (serving === undefined || servingLine === undefined) {
  check('tensorFoldServing and tensorFoldServingLine exist in the ledger module', false, Object.keys(usageLedger).join(','))
} else {
  const snapshotWith = (engine: Record<string, unknown>, models: Array<Record<string, unknown>> = [{ id: MODEL, server: 'tensorfold', baseUrl: 'http://127.0.0.1:8080/v1', contextWindow: { tokens: 65536, source: 'served' }, loaded: true }]): Snapshot => ({ probedAtMs: 0, targetCount: 1, servers: [{ kind: 'tensorfold', root: 'http://127.0.0.1:8080', baseUrl: 'http://127.0.0.1:8080/v1', label: 'TensorFold 1.2.2', version: '1.2.2', models: models as never, engine: engine as never }] })
  const none = { snapshot: () => null, served: () => [], hosts: () => [], turns: () => [] as never }
  const live = serving(SESSION_MODEL, { ...none, snapshot: () => snapshotWith({ keyed: false, inUseBytes: 12 * 1024 ** 3, streams: 4 }) })
  check('a served model reads serving with its address, window and memory', j(live) === j({ model: MODEL, state: 'serving', address: '127.0.0.1:8080', window: 65536, inUseBytes: 12 * 1024 ** 3 }), j(live))
  check('its row, no turn yet: "serving qwen3.5-2b on 127.0.0.1:8080 · 64k ctx · 12.0 GiB in use · idle"', servingLine(live!, []) === `serving ${MODEL} on 127.0.0.1:8080 · 64k ctx · 12.0 GiB in use · idle`, servingLine(live!, []))
  check('a turn on that model at that address drops idle; a turn on another address does not', servingLine(live!, turnsOn('127.0.0.1:8080')) === `serving ${MODEL} on 127.0.0.1:8080 · 64k ctx · 12.0 GiB in use` && servingLine(live!, turnsOn('127.0.0.1:8081')).endsWith(' · idle'))
  check('the model spelled with its server prefix resolves the same', j(serving(`local/tensorfold/${MODEL}`, { ...none, snapshot: () => snapshotWith({ keyed: false }) })) === j({ model: MODEL, state: 'serving', address: '127.0.0.1:8080', window: 65536 }))
  const draining = serving(SESSION_MODEL, { ...none, snapshot: () => snapshotWith({ keyed: false, draining: true, inUseBytes: 2 * 1024 ** 3 }) })
  check('a draining server reads draining', draining?.state === 'draining' && servingLine(draining!, []).startsWith(`draining ${MODEL} on 127.0.0.1:8080`), j(draining))
  const keyed = serving(SESSION_MODEL, { ...none, snapshot: () => snapshotWith({ keyed: true }) })
  check('a keyed server (health closed) states the model and window from /v1/models and no memory figure', servingLine(keyed!, []) === `serving ${MODEL} on 127.0.0.1:8080 · 64k ctx · idle`, servingLine(keyed!, []))
  const started: Served = { repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', name: MODEL, port: 8082, window: WINDOW, pid: 1, startedAt: new Date(0).toISOString() }
  const loading = serving(SESSION_MODEL, { ...none, served: () => [started] })
  check('a model Mercury started that does not answer yet reads loading, on its port, at the window asked for', j(loading) === j({ model: MODEL, state: 'loading', address: '127.0.0.1:8082', window: WINDOW }) && servingLine(loading!, []) === `loading ${MODEL} on 127.0.0.1:8082 · 32k ctx`, j(loading))
  const gone = serving(SESSION_MODEL, { ...none, turns: () => turnsOn('127.0.0.1:8080') })
  check('a model the session ran on TensorFold whose server no longer answers reads absent, and the row offers /tensorfold', gone?.state === 'absent' && servingLine(gone!, []) === ABSENT, j(gone))
  check('a remembered host that serves the model but does not answer reads absent too', serving(SESSION_MODEL, { ...none, hosts: () => [{ name: 'studio', baseUrl: 'http://studio.local:8080', origin: 'typed', serving: MODEL }] })?.state === 'absent')
  check('a model spelled local/tensorfold/<name> with nothing answering reads absent under its own spelling', j(serving('local/tensorfold/Qwen3.5-2B', none)) === j({ model: 'Qwen3.5-2B', state: 'absent' }), j(serving('local/tensorfold/Qwen3.5-2B', none)))
  check('a model with no TensorFold trace (an Ollama session) gives no row at all', serving(`local/${OLLAMA_MODEL}`, { ...none, snapshot: () => snapshotWith({ keyed: false }), turns: () => turnsOn('127.0.0.1:8080') }) === undefined && serving('claude-opus-5-5', none) === undefined && serving('compat/pod-1/qwen3.8-27b', none) === undefined)
  check('the words carry no path, flag or dollar sign', [servingLine(live!, []), servingLine(loading!, []), ABSENT].every(line => !/--|\/\w+\/|\$/.test(line)))
}

section('§4 the compact listing (a short host): one serving line under the local heading, nothing added elsewhere')
{
  const plan = usageSectionPlan(providerFamilyPresences())
  const identity = () => 'fixture identity'
  const owner = (id: string) => ({ provider: id, sourceKind: 'none', label: `${id} usage`, shape: 'none', windows: [], pools: [], figures: [], spend: { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 } })
  const reads = { identity, usage: owner as never, anthropicWindows: () => [], anthropicPools: () => [], openaiWindows: () => [], jev: () => undefined }
  const lines = usageCompactLines(plan, reads as never)
  const localAt = lines.findIndex(line => line.text === 'Local models usage · fixture identity')
  check('the live default read adds the serving row (no idle: the session has turns) right under the local heading', localAt >= 0 && lines[localAt + 1]?.text === `  ${SERVING}` && lines[localAt + 1]?.heading === false, j(lines.slice(localAt, localAt + 3)))
  check('every other family keeps exactly its heading (no credential, no rows)', lines.filter(line => !line.heading).length === 1 && lines.filter(line => line.heading).length === plan.length, j(lines.filter(line => !line.heading)))
  const injected = usageCompactLines(plan, { ...reads, tensorFold: () => undefined } as never)
  check('an injected empty read leaves the local heading alone (the line is the read\'s, not a fixed row)', injected.every(line => line.heading), j(injected.filter(line => !line.heading)))
}

section('§5 the slot follows the session\'s model: a session on the Ollama model shows no TensorFold slot, though the ledger holds TensorFold turns')
focus(`local/${OLLAMA_MODEL}`)
{
  const board = await mountPopup(116, 40, 3)
  const local = localRuns(board.runs())
  check('no TensorFold slot and no ledger lines for an Ollama session', !local.includes('TensorFold') && !local.some(run => run.startsWith('last turn ·') || run.startsWith('this session ·') || run.startsWith('serving ')), j(local))
  check('the Servers slot still lists both servers', local.some(run => run.startsWith('TensorFold 1.2.2 · TensorFold at')) && local.some(run => run.startsWith('Ollama 0.40.5 · Ollama at')), j(local))
  board.close()
}

section('§6 the TensorFold server stops while Ollama keeps answering: the row says the model is not served and where to serve it, the ledger stays')
focus(SESSION_MODEL)
await new Promise<void>(r => tensorfold.server.close(() => r()))
await refreshLocalDiscovery({ force: true })
{
  check('discovery now lists Ollama alone', localRecordFor(SESSION_MODEL) === undefined && localRecordFor(`local/${OLLAMA_MODEL}`)?.server === 'ollama')
  const board = await mountPopup(116, 40, 4)
  const local = localRuns(board.runs())
  const slot = local.indexOf('TensorFold')
  check(`the TensorFold slot reads "${ABSENT}", then the session's ledger lines`, slot > 0 && local[slot + 1] === ABSENT && local[slot + 2] === LAST_TURN && local[slot + 3] === THIS_SESSION, j(local.slice(slot)))
  check('the Servers slot lists Ollama alone', local.some(run => run.startsWith('Ollama 0.40.5 · Ollama at')) && !local.some(run => run.startsWith('TensorFold 1.2.2 · TensorFold at')), j(local))
  board.close()
}

releaseFocusedSessionConnector()
ollama.server.close()
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-usage-tensorfold-rows: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

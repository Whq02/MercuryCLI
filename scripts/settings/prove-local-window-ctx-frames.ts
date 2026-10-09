#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

const ROOT = join(import.meta.dir, '../..')
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const framesDir = argument('--frames')
if (framesDir) mkdirSync(framesDir, { recursive: true })

delete process.env.NODE_ENV
const SCRATCH_ROOT = process.env.MERCURY_CONFIG_DIR?.trim() || tmpdir()
mkdirSync(SCRATCH_ROOT, { recursive: true })
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'local-window-ctx-'))
for (const name of Object.keys(process.env)) {
  if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
Object.assign(process.env, { HOME, MERCURY_CONFIG_DIR: HOME, MERCURY_AUTH_SCOPE_DIR: HOME, MERCURY_HOME: HOME, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_EVOLUTION_LEDGER: '0', MERCURY_HELM_CONSOLE: '0', MERCURY_LIVE_GLYPHS: '0', MERCURY_CTX_FORECAST: '0', BROWSER: '/usr/bin/true', TZ: 'UTC', LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const GIB = 1024 ** 3
const MODEL_27 = 'qwen3.8:27b-mtp-q4_K_M'
const MODEL_9 = 'qwen3.5:9b'
const kvHeads = (blocks: number): number[] => Array.from({ length: blocks }, (_, i) => ((i + 1) % 4 === 0 ? 4 : 0))
const INFO: Record<string, Record<string, unknown>> = {
  [MODEL_27]: { 'general.architecture': 'qwen35', 'qwen35.attention.head_count': 24, 'qwen35.attention.head_count_kv': 4, 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 65, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 5120, 'qwen35.full_attention_interval': 4, 'qwen35.nextn_predict_layers': 1 },
  [MODEL_9]: { 'general.architecture': 'qwen35', 'qwen35.attention.head_count': 16, 'qwen35.attention.head_count_kv': kvHeads(32), 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 32, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 4096, 'qwen35.full_attention_interval': 4 },
}
const SIZES: Record<string, number> = { [MODEL_27]: 17741872154, [MODEL_9]: 6594474711 }
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/tags') return Response.json({ models: [MODEL_27, MODEL_9].map(name => ({ name, model: name, size: SIZES[name], details: { family: 'qwen35', parameter_size: 'x', quantization_level: 'Q4_K_M', context_length: 262144 } })) })
    if (request.method === 'GET' && path === '/api/version') return Response.json({ version: '0.34.4' })
    if (request.method === 'GET' && path === '/api/ps') return Response.json({ models: [MODEL_27, MODEL_9].map(name => ({ name, model: name, context_length: 262144 })) })
    if (request.method === 'POST' && path === '/api/show') {
      const model = String(((await request.json()) as { model?: string }).model ?? '')
      return Response.json({ capabilities: ['completion', 'tools', 'thinking'], parameters: '', model_info: INFO[model] ?? {} })
    }
    return new Response(null, { status: 404 })
  },
})
const FIXTURE_ORIGIN = `http://127.0.0.1:${server.port}`
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${FIXTURE_ORIGIN}`

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
async function stub(relative: string, overrides: Record<string, unknown>): Promise<void> {
  const target = join(ROOT, relative)
  const actual = await import(target)
  mock.module(target, () => ({ ...actual, ...overrides }))
}
await stub('src/utils/proxy.ts', { getApiFetch: () => globalThis.fetch, getProxyFetchOptions: () => ({}) })
const config = await import(join(ROOT, 'src/utils/config.ts'))
config.enableConfigs()

let focusedModel = `local/${MODEL_27}`
const connector = { modelFacts: () => ({ main: focusedModel, effective: focusedModel }), subscribeModel: () => () => {}, records: () => [], subscribeRecords: () => () => {}, usage: () => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }) }
await stub('src/keybindings/useKeybinding.ts', { useKeybinding: () => undefined, useKeybindings: () => undefined })
await stub('src/hooks/useExitOnCtrlCD.ts', { useExitOnCtrlCD: () => undefined })
await stub('src/context/notifications.tsx', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
await stub('src/utils/cockpit/healthCertSnapshot.ts', { healthCertSnapshot: () => ({ state: 'unavailable' }) })
await stub('src/services/engine-connector/focusedConnector.ts', {
  getFocusedSessionConnector: () => connector,
  subscribeThroughFocused: (subscribe: (connection: typeof connector, listener: () => void) => () => void) => (listener: () => void) => subscribe(connector, listener),
  hasFocusedSession: () => false,
  landingInFlight: () => false,
  subscribeFocusedSessionConnector: () => () => {},
})
await stub('src/components/tasks/useFocusedWork.ts', { useFocusedWorkRows: () => [], useFocusedWorkRoster: () => ({ rows: [], mission: [], reported: true }), otherSessionRunnerPids: () => new Set(), focusedSessionIdOrNull: () => null })
const vitals = { sessions: { state: 'unavailable' }, git: null, tasks: [], fleet: { state: 'off', conflicts: 0, drifting: 0 }, fleetFull: null, trace: null, workflowsDisk: [], crew: null, refreshedAt: 0, version: 1 }
await stub('src/state/vitalsBus.ts', { useVitals: (selector?: (s: typeof vitals) => unknown) => (selector ? selector(vitals) : vitals) })
await stub('src/hooks/useDisplayedSessionModel.ts', { useFocusedServedModel: () => focusedModel, useDisplayedSessionModel: () => ({ label: focusedModel, compact: focusedModel.slice('local/'.length), pendingNext: null }), useFocusedServedEffort: () => null, useFocusedBornEffort: () => null, useFocusedSentEffort: () => null })
await stub('src/hooks/useEngineModel.ts', { useEngineModel: () => focusedModel })
await stub('src/hooks/useProviderUsageOnShow.ts', { useProviderUsageOnShow: () => undefined })

const ink = await import(join(ROOT, 'src/ink.ts'))
const { default: StdinContext } = await import(join(ROOT, 'src/ink/components/StdinContext.ts'))
const { HelmVitalsRail } = await import(join(ROOT, 'src/components/HelmVitalsRail.tsx'))
const { DeckPane } = await import(join(ROOT, 'src/components/DeckPane.tsx'))
const { railPlanAt } = await import(join(ROOT, 'src/utils/helmGeometry.ts'))
const { publishContextUsage } = await import(join(ROOT, 'src/utils/cockpit/contextUsageLive.ts'))
const { refreshLocalDiscovery } = await import(join(ROOT, 'src/services/providers/local/localDiscovery.ts'))
const { localRecordFor } = await import(join(ROOT, 'src/services/providers/local/localCatalogue.ts'))
const w = await import(join(ROOT, 'src/services/providers/local/localWindow.ts'))
const { __pinLocalServerTruthForTest } = await import(join(ROOT, 'src/services/localServer/localServerTruth.ts'))
type Truth = import('../../src/services/localServer/localServerTruth.ts').LocalServerTruth

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    ink.flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const MODE_SEQUENCES = /\x1b\[[?>=<][0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[<u|\x1b\[>4m/g
function plain(raw: string): string {
  return stripAnsi(raw.replace(MODE_SEQUENCES, '')).replace(/\n$/, '').split('\n').map(line => line.trimEnd()).join('\n').replace(/^\n+/, '')
}
async function paint(content: React.ReactNode, columns: number, rows: number): Promise<string> {
  const emitter = new ink.EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows, isTTY: true }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(StdinContext.Provider, { value: context }, React.createElement(ink.Box, { width: columns, height: rows, flexDirection: 'column' }, content))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  await new Promise<void>(resolve => setTimeout(resolve, 120))
  await settle()
  const frame = plain(instance.lastFrame())
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frame
}
function save(name: string, frame: string): void {
  if (framesDir) writeFileSync(join(framesDir, `${name}.txt`), frame + '\n')
}
const inBounds = (frame: string, columns: number, rows: number): boolean => frame.split('\n').length <= rows && frame.split('\n').every(line => stringWidth(line) <= columns)
const ctxRow = (frame: string): string => frame.split('\n').map(line => line.replace(/│/g, ' ').trim()).find(line => /^ctx\b/.test(line)) ?? ''

async function paintRail(): Promise<string> {
  const plan = railPlanAt(178, true)
  return paint(React.createElement(ink.Box, { flexDirection: 'row', justifyContent: 'flex-end', width: 178 }, React.createElement(HelmVitalsRail, { width: plan.vitalsW, availRows: 51 - 7 })), 178, 51)
}
async function paintDeck(columns: number, rows: number): Promise<string> {
  return paint(React.createElement(DeckPane), columns, rows)
}

function truthOf(totalGib: number, usableGib: number | undefined, cacheType?: string): Truth {
  const total = totalGib * GIB
  const machine = usableGib !== undefined ? { platform: 'darwin' as const, totalMemoryBytes: total, usableMemoryBytes: Math.round(usableGib * GIB), usableSource: "the server's own gpu memory line in /fixture/ollama.log (Metal)" } : { platform: 'darwin' as const, totalMemoryBytes: total, usableMemoryBytes: Math.round(total * 0.75), usableSource: 'about three quarters of unified memory, the Metal default working set (no server log read)' }
  return { server: { kind: 'ollama', root: FIXTURE_ORIGIN, label: 'Ollama 0.34.4' }, loaded: [], listed: [], runners: cacheType ? [{ command: `llama-server -np 1 --cache-type-k ${cacheType}`, slots: 1, cacheTypeK: cacheType }] : [], launchForm: { kind: 'unknown', note: 'fixture' }, machine, readAtMs: Date.now() }
}

await refreshLocalDiscovery({ force: true })
const qwen27 = localRecordFor(`local/${MODEL_27}`)!
const qwen9 = localRecordFor(`local/${MODEL_9}`)!
check('the fixture records carry geometry and the served window (262144)', qwen27.geometry !== undefined && qwen27.contextWindow?.tokens === 262144 && qwen9.geometry !== undefined)

const publish = (usedTokens: number, window: number): void => publishContextUsage(Math.round((usedTokens / window) * 100), window, 80, undefined, { usedTokens, fillSource: 'usage', windowSource: 'live-current', windowPinned: false })

console.log("\n── the owner's box: the hybrid 27B (one head_count_kv for 65 blocks, interval 4) under auto — the rail says max, the deck says the rule")
{
  __pinLocalServerTruthForTest(truthOf(48, 36.9, 'q8_0'))
  w.__resetLocalWindowsForTest()
  focusedModel = `local/${MODEL_27}`
  const held = w.decideLocalWindow(qwen27, 73_000, undefined)
  check('auto on the hybrid 27B is the trained max: 16 of 65 layers keep a cache, 8.5 GiB at 256k, never a 51.1 GiB sum', held.window === 262144 && held.reason === 'max' && qwen27.geometry?.attentionLayers === 16, `${held.window} · ${held.reason} · ${held.words}`)
  publish(120_000, 262144)
  const rail = await paintRail()
  save('rail-ctx-max-178x51', rail)
  check('178x51 rail: the ctx row reads ctx 46% · 262k max (the window label is the rail\'s own /1000 spelling; the reason is the fit owner\'s)', ctxRow(rail) === 'ctx 46% · 262k max' && inBounds(rail, 178, 51), ctxRow(rail))
  const deck = await paintDeck(178, 51)
  save('deck-ctx-rule-178x51', deck)
  check("178x51 deck: the ctx row carries the full rule in step 5's words with the hybrid sum", ctxRow(deck).includes('120k/262k · 256k · 16.5 GiB weights + 8.5 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot') && inBounds(deck, 178, 51), ctxRow(deck))
  const narrow = await paintDeck(80, 21)
  save('deck-ctx-80x21', narrow)
  check('80x21 deck: the compact strip folds ctx into its first row and stays in bounds (the rule rides the wide row only)', inBounds(narrow, 80, 21) && ctxRow(narrow) === '', ctxRow(narrow))
}

console.log('\n── a 16 GiB box: the 9B under auto — the rail says fit; a setting says set; the server default says srv')
{
  __pinLocalServerTruthForTest(truthOf(16, undefined))
  w.__resetLocalWindowsForTest()
  focusedModel = `local/${MODEL_9}`
  const fit = w.decideLocalWindow(qwen9, 62_000, undefined)
  publish(60_000, fit.window!)
  const rail = await paintRail()
  save('rail-ctx-fit-178x51', rail)
  check('178x51 rail: 128k chosen by the memory fit reads ctx 46% · 131k fit', fit.window === 131072 && ctxRow(rail) === 'ctx 46% · 131k fit', ctxRow(rail))
  const deck = await paintDeck(178, 51)
  save('deck-ctx-fit-178x51', deck)
  check('178x51 deck: the rule names the rung, the load, the ceiling and the rung that did not fit', ctxRow(deck).includes('60k/131k · 128k · 6.1 GiB weights + 4.0 GiB cache of 12.0 GiB usable (16.0 GiB box) · f16 · 1 slot · 256k does not fit (14.1 GiB)'), ctxRow(deck))
  w.__resetLocalWindowsForTest()
  w.decideLocalWindow(qwen9, 62_000, 65536)
  publish(30_000, 65536)
  const set = await paintRail()
  save('rail-ctx-set-178x51', set)
  check("178x51 rail: the operator's 64k setting reads ctx 46% · 66k set", ctxRow(set) === 'ctx 46% · 66k set', ctxRow(set))
  w.__resetLocalWindowsForTest()
  publish(120_000, 262144)
  const srv = await paintRail()
  save('rail-ctx-srv-178x51', srv)
  check("178x51 rail: with nothing held the served figure is the server's own — ctx 46% · 262k srv", ctxRow(srv) === 'ctx 46% · 262k srv', ctxRow(srv))
  const deckSrv = await paintDeck(178, 51)
  check('178x51 deck: with nothing held there is no rule sentence (nothing invented)', ctxRow(deckSrv).endsWith('120k/262k'), ctxRow(deckSrv))
  focusedModel = 'claude-fable-5-1'
  publish(120_000, 262144)
  const other = await paintRail()
  check('a non-local model carries no tag', ctxRow(other) === 'ctx 46% · 262k', ctxRow(other))
}

server.stop(true)
console.log(failures === 0 ? '\nlocal window ctx frames: all green' : `\nlocal window ctx frames: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

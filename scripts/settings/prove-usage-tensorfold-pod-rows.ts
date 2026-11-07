#!/usr/bin/env bun
// gate-watch: src/services/providers/local/tensorfoldUsage.ts src/components/Settings/Usage.tsx src/services/host/tensorfoldPod.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'usage-tensorfold-pod-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|XAI_|MODEL_API_KEY|MISTRAL_|NOUS_|MERCURY_COMPAT_|MERCURY_LOCAL_|MERCURY_MODEL|MERCURY_USAGE_|MERCURY_MOCK_LIMITS|MERCURY_TENSORFOLD_)/.test(name)) delete process.env[name]
}
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const { pinSourceRef } = await import('../lib/settingsPopupHarness.ts')
pinSourceRef()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 600) : ''}`)
  if (!cond) failures++
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const SERVED = 'qwen3.8-27b'
const RUNTIME = { enable_thinking: true, reasoning_effort: 'high', engine: 'lanes', tokens_per_second: 357.25, seconds: 1.4, prefill_seconds: 0.21, time_to_first_token: 0.23 }
const engine = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
  const path = new URL(request.url).pathname
  const headers = { server: 'TensorFold' }
  if (path === '/health') return Response.json({ status: 'ok', version: '1.2.2', model: SERVED }, { headers })
  if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: SERVED, object: 'model', created: 1, owned_by: 'tensorfold', context_length: 262144, max_model_len: 262144 }] }, { headers })
  if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('not found', { status: 404 })
  await request.json()
  const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}): string => sse({ id: 'tf', object: 'chat.completion.chunk', created: 1, model: SERVED, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
  const frames = [chunk({ role: 'assistant' }), chunk({ content: 'TF-DONE' }), chunk({}, 'stop', { tensorfold: RUNTIME }), sse({ id: 'tf', object: 'chat.completion.chunk', created: 1, model: SERVED, choices: [], usage: { prompt_tokens: 640, completion_tokens: 24, prompt_tokens_details: { cached_tokens: 512 }, completion_tokens_details: { reasoning_tokens: 8 } } }), 'data: [DONE]\n\n']
  return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream', ...headers } })
} })
const root = `http://127.0.0.1:${engine.port}`
const POD = `compat/pod-tfpod/${SERVED}`
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({
  compatProvider: { 'pod-tfpod': { baseUrl: `${root}/v1`, hostPodId: 'tfpod', dialect: 'chat-completions', models: [SERVED] } },
  models: { [POD]: { contextWindow: 262144, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
}))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'ollama=http://127.0.0.1:1'

async function stub(path: string, fixtureExports: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixtureExports() }))
}
await stub(`${ROOT}/src/services/providers/openai/openaiCatalogue.js`, () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub(`${ROOT}/src/services/providers/catalogueOnDemand.js`, () => ({ readCatalogueIfPending: async () => undefined }))
await stub(`${ROOT}/src/hooks/useCatalogueEpoch.js`, () => ({ useCatalogueEpoch: () => 0 }))
await stub(`${ROOT}/src/keybindings/useKeybinding.js`, () => ({ useKeybinding: () => undefined }))
await stub(`${ROOT}/src/components/ConfigurableShortcutHint.js`, () => ({ ConfigurableShortcutHint: () => null }))

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { registerTensorFoldPod } = await import('../../src/services/host/tensorfoldPod.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { writeHostRecord } = await import('../../src/services/host/store.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localServerKind } = await import('../../src/constants/localPromptProfile.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const ledger = await import('../../src/services/providers/local/tensorfoldUsage.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { Usage } = await import('../../src/components/Settings/Usage.js')
const { Box, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { default: squashText } = await import('../../src/ink/squash-text-nodes.js')

const recipe = HOST_RECIPES.find(row => row.id === 'tensorfold-qwen38-27b-rtx-5090')!
const target = { host: '127.0.0.1', port: 22, user: 'root', key: join(HOME, 'id_ed25519') }
writeHostRecord({ vendor: 'runpod', id: 'tfpod', name: 'tf-proof-tfpod', recipe: recipe.id, recipeRow: recipe, price: 1.19, startedAt: new Date().toISOString(), status: 'RUNNING', jobKind: 'setup', jobState: 'ready', step: 'ready', provider: 'tensorfold', target } as never)
await registerTensorFoldPod({ id: 'tfpod', vendor: 'runpod', recipe, baseUrl: `${root}/v1`, key: 'proof-pod-key-not-real', served: SERVED, window: 262144, target } as never)
await refreshLocalDiscovery({ force: true })

console.log('[1] one real turn on the rented TensorFold pod, reached through its remembered host only')
{
  const permissionContext = getEmptyToolPermissionContext()
  const errors: string[] = []
  for await (const item of routedCallModel({
    messages: [createUserMessage({ content: 'Say hello.' })] as never,
    systemPrompt: ['You are a fixture assistant.'] as never,
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
    tools: [],
    signal: AbortSignal.timeout(60_000),
    options: { getToolPermissionContext: async () => permissionContext, model: POD, isNonInteractiveSession: true, querySource: 'main_thread', agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false, ownerKey: 'proof' } as never,
  })) {
    const row = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
    if (row.type === 'assistant' && row.isApiErrorMessage === true) errors.push(JSON.stringify(row.message?.content).slice(0, 300))
  }
  check('the pod turn settled without an API error', errors.length === 0, errors.join(' | '))
  check('the TensorFold ledger took the turn and the session is a TensorFold pod session', ledger.tensorFoldTurnReadings().length === 1 && localServerKind(POD) === 'tensorfold', `${ledger.tensorFoldTurnReadings().length} readings · kind ${localServerKind(POD)}`)
}

console.log('[2] the /usage panel keeps the pod session\'s TensorFold lines (shipped in 1.0.7: the last turn under Servers)')
{
  const overrides: Record<string, unknown> = {
    usage: () => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false, modelUsage: {} }),
    modelFacts: () => ({ effective: POD, effectiveSource: 'live', main: POD, setting: POD, sessionPin: null, effort: 'high', pendingSwitch: null }),
  }
  setFocusedSessionConnector(new Proxy(noSessionConnector(), {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as never)
  type Node = { nodeName: string; childNodes: Node[] }
  const textRuns = (node: Node): string[] => node.nodeName === '#text' ? [] : node.nodeName === 'ink-text' ? [squashText(node as never)] : node.childNodes.flatMap(textRuns)
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 178, rows: 400 }) as unknown as NodeJS.WriteStream
  const rootRef = React.createRef<Node>()
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(StdinContext.Provider, { value: context } as never, React.createElement(Box, { ref: rootRef, flexDirection: 'column' } as never, React.createElement(Usage, { width: 116, rowBudget: 400, openToken: 1 } as never)))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(r => { painted = r })
  const instance = await render(tree as never, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() } as never)
  await firstFrame
  for (let index = 0; index < 8; index++) {
    flushPendingSyncWork()
    await new Promise<void>(r => setTimeout(r, 10))
  }
  const runs = rootRef.current ? textRuns(rootRef.current).filter(run => run !== '') : []
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  releaseFocusedSessionConnector()
  const start = runs.indexOf('Local models usage')
  const local = start < 0 ? [] : runs.slice(start)
  check('the Local models usage block renders for the pod session', start >= 0, runs.join(' | ').slice(0, 600))
  check("the pod's last turn is under Servers: model, speed, first token, prefill, tokens, effort", local.some(run => run.startsWith('last turn · qwen3.8-27b') && run.includes('tok/s') && run.includes('640 in (512 cached)') && run.includes('24 out (8 thinking)') && run.includes('effort high')), local.join(' | ').slice(0, 900))
  check('the pod session carries no local-engine serving row (the pod is reached by its address, not discovered as a local engine)', !local.some(run => /^(serving|loading|draining) /.test(run)), local.join(' | ').slice(0, 600))
}

engine.stop(true)
rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)

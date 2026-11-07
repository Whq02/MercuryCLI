#!/usr/bin/env bun
// gate-watch: src/services/providers/local/tensorfoldUsage.ts src/components/Settings/Usage.tsx src/services/providers/local/localCatalogue.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'usage-tensorfold-other-'))
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

const MODEL = 'qwen3.5-2b'
const HEALTH = { status: 'ok', model: MODEL, version: '1.2.2', memory: { active: 3167980568 } }
const tf = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request: Request) {
  const path = new URL(request.url).pathname
  const headers = { server: 'TensorFold' }
  if (path === '/health') return Response.json(HEALTH, { headers })
  if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model', created: 1, owned_by: 'tensorfold', context_length: 32768 }] }, { headers })
  return new Response('not found', { status: 404 })
} })
const llama = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request: Request) {
  const path = new URL(request.url).pathname
  if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'llamacpp', meta: { n_ctx_train: 32768 } }] })
  if (path === '/props') return Response.json({ default_generation_settings: { n_ctx: 8192 }, build_info: 'b9999' })
  return new Response('not found', { status: 404 })
} })
process.env.MERCURY_LOCAL_PROBE_TARGETS = `llamacpp=http://127.0.0.1:${llama.port},tensorfold=http://127.0.0.1:${tf.port}`

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
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { tensorFoldServing } = await import('../../src/services/providers/local/tensorfoldUsage.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { Usage } = await import('../../src/components/Settings/Usage.js')
const { Box, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { default: squashText } = await import('../../src/ink/squash-text-nodes.js')
await refreshLocalDiscovery({ force: true })

async function panel(model: string): Promise<string[]> {
  const overrides: Record<string, unknown> = {
    usage: () => ({ totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false, modelUsage: {} }),
    modelFacts: () => ({ effective: model, effectiveSource: 'live', main: model, setting: model, sessionPin: null, effort: 'high', pendingSwitch: null }),
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
  const stop = runs.findIndex((run, index) => index > start && run.startsWith('local · no metering'))
  return start < 0 ? [] : runs.slice(start, stop + 1)
}

console.log('[1] two local servers list the same id; the slot follows the server the session actually uses')
for (const model of [`local/llamacpp/${MODEL}`, `local/${MODEL}`]) {
  const record = localRecordFor(model)
  const local = await panel(model)
  check(`${model}: the session's lane resolves to llama.cpp, so tensorFoldServing stays silent`, record?.server === 'llamacpp' && tensorFoldServing(model) === undefined, `record ${record?.server} · serving ${JSON.stringify(tensorFoldServing(model))}`)
  check(`${model}: the Local block renders without a TensorFold slot or serving row`, local.length > 0 && !local.includes('TensorFold') && !local.some(run => /^(serving|loading|draining) /.test(run) || run.includes('is not served')), local.join(' | ').slice(0, 600))
}
{
  const model = `local/tensorfold/${MODEL}`
  const local = await panel(model)
  check(`${model}: the TensorFold session keeps its slot and serving row`, localRecordFor(model)?.server === 'tensorfold' && local.includes('TensorFold') && local.some(run => run.startsWith(`serving ${MODEL} on 127.0.0.1:${tf.port}`)), local.join(' | ').slice(0, 600))
}

tf.stop(true)
llama.stop(true)
rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)

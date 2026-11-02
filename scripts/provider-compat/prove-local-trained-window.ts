#!/usr/bin/env bun
// gate-watch: src/services/localServer/localWindowFit.ts src/utils/contextFill.ts src/utils/cockpit/modelGauge.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTally } from '../daemon/dupline-world.ts'

const home = mkdtempSync(join(tmpdir(), 'local-trained-window-'))
process.env.MERCURY_CONFIG_DIR = home
const id = 'window-proof:9b'
let served = 32768
const calls: Record<string, unknown>[] = []
const info = { 'general.architecture': 'qwen35', 'qwen35.context_length': 40960, 'qwen35.block_count': 32, 'qwen35.attention.head_count_kv': 4, 'qwen35.attention.key_length': 128, 'qwen35.attention.value_length': 128 }
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request: Request) {
    const path = new URL(request.url).pathname
    if (path === '/api/tags') return Response.json({ models: [{ name: id, size: 6_000_000_000 }] })
    if (path === '/api/version') return Response.json({ version: 'fixture' })
    if (path === '/api/show') return Response.json({ model_info: info, capabilities: ['completion', 'tools', 'thinking'] })
    if (path === '/api/ps') return Response.json({ models: [{ name: id, context_length: served }] })
    if (path === '/api/chat') {
      const body = await request.json() as Record<string, unknown>
      calls.push(body)
      served = (body.options as { num_ctx: number }).num_ctx
      return new Response(JSON.stringify({ model: id, message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 1 }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
    }
    return new Response(null, { status: 404 })
  },
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${server.port}`
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { __pinLocalServerTruthForTest } = await import('../../src/services/localServer/localServerTruth.ts')
const { kvGeometryOf, kvCacheBytes } = await import('../../src/services/localServer/localServerMemory.ts')
const { localWindowRungs } = await import('../../src/services/localServer/localWindowFit.ts')
const { chooseWindowFrom } = await import('../../src/services/localSetup/setupWindow.ts')
const { proveKnobsOf } = await import('../../src/services/localSetup/setupProve.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const { contextFillView } = await import('../../src/utils/contextFill.ts')
const { writeLocalWindowSetting } = await import('../../src/services/providers/local/localWindow.ts')
const { modelGauge } = await import('../../src/utils/cockpit/modelGauge.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const tally = makeTally('prove-local-trained-window')
const geometry = kvGeometryOf(info)!
const truth = { loaded: [], listed: [], runners: [], launchForm: { kind: 'unknown' as const, note: 'fixture' }, machine: { platform: 'darwin' as const, totalMemoryBytes: 64 * 1024 ** 3, usableMemoryBytes: 48 * 1024 ** 3, usableSource: 'fixture' }, readAtMs: Date.now() }
__pinLocalServerTruthForTest(truth)
try {
  const fit = { tag: id, weightsBytes: 6_000_000_000, geometry, trainedMax: 40960, machineBytes: truth.machine.totalMemoryBytes, usableBytes: truth.machine.usableMemoryBytes, slots: 1 }
  tally.check('the fitting ladder includes the exact trained maximum, without rounding it down', JSON.stringify(localWindowRungs(40960)) === JSON.stringify([32768, 40960]))
  tally.check('trained maxima beyond the default ladder remain available', localWindowRungs(524288).at(-1) === 524288)
  tally.check('/localsetup chooses the trained window when it fits', chooseWindowFrom(fit).window === 40960)
  tally.check('a smaller machine chooses the largest fitting window, never an over-memory maximum', chooseWindowFrom({ ...fit, usableBytes: fit.weightsBytes + kvCacheBytes(geometry, 32768, 1) }).window === 32768)
  await refreshLocalDiscovery({ force: true })
  const model = `local/${id}`, record = localRecordFor(model)!
  tally.check('setup requests the same trained window', proveKnobsOf(record).numCtx === 40960)
  writeLocalWindowSetting(record, 40960)
  const answer = createAssistantMessage({ content: 'ok' }); answer.message.model = model
  answer.message.usage = { input_tokens: 16384, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never
  const gauge = contextFillView([answer], model)
  tally.check('ctx uses the loaded 32k window, not the planned trained window', gauge.window === 32768 && gauge.usedPct === 50, JSON.stringify(gauge))
  tally.check('the model gauge agrees with the loaded window', modelGauge(model).data.window === 32768)
  tally.check('preflight still budgets the window the request will ask for', resolveContextWindow(model).effectiveWindow === 40960)
  const yielded = []
  for await (const row of localCallModel({ messages: [createUserMessage({ content: 'answer briefly' })], systemPrompt: [] as never, tools: [], thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never, signal: new AbortController().signal, options: { model, querySource: 'user', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never })) yielded.push(row)
  tally.check('session start sends trained num_ctx and keeps thinking and output intact', calls.length === 1 && (calls[0]?.options as { num_ctx?: number; num_predict?: number }).num_ctx === 40960 && (calls[0]?.options as { num_predict?: number }).num_predict === 32000 && calls[0]?.think === true)
  tally.check('the confirmed loaded window drives ctx after the reply', served === 40960 && contextFillView([answer], model).window === served && modelGauge(model).data.window === served)
} finally {
  server.stop(true)
  __pinLocalServerTruthForTest(null)
  rmSync(home, { recursive: true, force: true })
}
tally.finish()

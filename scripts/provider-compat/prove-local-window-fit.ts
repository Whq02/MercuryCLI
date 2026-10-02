#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-window-fit.'))
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
function finish(): never {
  ollama.server.close()
  rmSync(HOME, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const GIB = 1024 ** 3
const MODEL_27 = 'qwen3.5:27b'
const MODEL_9 = 'qwen3.5:9b'
const HYBRID_27 = 'qwen3.8:27b-mtp-q4_K_M'
const WEIGHTS_27 = 17420432728
const WEIGHTS_9 = 6594474711
const WEIGHTS_H27 = 17741872154
const RESIDENT_H27_128K = 19_100_000_000
type Show = { capabilities: string[]; details: Record<string, unknown>; parameters: string; model_info: Record<string, unknown> }
const fixture = (name: string): Show => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')) as Show
const SHOW_H27 = fixture('ollama-show-qwen3.8-27b-mtp-q4_K_M.json')
const SHOW_9 = fixture('ollama-show-qwen3.5-9b.json')
const kvHeads = (blocks: number): number[] => Array.from({ length: blocks }, (_, i) => ((i + 1) % 4 === 0 ? 4 : 0))
const INFO_27 = { 'general.architecture': 'qwen35', 'general.parameter_count': 27781427952, 'qwen35.attention.head_count': 24, 'qwen35.attention.head_count_kv': kvHeads(64), 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 64, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 5120, 'qwen35.full_attention_interval': 4 }
const INFO_9 = SHOW_9.model_info
const details = (size: string, embedding: number) => ({ parent_model: '', format: 'gguf', family: 'qwen35', families: ['qwen35'], parameter_size: size, quantization_level: 'Q4_K_M', context_length: 262144, embedding_length: embedding })
const CAPS = ['completion', 'vision', 'tools', 'thinking']
const psModels: Array<Record<string, unknown>> = []

type Hit = { method: string; url: string; body: Record<string, unknown> }
const hits: Hit[] = []
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}
const ollama = await new Promise<{ server: Server; root: string }>(resolve => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const url = req.url ?? ''
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      hits.push({ method: req.method ?? 'GET', url, body })
      if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
      if (url === '/api/tags') return json(res, 200, { models: [{ name: MODEL_9, model: MODEL_9, size: WEIGHTS_9, digest: '6488', details: details('9.7B', 4096), capabilities: CAPS }, { name: MODEL_27, model: MODEL_27, size: WEIGHTS_27, digest: '7653', details: details('27.8B', 5120), capabilities: CAPS }, { name: HYBRID_27, model: HYBRID_27, size: WEIGHTS_H27, digest: '2213', details: { ...SHOW_H27.details, context_length: 262144, embedding_length: 5120 }, capabilities: SHOW_H27.capabilities }] })
      if (url === '/api/ps') return json(res, 200, { models: psModels })
      if (url === '/api/show') {
        const model = String(body.model ?? '')
        if (model === MODEL_27) return json(res, 200, { capabilities: CAPS, details: details('27.8B', 5120), parameters: 'top_k 20', model_info: INFO_27 })
        if (model === MODEL_9) return json(res, 200, { capabilities: SHOW_9.capabilities, details: SHOW_9.details, parameters: SHOW_9.parameters, model_info: INFO_9 })
        if (model === HYBRID_27) return json(res, 200, { capabilities: SHOW_H27.capabilities, details: SHOW_H27.details, parameters: SHOW_H27.parameters, model_info: SHOW_H27.model_info })
        return json(res, 404, { error: `model '${model}' not found` })
      }
      if (url === '/api/chat' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'pong' }, done: false }) + '\n')
        res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 73000, eval_count: 1 }) + '\n')
        res.end()
        return true
      }
      if (url === '/api/generate' || url === '/v1/chat/completions' || url === '/api/create' || url === '/api/delete') return json(res, 500, { error: `the proof must never call ${url}` })
      return json(res, 404, { error: 'not found' })
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    resolve({ server, root: `http://127.0.0.1:${port}` })
  })
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const w = await import('../../src/services/providers/local/localWindow.ts')
const truthModule = await import('../../src/services/localServer/localServerTruth.ts')
const { __pinLocalServerTruthForTest, __resetLocalServerTruthForTest } = truthModule
const defaultMachineTruth: (platform: NodeJS.Platform, totalMemoryBytes: number) => { platform: NodeJS.Platform; totalMemoryBytes: number; usableMemoryBytes: number; usableSource: string } =
  (truthModule as { defaultMachineTruth?: typeof defaultMachineTruth }).defaultMachineTruth ?? (() => ({ platform: 'darwin', totalMemoryBytes: 0, usableMemoryBytes: 0, usableSource: 'absent on the base' }))
const memory = await import('../../src/services/localServer/localServerMemory.ts')
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
type Truth = import('../../src/services/localServer/localServerTruth.ts').LocalServerTruth
const METAL_FRACTION_WORDS = 'about three quarters of unified memory, the Metal default working set (no server log read)'

function truthOf(opts: { totalGib: number; usableGib?: number; source?: string; cacheType?: string; slots?: number; env?: Record<string, string> }): Truth {
  const total = opts.totalGib * GIB
  const fraction = { platform: 'darwin' as const, totalMemoryBytes: total, usableMemoryBytes: Math.round(total * 0.75), usableSource: METAL_FRACTION_WORDS }
  const machine = opts.usableGib !== undefined ? { platform: 'darwin' as const, totalMemoryBytes: total, usableMemoryBytes: Math.round(opts.usableGib * GIB), usableSource: opts.source ?? "the server's own gpu memory line in /fixture/ollama.log (Metal)" } : fraction
  const runners = opts.cacheType !== undefined || opts.slots !== undefined ? [{ command: `llama-server --model x -c 32768 -np ${opts.slots ?? 1}${opts.cacheType ? ` --cache-type-k ${opts.cacheType} --cache-type-v ${opts.cacheType}` : ''}`, ...(opts.slots !== undefined ? { slots: opts.slots } : {}), ...(opts.cacheType ? { cacheTypeK: opts.cacheType, cacheTypeV: opts.cacheType } : {}) }] : []
  return { server: { kind: 'ollama', root: ollama.root, version: '0.34.4', label: 'Ollama 0.34.4' }, loaded: [], listed: [], ...(opts.env ? { process: { pid: 1, command: 'ollama serve', env: opts.env, envReadable: true } } : {}), runners, launchForm: { kind: 'unknown', note: 'fixture' }, machine, readAtMs: Date.now() }
}
const OWNER_BOX = truthOf({ totalGib: 48, usableGib: 36.9, cacheType: 'q8_0', slots: 1 })
const SMALL_BOX = truthOf({ totalGib: 16 })

await refreshLocalDiscovery({ force: true })
const qwen27 = localRecordFor(`local/${MODEL_27}`)!
const qwen9 = localRecordFor(`local/${MODEL_9}`)!

section("1 · the seam (red on the base): auto is the biggest window that fits this machine's memory, not twice the first request")
{
  check('the discovery record carries the weights and the KV geometry from /api/tags and /api/show', qwen27.weightsBytes === WEIGHTS_27 && qwen27.geometry?.kvHeads === 64 && qwen27.geometry.attentionLayers === 16 && qwen9.weightsBytes === WEIGHTS_9 && qwen9.geometry?.kvHeads === 32, j({ weights: qwen27.weightsBytes, geometry: qwen27.geometry }))
  __pinLocalServerTruthForTest(OWNER_BOX)
  w.__resetLocalWindowsForTest()
  const decided = w.decideLocalWindow(qwen27, 73_000, undefined)
  check("the 27B on the owner's box (48 GiB, 36.9 GiB usable, q8_0, 1 slot): a ≈73k first request gets 256k — the trained max fits — never 147k", decided.window === 262144, String(decided.window))
  check("the decision says why: 256k · 16.2 GiB weights + 8.5 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot, reason max", decided.reason === 'max' && decided.words === '256k · 16.2 GiB weights + 8.5 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot', `${decided.reason} · ${decided.words}`)
  const nine = w.decideLocalWindow(qwen9, 73_000, undefined)
  check("the 9B on the owner's box: 256k (6.1 GiB weights + 4.3 GiB cache)", nine.window === 262144 && nine.reason === 'max' && nine.words === '256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot', nine.words)
}

section('2 · the one owner: fitLocalWindow — the biggest ladder rung ≤ the trained max whose projected load fits the usable ceiling')
const owner = await (async () => {
  try {
    return await import('../../src/services/localServer/localWindowFit.ts')
  } catch (error) {
    check('src/services/localServer/localWindowFit.ts imports', false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
    return undefined
  }
})()
if (!owner) finish()
{
  const { fitLocalWindow, localWindowRefusal, LOCAL_WINDOW_LADDER, localWindowRungs, serverCacheTypeOf, serverSlotsOf, fitLocalWindowOn } = owner
  check('the ladder is 32k · 64k · 128k · 256k; a 40k-trained model gets the one rung 32k; a 200k-trained model climbs to 128k', LOCAL_WINDOW_LADDER.join(',') === '32768,65536,131072,262144' && localWindowRungs(40960).join(',') === '32768' && localWindowRungs(200_000).join(',') === '32768,65536,131072' && localWindowRungs(undefined).length === 4)
  const g27 = memory.kvGeometryOf(INFO_27)!
  const g9 = memory.kvGeometryOf(INFO_9)!
  const box = (totalGib: number, usableGib?: number) => ({ machineBytes: totalGib * GIB, usableBytes: usableGib !== undefined ? Math.round(usableGib * GIB) : defaultMachineTruth('darwin', totalGib * GIB).usableMemoryBytes })
  const m27 = { name: MODEL_27, weightsBytes: WEIGHTS_27, geometry: g27, trainedMax: 262144 }
  const m9 = { name: MODEL_9, weightsBytes: WEIGHTS_9, geometry: g9, trainedMax: 262144 }
  const at = (model: typeof m27, totalGib: number, cacheType: string, slots: number, usableGib?: number) => fitLocalWindow({ ...model, ...box(totalGib, usableGib), slots, cacheType })
  const table: Array<[string, ReturnType<typeof at>, number, boolean, string]> = [
    ['27B · 48 GiB · q8_0 · 1 slot', at(m27, 48, 'q8_0', 1, 36.9), 262144, true, '256k · 16.2 GiB weights + 8.5 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot'],
    ['27B · 48 GiB · f16 · 1 slot', at(m27, 48, 'f16', 1, 36.9), 262144, true, '256k · 16.2 GiB weights + 16.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · f16 · 1 slot'],
    ['27B · 48 GiB · q8_0 · 4 slots', at(m27, 48, 'q8_0', 4, 36.9), 131072, false, '128k · 16.2 GiB weights + 17.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 4 slots · 256k does not fit (50.2 GiB)'],
    ['27B · 48 GiB · f16 · 4 slots', at(m27, 48, 'f16', 4, 36.9), 65536, false, '64k · 16.2 GiB weights + 16.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · f16 · 4 slots · 128k does not fit (48.2 GiB)'],
    ['27B · 16 GiB · f16 · 1 slot (nothing fits: the floor, said)', at(m27, 16, 'f16', 1), 32768, false, '32k · 16.2 GiB weights + 2.0 GiB cache — 18.2 GiB does not fit in 12.0 GiB usable (16.0 GiB box) · f16 · 1 slot'],
    ['27B · 16 GiB · q8_0 · 4 slots (nothing fits)', at(m27, 16, 'q8_0', 4), 32768, false, '32k · 16.2 GiB weights + 4.3 GiB cache — 20.5 GiB does not fit in 12.0 GiB usable (16.0 GiB box) · q8_0 · 4 slots'],
    ['27B · 96 GiB · f16 · 1 slot', at(m27, 96, 'f16', 1), 262144, true, '256k · 16.2 GiB weights + 16.0 GiB cache of 72.0 GiB usable (96.0 GiB box) · f16 · 1 slot'],
    ['27B · 96 GiB · f16 · 4 slots', at(m27, 96, 'f16', 4), 131072, false, '128k · 16.2 GiB weights + 32.0 GiB cache of 72.0 GiB usable (96.0 GiB box) · f16 · 4 slots · 256k does not fit (80.2 GiB)'],
    ['27B · 96 GiB · q8_0 · 4 slots', at(m27, 96, 'q8_0', 4), 262144, true, '256k · 16.2 GiB weights + 34.0 GiB cache of 72.0 GiB usable (96.0 GiB box) · q8_0 · 4 slots'],
    ['9B · 16 GiB · f16 · 1 slot', at(m9, 16, 'f16', 1), 131072, false, '128k · 6.1 GiB weights + 4.0 GiB cache of 12.0 GiB usable (16.0 GiB box) · f16 · 1 slot · 256k does not fit (14.1 GiB)'],
    ['9B · 16 GiB · f16 · 4 slots', at(m9, 16, 'f16', 4), 32768, false, '32k · 6.1 GiB weights + 4.0 GiB cache of 12.0 GiB usable (16.0 GiB box) · f16 · 4 slots · 64k does not fit (14.1 GiB)'],
    ['9B · 16 GiB · q8_0 · 1 slot', at(m9, 16, 'q8_0', 1), 262144, true, '256k · 6.1 GiB weights + 4.3 GiB cache of 12.0 GiB usable (16.0 GiB box) · q8_0 · 1 slot'],
    ['9B · 16 GiB · q8_0 · 4 slots', at(m9, 16, 'q8_0', 4), 65536, false, '64k · 6.1 GiB weights + 4.3 GiB cache of 12.0 GiB usable (16.0 GiB box) · q8_0 · 4 slots · 128k does not fit (14.6 GiB)'],
    ['9B · 48 GiB · q8_0 · 1 slot', at(m9, 48, 'q8_0', 1, 36.9), 262144, true, '256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot'],
    ['9B · 48 GiB · f16 · 4 slots', at(m9, 48, 'f16', 4, 36.9), 131072, false, '128k · 6.1 GiB weights + 16.0 GiB cache of 36.9 GiB usable (48.0 GiB box) · f16 · 4 slots · 256k does not fit (38.1 GiB)'],
    ['9B · 96 GiB · f16 · 4 slots', at(m9, 96, 'f16', 4), 262144, true, '256k · 6.1 GiB weights + 32.0 GiB cache of 72.0 GiB usable (96.0 GiB box) · f16 · 4 slots'],
  ]
  for (const [label, fit, window, atMax, words] of table) check(`${label}: ${memory.tokensWords(window)}${atMax ? ' = max' : ''}`, fit.window === window && fit.atMax === atMax && fit.words === words, `${fit.window} · atMax ${fit.atMax} · ${fit.words}`)
  const chosen = at(m9, 16, 'f16', 1)
  check('every rung projected: 32k 7.1 · 64k 8.1 · 128k 10.1 fit; 256k 14.1 does not (12.0 usable)', chosen.ladder.map(r => `${memory.tokensWords(r.window)} ${memory.gibWords(r.totalBytes)} ${r.fits}`).join(' | ') === '32k 7.1 GiB true | 64k 8.1 GiB true | 128k 10.1 GiB true | 256k 14.1 GiB false', j(chosen.ladder))
  check('the chosen rung is the biggest that fits and the next does not — the memory module\'s own arithmetic (projectLoad)', chosen.totalBytes === memory.projectLoad({ name: MODEL_9, weightsBytes: WEIGHTS_9, geometry: g9 }, 131072, 1, 'f16').totalBytes && chosen.fits && chosen.ladder[3]!.fits === false)
  check('never above the trained max: a 40k-trained 9B on 96 GiB gets 32k, at max', at({ ...m9, trainedMax: 40960 }, 96, 'f16', 1).window === 32768 && at({ ...m9, trainedMax: 40960 }, 96, 'f16', 1).atMax === false && at({ ...m9, trainedMax: 32768 }, 96, 'f16', 1).atMax === true)
  check('no trained max stated: the ladder runs to 256k and the rung is never called max', at({ name: MODEL_9, weightsBytes: WEIGHTS_9, geometry: g9 }, 96, 'f16', 1).window === 262144 && at({ name: MODEL_9, weightsBytes: WEIGHTS_9, geometry: g9 }, 96, 'f16', 1).atMax === false)
  check('an unknown cache type projects as f16 and is named as the runner gave it; the slots floor at 1', at(m9, 48, 'nonsense', 0, 36.9).cacheType === 'nonsense' && at(m9, 48, 'nonsense', 0, 36.9).cacheBytes === at(m9, 48, 'f16', 1, 36.9).cacheBytes && at(m9, 48, 'nonsense', 0, 36.9).slots === 1)
  const refusal9 = localWindowRefusal(chosen, 262144)
  check('the refusal on a rung above the fit names the load, the ceiling and the biggest rung that does fit', refusal9 === '14.1 GiB does not fit 12.0 GiB usable · 128k fits' && localWindowRefusal(chosen, 131072) === undefined && localWindowRefusal(chosen, 200_000) === '12.2 GiB does not fit 12.0 GiB usable · 128k fits', j([refusal9, localWindowRefusal(chosen, 200_000)]))
  check('when nothing fits the refusal says so', localWindowRefusal(at(m27, 16, 'f16', 1), 131072) === '24.2 GiB does not fit 12.0 GiB usable · no rung fits')
  check("the server's cache type: the runner's -ctk first, then the running env, then the launch form's env; the slots the same way, else 1", serverCacheTypeOf(OWNER_BOX) === 'q8_0' && serverSlotsOf(OWNER_BOX) === 1 && serverCacheTypeOf(truthOf({ totalGib: 48, env: { OLLAMA_KV_CACHE_TYPE: 'q4_0', OLLAMA_NUM_PARALLEL: '3' } })) === 'q4_0' && serverSlotsOf(truthOf({ totalGib: 48, env: { OLLAMA_NUM_PARALLEL: '3' } })) === 3 && serverCacheTypeOf({ ...SMALL_BOX, launchForm: { kind: 'app', env: { OLLAMA_KV_CACHE_TYPE: 'q8_0' }, note: 'x' } }) === 'q8_0' && serverCacheTypeOf(SMALL_BOX) === undefined && serverSlotsOf(SMALL_BOX) === 1)
  const onTruth = fitLocalWindowOn(OWNER_BOX, m27)
  check("fitLocalWindowOn reads the ceiling, its source, the cache type and the slots from the truth", onTruth.window === 262144 && onTruth.cacheType === 'q8_0' && onTruth.slots === 1 && onTruth.usableSource === "the server's own gpu memory line in /fixture/ollama.log (Metal)" && memory.gibWords(onTruth.usableBytes) === '36.9 GiB')
}

section('3 · auto = the fit rung; the hold is one window per model per process, unchanged by a later request; a changed setting re-decides')
{
  __pinLocalServerTruthForTest(SMALL_BOX)
  w.__resetLocalWindowsForTest()
  const first = w.decideLocalWindow(qwen9, 62_000, undefined)
  const second = w.decideLocalWindow(qwen9, 200_000, undefined)
  check('the 9B on a 16 GiB box (12.0 GiB usable by the Metal fraction, f16, 1 slot): auto = 128k, reason fit', first.window === 131072 && first.reason === 'fit' && first.words === '128k · 6.1 GiB weights + 4.0 GiB cache of 12.0 GiB usable (16.0 GiB box) · f16 · 1 slot · 256k does not fit (14.1 GiB)', `${first.window} · ${first.reason} · ${first.words}`)
  check('a later, bigger request reuses the hold (the same object); the size never re-decides', second === first && second.window === 131072)
  __pinLocalServerTruthForTest(OWNER_BOX)
  check('a truth that changes later does not move the hold either', w.decideLocalWindow(qwen9, 5_000, undefined) === first)
  const set = w.decideLocalWindow(qwen9, 5_000, 65536)
  check('a changed setting re-decides: 64k, reason set, the words name your setting', set !== first && set.window === 65536 && set.reason === 'set' && set.words === '64k · your setting', set.words)
  const above = w.decideLocalWindow(qwen9, 5_000, 400_000)
  check('a number above the trained max clamps to it and the words carry the refusal when it does not fit', above.window === 262144 && above.reason === 'set' && above.words === '256k · your setting', above.words)
  __pinLocalServerTruthForTest(SMALL_BOX)
  w.__resetLocalWindowsForTest()
  const tooBig = w.decideLocalWindow(qwen9, 5_000, 262144)
  check('on the 16 GiB box a 256k setting is kept (the setting is saved) but the words say it does not fit and name 128k', tooBig.window === 262144 && tooBig.reason === 'set' && tooBig.words === '256k · your setting — 14.1 GiB does not fit 12.0 GiB usable · 128k fits', tooBig.words)
  const server = w.decideLocalWindow(qwen9, 5_000, 'server')
  const max = w.decideLocalWindow(qwen9, 5_000, 'max')
  check("'server' holds no window (reason srv); 'max' holds the trained max (reason max)", server.window === undefined && server.reason === 'srv' && max.window === 262144 && max.reason === 'max', j([server, max]))
  const vllm = { id: 'Qwen/Qwen3-32B', server: 'vllm' as const, modelMaxContext: 40960, baseUrl: 'x', contextWindow: { tokens: 40960, source: 'served' as const } }
  check('a server-start kind holds nothing and says so', w.decideLocalWindow(vllm, 62_000, undefined).window === undefined && w.decideLocalWindow(vllm, 62_000, undefined).words === 'set at server start')
  w.__resetLocalWindowsForTest()
}

section('4 · the fallbacks, said in the words: with no geometry or no memory truth the machine was not read, so the window comes out bigger, not smaller — the trained max when stated, else the served window, else twice the request and never under 64k')
{
  __pinLocalServerTruthForTest(null)
  __resetLocalServerTruthForTest()
  w.__resetLocalWindowsForTest()
  const bare = { id: 'mystery:latest', server: 'ollama' as const, modelMaxContext: 262144 }
  const noGeometry = w.chooseLocalWindow(bare, 73_000, undefined, OWNER_BOX)
  check('no geometry, the trained max stated: 262144, reason max, the words name the missing geometry and the unread machine', noGeometry.window === 262144 && noGeometry.reason === 'max' && noGeometry.words === "256k · the trained max — no KV geometry read for mystery:latest; the machine's memory was not read, so the window comes out bigger, not smaller", noGeometry.words)
  check('the doubling arithmetic: 62k ⇒ 128k · 20k ⇒ the 64k floor · 1k ⇒ the 64k floor · a 32k-trained model ⇒ 32k · no max ⇒ the rule alone', w.doubledRequestWindow(62_000, 262144) === 131072 && w.doubledRequestWindow(20_000, 262144) === 65536 && w.doubledRequestWindow(1_000, 262144) === 65536 && w.doubledRequestWindow(62_000, 32768) === 32768 && w.doubledRequestWindow(62_000) === 131072)
  const noTruth = w.chooseLocalWindow(qwen27, 73_000, undefined, null)
  check('no memory truth, the 27B with its geometry: the trained max (256k, reason max) — never a fraction-rule guess, never twice the request — the words say no truth was read', noTruth.window === 262144 && noTruth.reason === 'max' && noTruth.words === "256k · the trained max — no memory truth read; the machine's memory was not read, so the window comes out bigger, not smaller", noTruth.words)
  const unstated = { id: 'mystery:latest', server: 'ollama' as const, modelMaxContext: undefined }
  const served = w.chooseLocalWindow({ ...unstated, contextWindow: { tokens: 131072, source: 'served' as const } }, 15_000, undefined, null)
  check('no trained max, a served 128k: the served window, reason srv', served.window === 131072 && served.reason === 'srv' && served.words.startsWith('128k · the served window'), served.words)
  const neither = w.chooseLocalWindow(unstated, 73_000, undefined, null)
  check('no trained max and no served window: twice the request (144k), reason req, the words say why', neither.window === 147456 && neither.reason === 'req' && neither.words.startsWith('144k · twice the first request, rounded up to 16k, never under 64k (≈73k asked)') && neither.words.includes('no trained max stated and no served window'), neither.words)
  check('the Linux fraction rule is total memory; the darwin rule is three quarters', defaultMachineTruth('linux', 16 * GIB).usableMemoryBytes === 16 * GIB && defaultMachineTruth('darwin', 16 * GIB).usableMemoryBytes === 12 * GIB && defaultMachineTruth('darwin', 16 * GIB).usableSource.startsWith('about three quarters'))
  check('with no truth cached the sync decision falls back the same way (the trained max)', w.localWindowTruth() === null && w.decideLocalWindow(bare, 73_000, undefined).reason === 'max')
  w.__resetLocalWindowsForTest()
}

section('5 · the dispatch road: the first send under auto reads the machine truth (the pin here) and rides /api/chat with the fit rung as num_ctx; the crewmate reuses it')
{
  __pinLocalServerTruthForTest(OWNER_BOX)
  w.__resetLocalWindowsForTest()
  __resetLocalDiscoveryForTest()
  await refreshLocalDiscovery({ force: true })
  const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
  const params = (chars: number, extra: Record<string, unknown>) => ({
    messages: [{ type: 'user', message: { role: 'user', content: 'x'.repeat(chars) }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: [] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${MODEL_27}`, querySource: 'user', getToolPermissionContext: async () => ({ mode: 'default' }) as never, ...extra } as never,
  })
  const from = hits.length
  const yielded: Array<{ type?: string; isApiErrorMessage?: boolean }> = []
  for await (const item of localCallModel(params(292_000, {}) as never)) yielded.push(item as never)
  const chat = hits.slice(from).find(h => h.url === '/api/chat')
  check('the ≈73k first request rode /api/chat with num_ctx 262144 — the fit rung, not 147k — and settled', chat !== undefined && (chat.body.options as { num_ctx?: number }).num_ctx === 262144 && !yielded.some(m => m.isApiErrorMessage === true), j(chat?.body.options))
  const again = hits.length
  for await (const item of localCallModel(params(20_000, { agentId: 'agent-000001', querySource: 'agent:builtin:mercury-crew' }) as never)) yielded.push(item as never)
  const crew = hits.slice(again).find(h => h.url === '/api/chat')
  check('a crewmate\'s smaller request carries the SAME held num_ctx', crew !== undefined && (crew.body.options as { num_ctx?: number }).num_ctx === 262144)
  check('the held decision carries its reason and words for the rail and the deck', w.heldLocalWindow(localRecordFor(`local/${MODEL_27}`)!)?.reason === 'max' && w.heldLocalWindow(localRecordFor(`local/${MODEL_27}`)!)?.words.startsWith('256k · 16.2 GiB weights') === true)
  check('nothing but tags/version/ps/show/chat reached the server — never a load, never a generation', hits.every(h => /^\/api\/(tags|version|ps|show|chat)$/.test(h.url)), hits.map(h => h.url).join(','))
}

section("6 · the words: the picker's w row, the /config row, the rail's reason tag and the deck's rule sentence")
{
  const { localModelWindowRow } = await import('../../src/components/Settings/Config.tsx')
  __pinLocalServerTruthForTest(OWNER_BOX)
  w.__resetLocalWindowsForTest()
  const record = localRecordFor(`local/${MODEL_27}`)!
  check('before any send the w row already says what auto will pick: auto → 256k max', w.localWindowChoiceLine(record, { wide: true }) === 'window · not loaded · max 256k · [auto → 256k max] · server · 32k · 64k · 128k · max · number · w cycles', w.localWindowChoiceLine(record, { wide: true }))
  w.decideLocalWindow(record, 73_000, undefined)
  check('after the send it says held with the reason: auto → 256k max held', w.localWindowChoiceLine(record, { wide: true }).includes('[auto → 256k max held]'), w.localWindowChoiceLine(record, { wide: true }))
  check('the /config value words: auto → 256k held this session (the trained max) · num_ctx on every request', w.localWindowValueWords(record, undefined) === 'auto → 256k held this session (the trained max) · num_ctx on every request', w.localWindowValueWords(record, undefined))
  const tag = w.localWindowReasonTag(`local/${MODEL_27}`, 262144)
  check("the rail's tag for the held window is max; a window the hold does not explain gets no tag", tag === 'max' && w.localWindowReasonTag(`local/${MODEL_27}`, 131072) === undefined && w.localWindowReasonTag('claude-fable-5-1', 262144) === undefined)
  check("the deck's rule sentence is the hold's words", w.localWindowRuleWords(`local/${MODEL_27}`, 262144) === '256k · 16.2 GiB weights + 8.5 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot' && w.localWindowRuleWords(`local/${MODEL_27}`, 131072) === undefined)
  __pinLocalServerTruthForTest(SMALL_BOX)
  w.__resetLocalWindowsForTest()
  const nine = localRecordFor(`local/${MODEL_9}`)!
  w.writeLocalWindowSetting(nine, 'max')
  const refused = w.localWindowChoiceLine(nine, { wide: true })
  check("on a 16 GiB box the 9B's picked max rung refuses politely and names the biggest rung that fits: [max — 14.1 GiB does not fit 12.0 GiB usable · 128k fits]", refused === 'window · not loaded · max 256k · auto → 128k fit · server · 32k · 64k · 128k · [max — 14.1 GiB does not fit 12.0 GiB usable · 128k fits] · number · w cycles', refused)
  w.writeLocalWindowSetting(nine, 131072)
  check('a rung that fits carries no refusal: [128k]', w.localWindowChoiceLine(nine, { wide: true }).includes(' · [128k] · '), w.localWindowChoiceLine(nine, { wide: true }))
  w.writeLocalWindowSetting(nine, 200_000)
  check('a typed number is projected too, spelled as typed: [200000 — 12.2 GiB does not fit 12.0 GiB usable · 128k fits]', w.localWindowChoiceLine(nine, { wide: true }).includes('[200000 — 12.2 GiB does not fit 12.0 GiB usable · 128k fits]'), w.localWindowChoiceLine(nine, { wide: true }))
  const row = localModelWindowRow(nine, 'local')
  check('the /config row on that setting: the value carries the refusal in the same words, overFit marks the failure ink, the note explains the rule and the refusal', row.overFit && row.valueText.startsWith('200000 — 12.2 GiB does not fit 12.0 GiB usable · 128k fits') && row.note.includes('auto = the biggest of 32k · 64k · 128k · 256k whose projected load') && row.note.includes('The setting is saved but does not fit: 12.2 GiB does not fit 12.0 GiB usable · 128k fits.'), `${row.valueText} || ${row.note}`)
  w.writeLocalWindowSetting(nine, undefined)
  const auto = localModelWindowRow(nine, 'local')
  check('under auto the /config row predicts the fit rung and is not in the failure ink', !auto.overFit && auto.valueText.startsWith('auto → 128k (the biggest rung that fits)'), auto.valueText)
  const narrow27 = { ...localRecordFor(`local/${MODEL_27}`)! }
  w.writeLocalWindowSetting(narrow27, 131072)
  const narrow = w.localWindowChoiceLine(narrow27, { wide: false })
  check('the narrow row (80 columns) carries the refusal too; when nothing fits it says so', narrow === 'window · not loaded auto → 32k fit · server · 32k · 64k · [128k — 24.2 GiB does not fit 12.0 GiB usable · no rung fits] · max · w cycles', narrow)
  w.writeLocalWindowSetting(narrow27, undefined)
  const span = (line: string) => {
    const s = w.localWindowRefusalSpan(line)
    return s === undefined ? undefined : line.slice(s.start, s.end)
  }
  check('the failure-ink span: the whole bracket on one line; a wrapped head runs to the line end; a wrapped tail runs to the closing bracket; a plain rung has none', span(refused) === '[max — 14.1 GiB does not fit 12.0 GiB usable · 128k fits]' && span('window · [max — 14.1 GiB does not fit') === '[max — 14.1 GiB does not fit' && span('12.0 GiB usable · 128k fits] · number · w cycles') === '12.0 GiB usable · 128k fits]' && span('window · served 256k · [128k] · max · w cycles') === undefined && span('window [auto → 128k fit held] · server') === undefined)
  __pinLocalServerTruthForTest(null)
  __resetLocalServerTruthForTest()
  w.__resetLocalWindowsForTest()
  check('with no truth the rows say nothing about fit: auto plain, no refusal', w.localWindowChoiceLine(nine, { wide: true }).includes('[auto] ·') && w.localWindowValueWords(nine, 262144) === '256k · num_ctx on every request', w.localWindowChoiceLine(nine, { wide: true }))
}

section("7 · step 5 of /localsetup on the same owner: the ceiling from the truth reader, the cache type and slots from the runner")
{
  const setup = await import('../../src/services/localSetup/index.ts')
  const g9 = memory.kvGeometryOf(INFO_9)!
  const pure = setup.chooseWindowFrom({ tag: MODEL_9, weightsBytes: WEIGHTS_9, geometry: g9, trainedMax: 262144, machineBytes: 48 * GIB, usableBytes: Math.round(36.9 * GIB), slots: 1, cacheType: 'q8_0' })
  check("chooseWindowFrom is the owner's answer with the tag beside it", pure.tag === MODEL_9 && pure.window === 262144 && pure.words === '256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot' && setup.windowWords(pure) === pure.words, pure.words)
  const written: Array<[string, number]> = []
  const io = { env: { MERCURY_LOCAL_PROBE_TARGETS: `ollama=${ollama.root}` }, platform: 'darwin' as const, home: '/fixture/home', fetchImpl: globalThis.fetch, timeoutMs: 400, totalMemoryBytes: 48 * GIB, readTruth: async () => OWNER_BOX, writeWindow: (tag: string, window: number) => void written.push([tag, window]) }
  const chosen = await setup.chooseWindow(ollama.root, MODEL_9, io)
  check("chooseWindow on the owner's box: 256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot, written through the window seam", chosen.window === 262144 && chosen.words === '256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot' && chosen.usableSource?.startsWith("the server's own gpu memory line") === true && written.length === 1 && written[0]![1] === 262144, chosen.words)
  const small = await setup.chooseWindow(ollama.root, MODEL_9, { ...io, readTruth: async () => SMALL_BOX, parallelSlots: 4 })
  check('on a 16 GiB box with 4 slots asked: 32k, the words say 4 slots and that 64k does not fit', small.window === 32768 && small.words === '32k · 6.1 GiB weights + 4.0 GiB cache of 12.0 GiB usable (16.0 GiB box) · f16 · 4 slots · 64k does not fit (14.1 GiB)', small.words)
  const typed = await setup.chooseWindow(ollama.root, MODEL_9, { ...io, readTruth: async () => SMALL_BOX, cacheType: 'q8_0' })
  check('a cache type given through the seam outranks the truth', typed.window === 262144 && typed.cacheType === 'q8_0', typed.words)
  check('the same rule, the same figures: step 5 and auto agree on the owner\'s box', chosen.window === w.chooseLocalWindow(localRecordFor(`local/${MODEL_9}`)!, 73_000, undefined, OWNER_BOX).window && chosen.words === w.chooseLocalWindow(localRecordFor(`local/${MODEL_9}`)!, 73_000, undefined, OWNER_BOX).words)
}

section(`8 · the hybrid law (red on the base): ${HYBRID_27} states one head_count_kv for 65 blocks with full_attention_interval 4 — 16 layers keep a cache, not 65; a loaded model's measured size outranks the formula`)
{
  const { fitLocalWindow, fitLocalWindowOn, localWindowRefusal, localWindowResident, serverMeasuredOf } = owner
  const gH27 = memory.kvGeometryOf(SHOW_H27.model_info)
  const g9 = memory.kvGeometryOf(SHOW_9.model_info)
  check(`${HYBRID_27}'s real /api/show: 4 KV heads × 16 cached layers of 65 (interval 4), 256-wide keys and values`, gH27?.kvHeads === 64 && gH27.attentionLayers === 16 && gH27.blockCount === 65 && gH27.interval === 4 && gH27.keyLength === 256 && gH27.valueLength === 256, j(gH27))
  check(`${MODEL_9}'s real /api/show states the layers as a list — 8 of 32 keep 4 heads, the interval read beside`, g9?.kvHeads === 32 && g9.attentionLayers === 8 && g9.blockCount === 32 && g9.interval === 4, j(g9))
  check('the q8_0 cache on the hybrid 27B: 34816 bytes per token (64 heads × 512 × 34/32), 8.5 GiB at 256k, 4.3 GiB at 128k — never 141440 (65 layers)', gH27 !== undefined && memory.kvBytesPerToken(gH27, 'q8_0') === 34816 && memory.gibWords(memory.kvCacheBytes(gH27, 262144, 1, 'q8_0')) === '8.5 GiB' && memory.gibWords(memory.kvCacheBytes(gH27, 131072, 1, 'q8_0')) === '4.3 GiB', gH27 ? String(memory.kvBytesPerToken(gH27, 'q8_0')) : 'no geometry')
  const dense = memory.kvGeometryOf({ 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 })
  check('a geometry with no interval key keeps the dense sum: 8 heads × 32 layers = 256, every block a cache layer, no interval field', dense?.kvHeads === 256 && dense.attentionLayers === 32 && dense.interval === undefined, j(dense))
  check('an interval of 1 is every layer; a list of per-layer heads outranks the interval', memory.kvGeometryOf({ ...SHOW_H27.model_info, 'qwen35.full_attention_interval': 1 })?.attentionLayers === 65 && memory.kvGeometryOf({ ...SHOW_H27.model_info, 'qwen35.attention.head_count_kv': kvHeads(65) })?.attentionLayers === 16)
  __resetLocalDiscoveryForTest()
  await refreshLocalDiscovery({ force: true })
  const h27 = localRecordFor(`local/${HYBRID_27}`)!
  check('the discovery record carries the hybrid geometry with its interval and the weights from /api/tags', h27.weightsBytes === WEIGHTS_H27 && h27.geometry?.attentionLayers === 16 && h27.geometry.kvHeads === 64 && h27.geometry.interval === 4 && h27.modelMaxContext === 262144 && h27.contextWindow === undefined && h27.servedBytes === undefined, j({ weights: h27.weightsBytes, geometry: h27.geometry, window: h27.contextWindow }))
  __pinLocalServerTruthForTest(OWNER_BOX)
  w.__resetLocalWindowsForTest()
  const auto = w.decideLocalWindow(h27, 73_000, undefined)
  check("auto on the owner's box (48 GiB, 36.9 GiB usable, q8_0, 1 slot): 256k, reason max — 16.5 GiB weights + 8.5 GiB cache = 25.0 GiB; never 128k on a 51.1 GiB sum", auto.window === 262144 && auto.reason === 'max' && auto.words === '256k · 16.5 GiB weights + 8.5 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot' && memory.gibWords(auto.fit?.totalBytes ?? 0) === '25.0 GiB', `${auto.window} · ${auto.reason} · ${auto.words}`)
  check('every rung fits: 32k 17.6 · 64k 18.6 · 128k 20.8 · 256k 25.0 GiB', auto.fit?.ladder.map(r => `${memory.tokensWords(r.window)} ${memory.gibWords(r.totalBytes)} ${r.fits}`).join(' | ') === '32k 17.6 GiB true | 64k 18.6 GiB true | 128k 20.8 GiB true | 256k 25.0 GiB true', j(auto.fit?.ladder))
  const decisionLine = typeof w.localWindowDecisionLine === 'function' ? w.localWindowDecisionLine(h27, auto) : undefined
  check(`the send writes the decision to the debug log: [local-window] ${HYBRID_27}: 262144 · max — the rule's words`, decisionLine === `[local-window] ${HYBRID_27}: 262144 · max — 256k · 16.5 GiB weights + 8.5 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot`, String(decisionLine))
  const byHand = w.chooseLocalWindow(h27, 73_000, 'max', OWNER_BOX)
  check("the trained max picked by hand is accepted: 256k · the trained max — your setting, no refusal", byHand.window === 262144 && byHand.reason === 'max' && byHand.words === '256k · the trained max — your setting' && w.localWindowRefusalWords(h27, 'max', OWNER_BOX) === undefined && w.localWindowRefusalWords(h27, 262144, OWNER_BOX) === undefined, byHand.words)
  check("the picker's w row shows [max] with no refusal beside the held auto → 256k max", w.localWindowChoiceLine(h27, { wide: true, setting: 'max', truth: OWNER_BOX }) === 'window · not loaded · max 256k · auto → 256k max held · server · 32k · 64k · 128k · [max] · number · w cycles', w.localWindowChoiceLine(h27, { wide: true, setting: 'max', truth: OWNER_BOX }))
  const nine = w.decideLocalWindow(localRecordFor(`local/${MODEL_9}`)!, 73_000, undefined)
  check(`${MODEL_9} on the same box: 256k max (6.1 GiB weights + 4.3 GiB cache)`, nine.window === 262144 && nine.reason === 'max' && nine.words === '256k · 6.1 GiB weights + 4.3 GiB cache of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot', nine.words)
  const mH27 = { name: HYBRID_27, weightsBytes: WEIGHTS_H27, geometry: gH27!, trainedMax: 262144 }
  const loadedBox = { ...OWNER_BOX, loaded: [{ name: HYBRID_27, sizeBytes: RESIDENT_H27_128K, sizeVramBytes: RESIDENT_H27_128K, contextLength: 131072 }] }
  const measuredArm = typeof serverMeasuredOf === 'function' && typeof localWindowResident === 'function' && typeof w.localWindowMeasuredOf === 'function'
  check('the fit owner exports the measured arm (serverMeasuredOf · localWindowResident) and the record its measurement (localWindowMeasuredOf)', measuredArm)
  const MEASURED_WORDS = '256k · 17.8 GiB measured at 128k + 4.3 GiB more cache = 22.0 GiB of 36.9 GiB usable (48.0 GiB box) · q8_0 · 1 slot'
  if (measuredArm) {
    check("the truth's loaded row is the measurement: 19.1 GB at 128k with the runner's one slot", j(serverMeasuredOf(loadedBox, HYBRID_27)) === j({ bytes: RESIDENT_H27_128K, window: 131072, slots: 1 }) && serverMeasuredOf(OWNER_BOX, HYBRID_27) === undefined && serverMeasuredOf(loadedBox, MODEL_9) === undefined)
    const measured = fitLocalWindowOn(loadedBox, mH27)
    check('the measured arm: 19.1 GB (17.8 GiB) resident at 128k less its 4.3 GiB cache is 13.5 GiB fixed; 256k adds 8.5 GiB of cache — 22.0 GiB, fits, 256k max', measured.window === 262144 && measured.atMax && measured.totalBytes === RESIDENT_H27_128K - memory.kvCacheBytes(gH27!, 131072, 1, 'q8_0') + memory.kvCacheBytes(gH27!, 262144, 1, 'q8_0') && memory.gibWords(measured.totalBytes) === '22.0 GiB' && memory.gibWords(localWindowResident(measured).bytes) === '13.5 GiB' && localWindowRefusal(measured, 262144) === undefined, `${measured.window} · ${memory.gibWords(measured.totalBytes)}`)
    check(`the words say what was measured and what the bigger window adds: ${MEASURED_WORDS}`, measured.words === MEASURED_WORDS, measured.words)
    check("the measured rung is the measurement itself: the 128k rung projects exactly 19.1 GB; the ladder reads 32k 14.6 · 64k 15.7 · 128k 17.8 · 256k 22.0 GiB", measured.ladder[2]?.totalBytes === RESIDENT_H27_128K && measured.ladder.map(r => `${memory.tokensWords(r.window)} ${memory.gibWords(r.totalBytes)}`).join(' | ') === '32k 14.6 GiB | 64k 15.7 GiB | 128k 17.8 GiB | 256k 22.0 GiB', j(measured.ladder))
    const tight = fitLocalWindowOn({ ...loadedBox, machine: { ...loadedBox.machine, usableMemoryBytes: 21 * GIB } }, mH27)
    check('on a 21 GiB ceiling the same measurement keeps 128k and says so: 128k · 17.8 GiB measured at 128k of 21.0 GiB usable (48.0 GiB box) · q8_0 · 1 slot · 256k does not fit (22.0 GiB)', tight.window === 131072 && !tight.atMax && tight.words === '128k · 17.8 GiB measured at 128k of 21.0 GiB usable (48.0 GiB box) · q8_0 · 1 slot · 256k does not fit (22.0 GiB)' && localWindowRefusal(tight, 262144) === '22.0 GiB does not fit 21.0 GiB usable · 128k fits', tight.words)
    const down = fitLocalWindow({ ...mH27, machineBytes: 48 * GIB, usableBytes: Math.round(17 * GIB), slots: 1, cacheType: 'q8_0', measured: { bytes: RESIDENT_H27_128K, window: 131072 } })
    check('a smaller window subtracts: 64k · 17.8 GiB measured at 128k − 2.1 GiB less cache = 15.7 GiB of 17.0 GiB usable (48.0 GiB box) · q8_0 · 1 slot · 128k does not fit (17.8 GiB)', down.window === 65536 && down.words === '64k · 17.8 GiB measured at 128k − 2.1 GiB less cache = 15.7 GiB of 17.0 GiB usable (48.0 GiB box) · q8_0 · 1 slot · 128k does not fit (17.8 GiB)', down.words)
    const suspect = fitLocalWindowOn({ ...loadedBox, loaded: [{ name: HYBRID_27, sizeBytes: 1_000_000, contextLength: 131072 }] }, mH27)
    check('a measurement smaller than its own cache is not trusted: the formula stands and the words are the formula words', suspect.words === auto.words && localWindowResident(suspect).measured === undefined && suspect.measured?.bytes === 1_000_000, suspect.words)
    const fourSlots = fitLocalWindowOn({ ...loadedBox, runners: [{ command: 'llama-server -np 4 --cache-type-k q8_0', slots: 4, cacheTypeK: 'q8_0' }] }, mH27)
    check('the slots ride with the measurement: a 4-slot runner measured at 128k holds 17.0 GiB of cache, so the fixed part is 0.8 GiB and 256k with 4 slots (34.8 GiB) fits — 256k max', fourSlots.slots === 4 && fourSlots.measured?.slots === 4 && memory.gibWords(localWindowResident(fourSlots).bytes) === '0.8 GiB' && fourSlots.window === 262144 && memory.gibWords(fourSlots.totalBytes) === '34.8 GiB', `${fourSlots.window} · ${memory.gibWords(fourSlots.totalBytes)} · ${fourSlots.words}`)
  }
  psModels.push({ name: HYBRID_27, model: HYBRID_27, size: RESIDENT_H27_128K, size_vram: RESIDENT_H27_128K, context_length: 131072, details: SHOW_H27.details })
  __resetLocalDiscoveryForTest()
  await refreshLocalDiscovery({ force: true })
  const loadedRecord = localRecordFor(`local/${HYBRID_27}`)!
  check('the discovery record reads the loaded size beside the served window from /api/ps: 19.1 GB at 128k', loadedRecord.contextWindow?.source === 'served' && loadedRecord.contextWindow.tokens === 131072 && loadedRecord.servedBytes === RESIDENT_H27_128K && loadedRecord.loaded === true && (measuredArm ? j(w.localWindowMeasuredOf(loadedRecord)) === j({ bytes: RESIDENT_H27_128K, window: 131072 }) : false), j({ window: loadedRecord.contextWindow, bytes: loadedRecord.servedBytes }))
  w.__resetLocalWindowsForTest()
  const decided = w.decideLocalWindow(loadedRecord, 73_000, undefined)
  check('auto on the loaded record takes the measured arm: 256k max with the measured words', decided.window === 262144 && decided.reason === 'max' && decided.words === MEASURED_WORDS && decided.fit?.measured?.bytes === RESIDENT_H27_128K, `${decided.window} · ${decided.words}`)
  check("the picker's w row on the loaded record: served 128k, auto → 256k max held", w.localWindowChoiceLine(loadedRecord, { wide: true, truth: OWNER_BOX }) === 'window · served 128k · [auto → 256k max held] · server · 32k · 64k · 128k · max · number · w cycles', w.localWindowChoiceLine(loadedRecord, { wide: true, truth: OWNER_BOX }))
  const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
  const from = hits.length
  const yielded: Array<{ isApiErrorMessage?: boolean }> = []
  const params = {
    messages: [{ type: 'user', message: { role: 'user', content: 'x'.repeat(292_000) }, uuid: '00000000-0000-4000-8000-000000000002', timestamp: new Date().toISOString() }] as never,
    systemPrompt: [] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${HYBRID_27}`, querySource: 'user', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  }
  for await (const item of localCallModel(params as never)) yielded.push(item as never)
  const chat = hits.slice(from).find(h => h.url === '/api/chat')
  check(`the ≈73k first request to ${HYBRID_27} rides /api/chat with num_ctx 262144 — the trained max, not 131072 — and settles`, chat !== undefined && (chat.body.options as { num_ctx?: number }).num_ctx === 262144 && !yielded.some(m => m.isApiErrorMessage === true), j(chat?.body.options))
  check('still nothing but tags/version/ps/show/chat reached the server', hits.every(h => /^\/api\/(tags|version|ps|show|chat)$/.test(h.url)), hits.map(h => h.url).join(','))
  psModels.length = 0
  __resetLocalDiscoveryForTest()
  w.__resetLocalWindowsForTest()
  __pinLocalServerTruthForTest(null)
  __resetLocalServerTruthForTest()
}

section('9 · the small-machine room warning (red on the base): under 16 GiB a picked window that fits but leaves under a tenth of usable memory or under 1 GiB, whichever is larger, is warned with the biggest smaller rung that leaves room; auto, server, a roomy pick, a refused pick and a 16 GiB box are untouched')
{
  const { fitLocalWindow, localWindowRefusal, localWindowRoomWarning, localWindowRoomFloor, smallMachine, SMALL_MACHINE_BYTES, LOCAL_WINDOW_ROOM_FRACTION, LOCAL_WINDOW_ROOM_FLOOR_BYTES } = owner
  const g9 = memory.kvGeometryOf(INFO_9)!
  const tiny = memory.kvGeometryOf({ 'general.architecture': 'llama', 'llama.block_count': 8, 'llama.attention.head_count': 8, 'llama.attention.head_count_kv': 1, 'llama.embedding_length': 1024 })!
  const at = (weightsBytes: number, totalBytes: number, usableBytes: number, cacheType: string, extra: { trainedMax?: number; geometry?: typeof g9; measured?: { bytes: number; window: number } } = {}) => fitLocalWindow({ name: 'qwen3.5:4b', weightsBytes, geometry: extra.geometry ?? g9, trainedMax: extra.trainedMax ?? 262144, machineBytes: totalBytes, usableBytes, slots: 1, cacheType, ...(extra.measured !== undefined ? { measured: extra.measured } : {}) })
  const W4 = Math.round(3.8 * GIB)
  check('a small machine is one under 16 GiB of total memory: 16 GiB − 1 byte is small, 16 GiB is not, a 16 GB Mac (os.totalmem 17179869184) is not, an 8 GB box is', SMALL_MACHINE_BYTES === 16 * GIB && smallMachine(16 * GIB - 1) && !smallMachine(16 * GIB) && !smallMachine(17179869184) && smallMachine(8_000_000_000))
  check('the room floor is a tenth of usable memory or 1 GiB, whichever is larger: 1.0 GiB at 6 GiB usable, 1.0 GiB at 8 GiB, 1.2 GiB at 12 GiB', LOCAL_WINDOW_ROOM_FRACTION === 0.1 && LOCAL_WINDOW_ROOM_FLOOR_BYTES === GIB && localWindowRoomFloor(6 * GIB) === GIB && localWindowRoomFloor(8 * GIB) === GIB && memory.gibWords(localWindowRoomFloor(12 * GIB)) === '1.2 GiB', j([localWindowRoomFloor(6 * GIB), localWindowRoomFloor(12 * GIB)]))
  const eight = at(W4, 8 * GIB, 6 * GIB, 'f16')
  check('auto is untouched: a 3.8 GiB 4B on an 8 GiB darwin box (6.0 GiB usable, f16, 1 slot) still takes 64k, the biggest rung that fits, with the same words', eight.window === 65536 && !eight.atMax && eight.words === '64k · 3.8 GiB weights + 2.0 GiB cache of 6.0 GiB usable (8.0 GiB box) · f16 · 1 slot · 128k does not fit (7.8 GiB)', `${eight.window} · ${eight.words}`)
  check('the ladder on that box: 32k 4.8 (1.2 GiB of room) · 64k 5.8 (0.2 GiB) fit; 128k 7.8 · 256k 11.8 do not', eight.ladder.map(r => `${memory.tokensWords(r.window)} ${memory.gibWords(r.totalBytes)} ${r.fits}`).join(' | ') === '32k 4.8 GiB true | 64k 5.8 GiB true | 128k 7.8 GiB false | 256k 11.8 GiB false', j(eight.ladder))
  check('a pick of 64k fits but leaves 0.2 GiB, under the 1.0 GiB floor: 64k leaves 0.2 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB', localWindowRoomWarning(eight, 65536) === '64k leaves 0.2 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB', String(localWindowRoomWarning(eight, 65536)))
  check('a pick of 32k leaves 1.2 GiB, over the floor: no warning', localWindowRoomWarning(eight, 32768) === undefined, String(localWindowRoomWarning(eight, 32768)))
  check('a typed 48k is projected the same way: 48k leaves 0.7 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB', localWindowRoomWarning(eight, 49152) === '48k leaves 0.7 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB', String(localWindowRoomWarning(eight, 49152)))
  check('the refusal wins: 128k and 256k do not fit, so the warning is silent and the refusal stands (7.8 GiB does not fit 6.0 GiB usable · 64k fits)', localWindowRoomWarning(eight, 131072) === undefined && localWindowRoomWarning(eight, 262144) === undefined && localWindowRefusal(eight, 131072) === '7.8 GiB does not fit 6.0 GiB usable · 64k fits' && localWindowRefusal(eight, 65536) === undefined, j([localWindowRoomWarning(eight, 131072), localWindowRefusal(eight, 131072)]))
  const sixteen = at(W4, 16 * GIB, 6 * GIB, 'f16')
  const nearly = at(W4, 16 * GIB - 1, 6 * GIB, 'f16')
  check('the edge is the box, not the ceiling: the same 6.0 GiB usable on a 16 GiB box warns nothing; on a box one byte smaller it warns and names the box', localWindowRoomWarning(sixteen, 65536) === undefined && localWindowRoomWarning(nearly, 65536) === '64k leaves 0.2 GiB of 6.0 GiB usable (16.0 GiB box) · 32k leaves 1.2 GiB', j([localWindowRoomWarning(sixteen, 65536), localWindowRoomWarning(nearly, 65536)]))
  const linux = at(W4, 8 * GIB, 8 * GIB, 'f16')
  check('an 8 GiB Linux box (usable = total): 128k leaves 0.2 GiB of 8.0 GiB usable (8.0 GiB box) · 64k leaves 2.2 GiB; 64k itself is roomy', localWindowRoomWarning(linux, 131072) === '128k leaves 0.2 GiB of 8.0 GiB usable (8.0 GiB box) · 64k leaves 2.2 GiB' && localWindowRoomWarning(linux, 65536) === undefined, String(localWindowRoomWarning(linux, 131072)))
  const skip = at(Math.round(4.7 * GIB), 8 * GIB, 6 * GIB, 'f16', { geometry: tiny })
  check('the suggestion is the biggest smaller rung that clears the floor, skipping a tight one: 256k (0.3 GiB) suggests 64k (1.0 GiB), not 128k (0.8 GiB)', skip.window === 262144 && localWindowRoomWarning(skip, 262144) === '256k leaves 0.3 GiB of 6.0 GiB usable (8.0 GiB box) · 64k leaves 1.0 GiB' && localWindowRoomWarning(skip, 131072) === '128k leaves 0.8 GiB of 6.0 GiB usable (8.0 GiB box) · 64k leaves 1.0 GiB' && localWindowRoomWarning(skip, 65536) === undefined, j([localWindowRoomWarning(skip, 262144), localWindowRoomWarning(skip, 131072)]))
  const none = at(Math.round(4.5 * GIB), 8 * GIB, 6 * GIB, 'q8_0')
  check('when no smaller rung leaves room it says so: a 4.5 GiB model at q8_0 — 64k leaves 0.4 GiB of 6.0 GiB usable (8.0 GiB box) · no smaller rung leaves room (32k leaves 0.97 GiB, under the floor)', localWindowRoomWarning(none, 65536) === '64k leaves 0.4 GiB of 6.0 GiB usable (8.0 GiB box) · no smaller rung leaves room' && none.usableBytes - none.ladder[0]!.totalBytes < GIB, String(localWindowRoomWarning(none, 65536)))
  const forty = at(Math.round(4.3 * GIB), 8 * GIB, 6 * GIB, 'f16', { trainedMax: 40960 })
  check('a 40k-trained model has the one rung 32k: max (40k) leaves 0.5 GiB · no smaller rung leaves room; 32k leaves 0.7 GiB · no smaller rung leaves room', localWindowRoomWarning(forty, 40960) === '40k leaves 0.5 GiB of 6.0 GiB usable (8.0 GiB box) · no smaller rung leaves room' && localWindowRoomWarning(forty, 32768) === '32k leaves 0.7 GiB of 6.0 GiB usable (8.0 GiB box) · no smaller rung leaves room', j([localWindowRoomWarning(forty, 40960), localWindowRoomWarning(forty, 32768)]))
  const measured = at(W4, 8 * GIB, 6 * GIB, 'f16', { measured: { bytes: 5 * GIB, window: 32768 } })
  check('the measured arm rides the room figure: measured 5.0 GiB at 32k, 64k fills the ceiling exactly (leaves 0.0 GiB) and 32k leaves exactly the 1.0 GiB floor, which clears it', localWindowRoomWarning(measured, 65536) === '64k leaves 0.0 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.0 GiB' && localWindowRoomWarning(measured, 32768) === undefined && measured.ladder[1]!.totalBytes === 6 * GIB, String(localWindowRoomWarning(measured, 65536)))
}

finish()

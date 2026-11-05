#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
if (argv.includes('--help')) {
  console.log(`measure-tensorfold-adapter-live — the TensorFold adapter end to end on this machine with the real llama.cpp binary and the real 2B GGUF
  --cache <dir>   the HF-hub cache the 2B GGUF is pulled into (default: a fresh directory under TMPDIR; 1.3 GB on the first run)
  --dist <dir>    a built dist directory (default: this tree's dist); runs the shipped shapes when present
  --out <file>    the JSON receipt (default: beside the cache)`)
  process.exit(0)
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.6' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const engine = await import('../../src/services/tensorfold/engine.ts')
const serve = await import('../../src/services/tensorfold/serve.ts')
const pull = await import('../../src/services/tensorfold/pull.ts')
const road = await import('../../src/commands/tensorfold/road.ts')
const models = await import('../../src/services/tensorfold/adapter/models.ts')
const adapterServe = await import('../../src/services/tensorfold/adapter/serve.ts')
const adapterLlama = await import('../../src/services/tensorfold/adapter/llama.ts')
const hfCache = await import('../../src/services/tensorfold/hfCache.ts')
const { probeTensorFold, refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localServerKind } = await import('../../src/constants/localPromptProfile.ts')
const { readRecord } = await import('../../src/services/projectServices/serviceManager.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function freePort(): Promise<number> {
  return new Promise((ok, no) => {
    const probe = createServer()
    probe.once('error', no)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => ok(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tf-adapter-live-'))
const cache = resolve(option('--cache') ?? join(scratch, 'hub'))
mkdirSync(cache, { recursive: true })
const out = resolve(option('--out') ?? join(cache, '..', 'adapter-live-receipt.json'))
const dist = resolve(option('--dist') ?? join(ROOT, 'dist'))
const QWEN_2B = models.QWEN_2B_GGUF
const ENTRY = engine.adapterEntry()
const receipt: Record<string, unknown> = { at: new Date().toISOString(), entry: ENTRY, cache }

console.log('§0 the llama.cpp binary Mercury has here, and the shipped shapes')
const llama = await adapterLlama.resolveLlamaServer()
check('a llama-server at b11829 or newer is found (the runtime folder first); the adapter child resolves the same way', llama.found, JSON.stringify(llama))
if (!llama.found) process.exit(1)
console.log(`  llama-server: ${llama.binary} · ${JSON.stringify({ version: llama.version, build: llama.build, commit: llama.commit, pinned: llama.pinned })}`)
receipt.llama = llama
const node = [join(ROOT, 'vendor', 'node', 'extracted', `${process.platform}-${process.arch}`, 'bin', 'node'), ...(process.env.PATH ?? '').split(':').map(dir => join(dir, 'node'))].find(path => existsSync(path))
if (node !== undefined && existsSync(join(dist, 'tensorfold-adapter.mjs')) && existsSync(join(dist, 'mercury.mjs'))) {
  const sibling = execFileSync(node, [join(dist, 'tensorfold-adapter.mjs'), '--version'], { encoding: 'utf8' }).trim()
  const fallback = execFileSync(node, [join(dist, 'mercury.mjs'), '--tensorfold-adapter', '--version'], { encoding: 'utf8' }).trim()
  check('the shipped shapes answer: node dist/tensorfold-adapter.mjs --version and node dist/mercury.mjs --tensorfold-adapter --version', sibling.startsWith('Mercury TensorFold adapter ') && fallback === sibling, `${sibling} | ${fallback}`)
  receipt.shipped = { node, sibling, fallback }
} else {
  console.log('  (no dist or node here: the shipped shapes were not run; bun run build.ts first)')
}

console.log('§1 the engine through the road: the adapter with the tell')
const found = await engine.findTensorFoldEngine({ adapter: true, exists: () => false })
check('findTensorFoldEngine with the adapter seam (his own binary hidden, as on a Windows box without one): servedBy mercury-llamacpp, backends cpu, llama.cpp found', found !== null && found.servedBy === 'mercury-llamacpp' && found.backends[0] === 'cpu' && found.capabilities.llamacpp?.found === true, JSON.stringify({ binary: found?.binary, servedBy: found?.servedBy, llama: found?.capabilities.llamacpp }))

console.log(`§2 pull the 2B GGUF into ${cache} (resumes and verifies when present)`)
const pulled: number[] = []
const pullBegun = Date.now()
await pull.pullTensorFold(QWEN_2B.repo, progress => pulled.push(progress.bytes), { binary: ENTRY, cacheRoot: cache, logDir: join(scratch, 'logs'), pollMs: 1_000, env: { ...process.env, HF_HUB_CACHE: cache } })
const onDisk = hfCache.ggufOnDisk(cache, QWEN_2B.gguf)
check(`the GGUF is whole in the HF-hub layout under the mapped repo (${(QWEN_2B.gguf.bytes / 1e9).toFixed(2)} GB, sha256 verified by the adapter) · ${((Date.now() - pullBegun) / 1000).toFixed(1)} s`, onDisk.complete && existsSync(hfCache.ggufPaths(cache, QWEN_2B.gguf).snapshotFile), JSON.stringify({ onDisk, pulled: pulled.slice(-2) }))
receipt.pull = { seconds: (Date.now() - pullBegun) / 1000, bytes: onDisk.bytes, samples: pulled.length }

console.log("§3 the CPU path: the adapter's own llama-server line on this binary, run once at verbosity 4 to read the memory breakdown")
{
  const port = await freePort()
  const args = [...adapterServe.llamaServerArgs(hfCache.ggufPaths(cache, QWEN_2B.gguf).snapshotFile, 'qwen3.5-2b', 8192, port, 1), '-lv', '4']
  const child = spawn(llama.binary, args, { env: adapterServe.childEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  child.stdout.on('data', chunk => { text += String(chunk) })
  child.stderr.on('data', chunk => { text += String(chunk) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !/listening on http/.test(text) && child.exitCode === null) await sleep(200)
  child.kill()
  await new Promise(resolve => child.once('exit', resolve))
  const breakdown = text.split('\n').filter(line => /memory_breakdown_print: \|   - /.test(line)).map(line => line.replace(/^.*\|   - /, '').replace(/\s+\|.*$/, '').trim())
  const rows = [...new Set(breakdown)]
  check('with --device none the model and context sit in CPU memory: the memory breakdown names Host and CPU rows only, no Metal (MTL0) row', rows.length > 0 && rows.every(row => /^(Host|CPU)/.test(row)) && !/MTL0|Metal/.test(breakdown.join(' ')), JSON.stringify(rows))
  receipt.memoryBreakdown = rows
  console.log(`  memory rows: ${rows.join(' · ')}`)
}

console.log('§4 serve through the road (a tensorfold project service running the adapter), the probe, two turns, a tool call, stop')
const cwd = join(scratch, 'project')
mkdirSync(cwd, { recursive: true })
const servedFile = join(scratch, 'served.json')
const port = await freePort()
const serveBegun = Date.now()
const env = { ...process.env, HF_HUB_CACHE: cache, MERCURY_LOCAL_PROBE_TARGETS: 'none' }
const served = await serve.startTensorFold({ repo: QWEN_2B.repo, window: 32_768, promptCacheGib: 1, port }, { binary: ENTRY, cwd, sessionId: 'adapter-live', env, serviceEnv: { HF_HUB_CACHE: cache }, servedFile, app: async () => ({ running: false }), onLoading: seconds => { if (seconds % 5 === 0) console.log(`  loading · ${seconds} s`) } })
const loadSeconds = (Date.now() - serveBegun) / 1000
check(`served on 127.0.0.1:${port} after ${loadSeconds.toFixed(1)} s; the service runs the adapter under process.execPath; the served record carries servedBy`, served.port === port && served.servedBy === 'mercury-llamacpp' && readRecord(cwd, 'tensorfold')?.spec.command === process.execPath, JSON.stringify(served))
const record = readRecord(cwd, 'tensorfold')
const childPid = Number(readFileSync(adapterServe.childPidFile(port), 'utf8').trim())
const root = `http://127.0.0.1:${port}`
const probe = await probeTensorFold(root, { timeoutMs: 3_000 })
check("the probe: TensorFold-shaped with the tell, label TensorFold adapter … (Mercury's engine), the served window", probe?.kind === 'tensorfold' && probe.engine?.servedBy === 'mercury-llamacpp' && probe.label.startsWith('TensorFold adapter ') && probe.models[0]?.contextWindow?.tokens === 32_768, JSON.stringify(probe))
const health = await fetch(`${root}/health`).then(r => r.json() as Promise<Record<string, unknown>>)
console.log(`  /health: ${JSON.stringify({ device: health.device, backend: health.backend, engine: (health.engine as Record<string, unknown>)?.words, active: (health.memory as { active: number })?.active })}`)
receipt.health = health
await refreshLocalDiscovery({ force: true, env: { ...env, MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=${root}` } })
check('the prompt profile sees llama.cpp underneath (localServerKind llamacpp)', localServerKind('local/qwen3.5-2b') === 'llamacpp', String(localServerKind('local/qwen3.5-2b')))
road.__resetTensorFoldRoadForTest()
const prove = { env: { ...env, MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=${root}` }, persist: () => ({ sentence: '' }), setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never }
const switched = await road.switchToTensorFold(served, { prove })
check("the switch through Mercury's own road (pickAndProve on the local lane): the prove turn answered and the session switched to local/qwen3.5-2b", switched.ok && switched.switched && switched.model === 'local/qwen3.5-2b', JSON.stringify(switched))
type Turn = { usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } }; tensorfold?: Record<string, number | string | boolean>; text: string }
const prompt = `${'Mercury is a coding agent for the terminal; it reads files, runs checks and edits code with care. '.repeat(24)}\nIn one short sentence, what does Mercury do?`
async function turn(): Promise<Turn> {
  const text = await fetch(`${root}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5-2b', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: prompt }], max_tokens: 48, reasoning_effort: 'none', temperature: 0 }) }).then(r => r.text())
  const chunks = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
  const last = chunks.find(chunk => chunk.usage !== undefined)
  return { ...(last !== undefined ? { usage: last.usage as Turn['usage'], tensorfold: last.tensorfold as Turn['tensorfold'] } : {}), text: chunks.map(chunk => ((chunk.choices as Array<{ delta?: { content?: string } }>)[0]?.delta?.content ?? '')).join('') }
}
const turn1 = await turn()
check("a streamed turn on the wire Mercury reads: a reply, the usage chunk with cached_tokens and the tensorfold runtime block (tok/s, first token, prefill)", turn1.text.trim() !== '' && turn1.usage !== undefined && turn1.tensorfold !== undefined && typeof turn1.tensorfold.tokens_per_second === 'number' && typeof turn1.tensorfold.time_to_first_token === 'number' && turn1.tensorfold.served_by === 'mercury-llamacpp', JSON.stringify(turn1))
const turn2 = await turn()
check('the same prefix again resumes from the prompt cache: cached_tokens > 0 and a shorter prefill', (turn2.usage?.prompt_tokens_details?.cached_tokens ?? 0) > 0 && turn2.usage !== undefined && turn2.tensorfold !== undefined && (turn2.tensorfold.prefill_seconds as number) < (turn1.tensorfold?.prefill_seconds as number), JSON.stringify(turn2))
for (const [name, row] of [['turn 1', turn1], ['turn 2', turn2]] as const) console.log(`  ${name}: ${row.usage?.prompt_tokens} in (${row.usage?.prompt_tokens_details?.cached_tokens ?? 0} cached) · ${row.usage?.completion_tokens} out · ~${Math.round(Number(row.tensorfold?.tokens_per_second))} tok/s · first token in ${Number(row.tensorfold?.time_to_first_token).toFixed(2)} s · prefill ${Number(row.tensorfold?.prefill_seconds).toFixed(2)} s · "${row.text.trim().slice(0, 80)}"`)
receipt.turns = [turn1, turn2]
const tools = await fetch(`${root}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5-2b', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Read the file notes.txt using the tool.' }], tools: [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }], max_tokens: 96, reasoning_effort: 'none', temperature: 0 }) }).then(r => r.text())
const toolChunks = tools.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
const toolCall = toolChunks.some(chunk => ((chunk.choices as Array<{ delta?: { tool_calls?: unknown[] } }>)[0]?.delta?.tool_calls?.length ?? 0) > 0)
const toolFinish = toolChunks.some(chunk => (chunk.choices as Array<{ finish_reason?: string }>)[0]?.finish_reason === 'tool_calls')
check('a declared tool is called as tool_calls (parsed by llama.cpp), finish_reason tool_calls, the usage block last', toolCall && toolFinish && toolChunks.some(chunk => chunk.usage !== undefined && chunk.tensorfold !== undefined), tools.slice(0, 500))
const log = record !== null ? readFileSync(record.logFile, 'utf8') : ''
check("the service log carries the child's lines as [llama.cpp] noise and the adapter's serving line naming Mercury's engine on the CPU", log.includes('[llama.cpp] ') && /serving qwen3\.5-2b at http:\/\/127\.0\.0\.1:\d+\/v1 \(Mercury's engine: llama\.cpp .* on the CPU; context: 32768; prompt cache: 1 GiB; loaded in/.test(log), log.split('\n').filter(line => /serving /.test(line)).join(' | '))
receipt.log = log.split('\n').filter(line => /serving |loaded in|model loaded/.test(line)).slice(0, 6)
await serve.stopTensorFold('qwen3.5-2b', { servedFile })
await sleep(500)
check('stop: the adapter and its llama-server child are gone, the port is free', !alive(served.pid) && !alive(childPid) && (await fetch(`${root}/health`, { signal: AbortSignal.timeout(500) }).then(() => false, () => true)), JSON.stringify({ adapter: alive(served.pid), child: alive(childPid) }))
receipt.load = { seconds: loadSeconds }
writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n')
console.log(`\nreceipt: ${out}`)
console.log(failures === 0 ? '\nmeasure-tensorfold-adapter-live: ALL GREEN' : `\nmeasure-tensorfold-adapter-live: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

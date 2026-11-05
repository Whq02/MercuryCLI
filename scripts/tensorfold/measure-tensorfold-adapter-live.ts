#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

console.log(`§2 pull the 2B GGUF into ${cache} (a download is sha256-verified by the adapter; a whole blob is a size-matched cache hit), then the drive re-hashes the blob itself`)
const hit = hfCache.ggufOnDisk(cache, QWEN_2B.gguf).complete
const pulled: number[] = []
const pullBegun = Date.now()
await pull.pullTensorFold(QWEN_2B.repo, progress => pulled.push(progress.bytes), { binary: ENTRY, cacheRoot: cache, logDir: join(scratch, 'logs'), pollMs: 1_000, env: { ...process.env, HF_HUB_CACHE: cache } })
const onDisk = hfCache.ggufOnDisk(cache, QWEN_2B.gguf)
check(`the GGUF is whole in the HF-hub layout under the mapped repo (${(QWEN_2B.gguf.bytes / 1e9).toFixed(2)} GB; ${hit ? 'a cache hit: the size matched the pin, nothing downloaded' : 'downloaded and sha256-verified by the adapter'}) · ${((Date.now() - pullBegun) / 1000).toFixed(1)} s`, onDisk.complete && existsSync(hfCache.ggufPaths(cache, QWEN_2B.gguf).snapshotFile), JSON.stringify({ onDisk, pulled: pulled.slice(-2) }))
const hashBegun = Date.now()
const digest = createHash('sha256')
for await (const chunk of createReadStream(hfCache.ggufPaths(cache, QWEN_2B.gguf).blob)) digest.update(chunk as Buffer)
const blobSha256 = digest.digest('hex')
check(`the drive's own sha256 of the blob equals the table's pin (${blobSha256.slice(0, 8)}…) · ${((Date.now() - hashBegun) / 1000).toFixed(1)} s`, blobSha256 === QWEN_2B.gguf.sha256, blobSha256)
receipt.pull = { seconds: (Date.now() - pullBegun) / 1000, bytes: onDisk.bytes, samples: pulled.length, hit, sha256: blobSha256 }

console.log('§2b models --json from the shipped shape against the real cache')
if (node !== undefined && existsSync(join(dist, 'tensorfold-adapter.mjs'))) {
  const text = execFileSync(node, [join(dist, 'tensorfold-adapter.mjs'), '--tensorfold-adapter', 'models', '--json'], { encoding: 'utf8', env: { ...process.env, HF_HUB_CACHE: cache } })
  const listed = JSON.parse(text) as { served_by?: string; cache?: string; models?: Array<{ repo: string; name: string; on_disk: boolean; bytes_on_disk: number; bytes: number; qualified: boolean; gguf: { repo: string; file: string; sha256: string } }> }
  const rows = listed.models ?? []
  const two = rows.find(row => row.repo === QWEN_2B.repo)
  check('models --json: the tell, the cache root, the three rows in rank order (4B · 2B · Lightning) each naming its GGUF repo, file and digest; the pulled 2B on disk with the pinned byte count; Lightning unqualified', listed.served_by === 'mercury-llamacpp' && listed.cache === cache && rows.map(row => row.name).join(' · ') === 'qwen3.5-4b · qwen3.5-2b · nemotron-lightning' && rows.every(row => row.gguf.repo.endsWith('-GGUF') && row.gguf.file.endsWith('.gguf') && /^[0-9a-f]{64}$/.test(row.gguf.sha256)) && two?.on_disk === true && two.bytes_on_disk === QWEN_2B.gguf.bytes && two.bytes === QWEN_2B.gguf.bytes && rows[2]?.qualified === false, text.slice(0, 600))
  receipt.models = rows.map(row => ({ name: row.name, on_disk: row.on_disk, bytes_on_disk: row.bytes_on_disk }))
} else {
  check('models --json from the shipped shape needs dist/tensorfold-adapter.mjs and a node runtime', false, 'bun run build.ts first')
}

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
const childPid = adapterServe.readChildPidFile(port)?.pid ?? 0
const root = `http://127.0.0.1:${port}`
const probe = await probeTensorFold(root, { timeoutMs: 3_000 })
check("the probe: TensorFold-shaped with the tell, label TensorFold adapter … (Mercury's engine), the served window", probe?.kind === 'tensorfold' && probe.engine?.servedBy === 'mercury-llamacpp' && probe.label.startsWith('TensorFold adapter ') && probe.models[0]?.contextWindow?.tokens === 32_768, JSON.stringify(probe))
const health = await fetch(`${root}/health`).then(r => r.json() as Promise<Record<string, unknown>>)
console.log(`  /health: ${JSON.stringify({ device: health.device, backend: health.backend, engine: (health.engine as Record<string, unknown>)?.words, active: (health.memory as { active: number })?.active })}`)
receipt.health = health
const probeEnv = { ...env, MERCURY_CONFIG_DIR: env.MERCURY_CONFIG_DIR, MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=${root}` }
await refreshLocalDiscovery({ force: true, env: probeEnv })
check('the prompt profile sees llama.cpp underneath (localServerKind llamacpp)', localServerKind('local/qwen3.5-2b') === 'llamacpp', String(localServerKind('local/qwen3.5-2b')))
road.__resetTensorFoldRoadForTest()
const prove = { env: probeEnv, persist: () => ({ sentence: '' }), setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never }
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

console.log('§5 the shipped shape against the real engine: node + dist/tensorfold-adapter.mjs serving the 2B, a streamed turn, SIGTERM')
if (node !== undefined && existsSync(join(dist, 'tensorfold-adapter.mjs'))) {
  const shippedPort = await freePort()
  const child = spawn(node, [join(dist, 'tensorfold-adapter.mjs'), '--tensorfold-adapter', 'serve', QWEN_2B.repo, '--name', 'qwen3.5-2b', '--context', '8192', '--prompt-cache-gib', '1', '--port', String(shippedPort)], { env: { ...process.env, HF_HUB_CACHE: cache, TF_DRAIN_S: '2' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines: string[] = []
  child.stdout.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)))
  child.stderr.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)))
  const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  const begun = Date.now()
  let ready = false
  while (Date.now() - begun < 120_000 && child.exitCode === null) {
    if ((await fetch(`http://127.0.0.1:${shippedPort}/health`, { signal: AbortSignal.timeout(1_000) }).then(r => r.status, () => 0)) === 200) {
      ready = true
      break
    }
    await sleep(250)
  }
  check(`node + dist serves the real 2B on the real llama-server (ready after ${((Date.now() - begun) / 1000).toFixed(1)} s)`, ready, lines.slice(-4).join(' | '))
  const shippedRoot = `http://127.0.0.1:${shippedPort}`
  const shippedProbe = await probeTensorFold(shippedRoot, { timeoutMs: 3_000 })
  const shippedTurn = await fetch(`${shippedRoot}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5-2b', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Say exactly: hello world' }], max_tokens: 16, reasoning_effort: 'none', temperature: 0 }) }).then(r => r.text())
  const shippedChunks = shippedTurn.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
  const shippedUsage = shippedChunks.find(chunk => chunk.usage !== undefined)
  check('the shipped shape: the probe reads the tell, a streamed turn answers with the usage chunk and the tensorfold block', shippedProbe?.engine?.servedBy === 'mercury-llamacpp' && shippedUsage !== undefined && (shippedUsage.tensorfold as Record<string, unknown>).served_by === 'mercury-llamacpp' && shippedChunks.map(chunk => ((chunk.choices as Array<{ delta?: { content?: string } }>)[0]?.delta?.content ?? '')).join('').toLowerCase().includes('hello'), shippedTurn.slice(0, 400))
  const shippedChild = adapterServe.readChildPidFile(shippedPort)?.pid ?? 0
  child.kill('SIGTERM')
  const code = await exit
  await sleep(300)
  check('SIGTERM under node: drained, exit 0, the llama-server child gone, the port free', code === 0 && lines.includes('shutting down: drained') && !alive(shippedChild) && (await fetch(`${shippedRoot}/health`, { signal: AbortSignal.timeout(500) }).then(() => false, () => true)), JSON.stringify({ code, child: alive(shippedChild), tail: lines.slice(-3) }))
  receipt.shippedServe = { node, lines: lines.filter(line => /serving |shutting/.test(line)) }
} else {
  check('the shipped shape serve leg needs dist/tensorfold-adapter.mjs and a node runtime', false, 'bun run build.ts first')
}

writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n')
console.log(`\nreceipt: ${out}`)
console.log(failures === 0 ? '\nmeasure-tensorfold-adapter-live: ALL GREEN' : `\nmeasure-tensorfold-adapter-live: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

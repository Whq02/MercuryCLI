#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { FAKE_BIN, FIXTURES, GIB, WIN_16, fakeWorld } from './fixtures/world.ts'
import { FAKE_LLAMA_REPLY, FAKE_LLAMA_TIMINGS } from './fixtures/fake-llama-server.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.6' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const identity = await import('../../src/services/tensorfold/adapter/identity.ts')
const models = await import('../../src/services/tensorfold/adapter/models.ts')
const adapterMain = await import('../../src/services/tensorfold/adapter/main.ts')
const adapterServe = await import('../../src/services/tensorfold/adapter/serve.ts')
const adapterPull = await import('../../src/services/tensorfold/adapter/pull.ts')
const adapterLlama = await import('../../src/services/tensorfold/adapter/llama.ts')
const hfCache = await import('../../src/services/tensorfold/hfCache.ts')
const engine = await import('../../src/services/tensorfold/engine.ts')
const serve = await import('../../src/services/tensorfold/serve.ts')
const refusal = await import('../../src/services/tensorfold/refusal.ts')
const inventory = await import('../../src/services/tensorfold/inventory.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')
const { probeTensorFold, refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localServerKind } = await import('../../src/constants/localPromptProfile.ts')
const health = await import('../../src/services/providers/local/tensorfoldHealth.ts')
const support = await import('../../src/services/providers/local/tensorfoldSupport.ts')
const { readRecord } = await import('../../src/services/projectServices/serviceManager.ts')
const { adapterFitsMachine, tensorFoldCapableMachine } = await import('../../src/components/tensorfold/tensorfoldFacts.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}
async function until(read: () => Promise<boolean>, ms: number, step = 100): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await read()) return true
    await sleep(step)
  }
  return read()
}
const status = async (url: string): Promise<number> => fetch(url, { signal: AbortSignal.timeout(1_500) }).then(r => r.status, () => 0)
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const ENTRY = engine.adapterEntry()
const ROOT = join(FIXTURES, '..', '..', '..')
const CHILD_VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const DIST_ENTRY = join(ROOT, 'dist', 'tensorfold-adapter.mjs')
const NODE = [join(ROOT, 'vendor', 'node', 'extracted', `${process.platform}-${process.arch}`, 'bin', 'node'), ...(process.env.PATH ?? '').split(':').map(dir => join(dir, 'node'))].find(path => path !== '' && existsSync(path))
if (!existsSync(DIST_ENTRY) || NODE === undefined) {
  console.log(`  [FAIL] ${existsSync(DIST_ENTRY) ? 'no node runtime found (vendor/node or PATH)' : 'dist/tensorfold-adapter.mjs missing — run bun run build.ts first'}; the serve legs run the shipped shape (node + dist/tensorfold-adapter.mjs)`)
  process.exit(1)
}
console.log(`the adapter processes run as the shipped shape: ${NODE} ${DIST_ENTRY} --tensorfold-adapter …`)
const FAKE_LLAMA_SCRIPT = join(FIXTURES, 'fake-llama-server.ts')
const QWEN_2B = models.QWEN_2B_GGUF
const QWEN_4B = models.QWEN_4B_GGUF

function worldWithLlama(prefix: string, opts: { pinned?: boolean; gguf?: boolean; env?: Record<string, string> } = {}): ReturnType<typeof fakeWorld> & { runtimeBin: string; llamaLog: string } {
  const world = fakeWorld(prefix, { seeds: [], ggufSeeds: opts.gguf === false ? [] : [QWEN_2B.gguf], env: { FAKE_LLAMA_SCRIPT, FAKE_LLAMA_LOG: '', FAKE_TENSORFOLD_BUN: NODE!, ...opts.env } })
  const runtimeBin = adapterLlama.llamaRuntimeBin(world.home)
  mkdirSync(runtimeBin, { recursive: true })
  if (opts.pinned !== false) copyFileSync(join(FAKE_BIN, 'llama-server'), join(runtimeBin, 'llama-server'))
  const llamaLog = join(world.root, 'llama.log')
  world.env.FAKE_LLAMA_LOG = llamaLog
  world.serviceEnv.FAKE_LLAMA_LOG = llamaLog
  world.serviceEnv.FAKE_LLAMA_SCRIPT = FAKE_LLAMA_SCRIPT
  world.serviceEnv.FAKE_TENSORFOLD_BUN = NODE!
  return { ...world, runtimeBin, llamaLog }
}

type Child = { pid: number; lines: string[]; exit: Promise<{ code: number | null; signal: string | null }>; kill: (signal?: NodeJS.Signals) => void }
function adapterProcess(args: string[], env: NodeJS.ProcessEnv): Child {
  const child = spawn(NODE!, [DIST_ENTRY, identity.ADAPTER_FLAG, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines: string[] = []
  const take = (chunk: Buffer): void => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim() !== '') lines.push(line.trim())
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { pid: child.pid!, lines, exit, kill: signal => child.kill(signal) }
}

section('the verbs in-process: --version, capabilities --json (the tell, llama.cpp pinned in the runtime folder), models --json')
{
  const world = worldWithLlama('tf-adapter-verbs')
  const out: string[] = []
  const err: string[] = []
  const io = { env: world.env, home: world.home, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) }
  check('--version names Mercury and the adapter, never a TensorFold version', (await adapterMain.runTensorFoldAdapter(['--version'], io)) === 0 && out[0] === 'Mercury TensorFold adapter 1.0.6\n' && engine.parseTensorFoldVersion(out[0]) === '1.0.6', JSON.stringify(out))
  out.length = 0
  const code = await adapterMain.runTensorFoldAdapter(['capabilities', '--json'], io)
  const caps = JSON.parse(out[0] ?? '{}') as Record<string, unknown>
  const llama = caps.llamacpp as Record<string, unknown>
  check('capabilities --json: engine and served_by mercury-llamacpp, the CPU backend, the table families, the serve flags the road passes, llama.cpp found in the runtime folder (pinned) at build 11829', code === 0 && caps.served_by === 'mercury-llamacpp' && caps.engine === 'mercury-llamacpp' && (caps.backends as string[])[0] === 'cpu' && JSON.stringify(caps.families) === JSON.stringify({ qwen3_5: ['gguf-q4_k_m'], nemotron_h: ['gguf-ud-q4_k_m'] }) && ['--name', '--context', '--port', '--prompt-cache-gib', '--host', '--api-key-file', '--drafter'].every(flag => flag in (caps.serve as { flags: Record<string, unknown> }).flags) && llama.found === true && llama.pinned === true && llama.build === '11829' && llama.words === 'llama.cpp b11829' && err.length === 0, JSON.stringify(caps))
  const parsed = engine.parseTensorFoldCapabilities(out[0]!)
  check('the road parses it: servedBy and the llamacpp facts ride the capabilities', parsed?.servedBy === 'mercury-llamacpp' && parsed.llamacpp?.found === true && parsed.llamacpp.build === '11829' && parsed.llamacpp.words === 'llama.cpp b11829', JSON.stringify(parsed))
  out.length = 0
  await adapterMain.runTensorFoldAdapter(['models', '--json'], io)
  const listed = JSON.parse(out[0] ?? '{}') as { models: Array<{ repo: string; name: string; on_disk: boolean; bytes: number; gguf: { repo: string; sha256: string } }> }
  check('models --json: the table in rank order (4B, 2B, Lightning), the 2B on disk from the GGUF cache, the GGUF source and its pinned digest on every row', listed.models.map(row => row.name).join(',') === 'qwen3.5-4b,qwen3.5-2b,nemotron-lightning' && listed.models[1]!.on_disk && !listed.models[0]!.on_disk && listed.models[0]!.gguf.repo === 'unsloth/Qwen3.5-4B-GGUF' && listed.models[0]!.gguf.sha256.length === 64 && listed.models[0]!.bytes === 2_740_937_888, JSON.stringify(listed))
  out.length = 0
  err.length = 0
  check('an unknown verb is a usage error (exit 2)', (await adapterMain.runTensorFoldAdapter(['frobnicate'], io)) === 2 && err[0]!.startsWith('usage:'))
  const bare = worldWithLlama('tf-adapter-nollama', { pinned: false, env: { PATH: '/usr/bin:/bin' } })
  out.length = 0
  err.length = 0
  await adapterMain.runTensorFoldAdapter(['capabilities', '--json'], { ...io, env: bare.env, home: bare.home })
  const none = JSON.parse(out[0] ?? '{}') as { llamacpp: { found: boolean; runtime: string } }
  check('without llama.cpp anywhere: found false, the runtime folder named, a warning on stderr that /tensorfold installs release b11829', !none.llamacpp.found && none.llamacpp.runtime === bare.runtimeBin && err[0] === `warning: llama.cpp is not installed; /tensorfold installs release b11829 into ${bare.runtimeBin}\n`, JSON.stringify({ none, err }))
  const old = worldWithLlama('tf-adapter-oldllama', { pinned: false })
  const oldBin = join(old.root, 'old-bin')
  mkdirSync(oldBin, { recursive: true })
  writeFileSync(join(oldBin, 'llama-server'), '#!/bin/sh\necho "version: 0.5.0 (build 11146, commit abcdef0)" >&2\n', { mode: 0o755 })
  const resolved = await adapterLlama.resolveLlamaServer({ env: { ...old.env, PATH: `${oldBin}:/usr/bin:/bin` }, home: old.home, platform: 'darwin' })
  check('a llama-server on PATH older than b11829 is refused by name and build; the runtime folder is the pinned road', !resolved.found && resolved.refused === `${join(oldBin, 'llama-server')} is build 11146; Mercury's engine needs llama.cpp b11829 or newer`, JSON.stringify(resolved))
  const onPath = await adapterLlama.resolveLlamaServer({ env: { ...old.env, PATH: `${FAKE_BIN}:/usr/bin:/bin` }, home: old.home, platform: 'darwin' })
  check('a llama-server on PATH at b11829 or newer is accepted, marked unpinned', onPath.found && !onPath.pinned && onPath.build === '11829', JSON.stringify(onPath))
}

section('the admission and the refusal lines in his grammar, read by refusal.ts')
{
  const fit = adapterServe.admission(QWEN_4B, 262_144, 1, 16 * GIB)
  check("the 4B at 256k on 16 GiB: 13.6 GiB needed past the 11.2 GiB limit; the line names the KV at the window and what is left under the load limit, and refusal.ts reads it as a memory refusal with 128k as the next window", fit.line === 'qwen3_5: one stream at a 262144-token window takes 8.00 GiB, more than the 5.65 GiB left under the load limit; lower --context' && (fit.needBytes / GIB).toFixed(1) === '13.6', JSON.stringify(fit))
  const read = refusal.readTensorFoldRefusal(`tensorfold-adapter: ${fit.line}`, { window: 262_144, ladder: (await import('../../src/services/tensorfold/fit.ts')).tensorFoldLadder(QWEN_4B, WIN_16) })
  check('refusal.ts: kind memory, the GiB figures, the next window 128k whose cache fits what is left, the adapter prefix stripped', read.kind === 'memory' && read.needGib === 8 && read.leftGib === 5.65 && read.nextWindow === 131_072 && read.line === fit.line, JSON.stringify(read))
  check('the 4B at 128k fits on 16 GiB (9.6 GiB)', adapterServe.admission(QWEN_4B, 131_072, 1, 16 * GIB).line === undefined && (adapterServe.admission(QWEN_4B, 131_072, 1, 16 * GIB).needBytes / GIB).toFixed(1) === '9.6')
  const port = refusal.readTensorFoldRefusal('tensorfold-adapter: cannot listen on 127.0.0.1:8080 (AddressInUse)', {})
  const notPulled = refusal.readTensorFoldRefusal(`tensorfold-adapter: ${QWEN_4B.repo} is not in the Hugging Face cache; the engine does not download: run tensorfold pull ${QWEN_4B.repo} first`, {})
  const family = refusal.readTensorFoldRefusal("tensorfold-adapter: no backend for someone/Other-MLX on Mercury's engine; it serves a, b", {})
  check('port in use → kind port with the port; not pulled → kind not-pulled; an unknown model → kind family', port.kind === 'port' && port.port === 8080 && notPulled.kind === 'not-pulled' && family.kind === 'family', JSON.stringify([port, notPulled, family]))
  check('child lines pass through as [llama.cpp] noise the last-line reader skips', refusal.lastStderrLine('tensorfold-adapter: llama.cpp exited 1 · failed\n[llama.cpp] srv  main: bye\n') === 'tensorfold-adapter: llama.cpp exited 1 · failed')
  const translated = adapterServe.translateRequest({ model: 'x', messages: [], reasoning_effort: 'low', thinking_budget: 512, chat_template_kwargs: { keep: true }, stream_options: { include_usage: true } })
  check("Mercury's wire to the child: reasoning_effort low stays, thinking_budget becomes thinking_budget_tokens, enable_thinking true merged into the client's chat_template_kwargs", translated.body.reasoning_effort === 'low' && translated.body.thinking_budget_tokens === 512 && translated.body.thinking_budget === undefined && JSON.stringify(translated.body.chat_template_kwargs) === '{"keep":true,"enable_thinking":true}' && translated.thinking === true, JSON.stringify(translated.body))
  const off = adapterServe.translateRequest({ reasoning_effort: 'none', thinking_budget: 64 })
  check('reasoning_effort none: enable_thinking false, no reasoning_effort and no budget sent', JSON.stringify(off.body) === '{"chat_template_kwargs":{"enable_thinking":false}}' && off.thinking === false, JSON.stringify(off.body))
  const chunk = adapterServe.translateReply({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 }, timings: FAKE_LLAMA_TIMINGS }, { llama: { build: '11829', commit: '184f653' }, effort: 'low', thinking: true })
  const block = chunk.tensorfold as Record<string, unknown>
  check("the usage chunk gains the tensorfold block from llama.cpp's timings (tok/s, first token, prefill, seconds), cached_tokens from cache_n, served_by, the engine words; timings are dropped", block.tokens_per_second === FAKE_LLAMA_TIMINGS.predicted_per_second && block.time_to_first_token === 0.2105 && block.prefill_seconds === 0.2105 && block.seconds === 0.0482 && block.served_by === 'mercury-llamacpp' && block.engine === 'llama.cpp b11829' && block.reasoning_effort === 'low' && block.enable_thinking === true && (chunk.usage as { prompt_tokens_details: { cached_tokens: number } }).prompt_tokens_details.cached_tokens === 12 && chunk.timings === undefined, JSON.stringify(chunk))
  const env = adapterServe.childEnv({ PATH: '/x', LLAMA_ARG_API_KEY: 'secret', LLAMA_API_KEY: 'secret', LLAMA_ARG_CTX_SIZE: '1' })
  check('the child never inherits LLAMA_ARG_* or LLAMA_API_KEY; colours off', env.LLAMA_ARG_API_KEY === undefined && env.LLAMA_API_KEY === undefined && env.LLAMA_ARG_CTX_SIZE === undefined && env.PATH === '/x' && env.LLAMA_LOG_COLORS === '0')
  check('the llama-server line: the GGUF, the alias, loopback, the window, one slot, jinja, flash attention, f16 KV, no GPU device, --cache-ram from the prompt cache in MiB, no web UI', adapterServe.llamaServerArgs('/m.gguf', 'qwen3.5-4b', 131_072, 40001, 1).join(' ') === '--model /m.gguf --alias qwen3.5-4b --host 127.0.0.1 --port 40001 --ctx-size 131072 --parallel 1 --jinja --flash-attn on --cache-type-k f16 --cache-type-v f16 --device none --cache-ram 1024 --no-webui')
  check("parseServeArgs reads the road's serve line; --drafter is kept for the refusal; an unknown flag is a usage error", JSON.stringify(adapterServe.parseServeArgs([QWEN_2B.repo, '--name', 'qwen3.5-2b', '--context', '262144', '--prompt-cache-gib', '1', '--port', '8080'])) === JSON.stringify({ repo: QWEN_2B.repo, window: 262_144, port: 8080, host: '127.0.0.1', promptCacheGib: 1, name: 'qwen3.5-2b' }) && (() => { try { adapterServe.parseServeArgs([QWEN_2B.repo, '--bogus', '1']); return false } catch (error) { return (error as { code: number }).code === 2 } })())
  const keyed = join(fakeWorld('tf-adapter-key').home, 'api-key')
  writeFileSync(keyed, '# a comment\nmercury[inference]: KEY-ONE\nbare-key\n')
  check('a key file in his name[scope]: KEY form reads its keys; comments skipped', JSON.stringify(adapterServe.readKeyFile(keyed)) === '["KEY-ONE","bare-key"]')
  check('STATUS_DLL_NOT_FOUND after an install names the Visual C++ runtime; exit 0 is fine; another exit is named', adapterLlama.llamaServerStartsOutcome(3221225781, 'win32') === adapterLlama.VC_REDIST_WORDS && adapterLlama.llamaServerStartsOutcome(0, 'win32') === undefined && adapterLlama.llamaServerStartsOutcome(1, 'darwin') === 'llama-server --version exited 1')
  const kib = 1234567 * 1024
  check("tasklist's quoted CSV memory cell is read whatever the locale: en-US 1,234,567 K · de-DE 1.234.567 K · fr-FR 1\u202f234\u202f567 Ko · a trailing newline", adapterServe.tasklistMemoryBytes('"llama-server.exe","1234","Console","1","1,234,567 K"\r\n') === kib && adapterServe.tasklistMemoryBytes('"llama-server.exe","1234","Console","1","1.234.567 K"') === kib && adapterServe.tasklistMemoryBytes('"llama-server.exe","1234","Console","1","1\u202f234\u202f567 Ko"\n') === kib && adapterServe.tasklistMemoryBytes('INFO: No tasks are running which match the specified criteria.') === undefined, String(adapterServe.tasklistMemoryBytes('"llama-server.exe","1234","Console","1","1,234,567 K"')))
  check("a Windows x64 machine is capable only when the 2B fits at the 64k floor: 8 GiB yes (4.9 GiB under 70% of 8), 4 GiB no", adapterFitsMachine(8 * GIB) && !adapterFitsMachine(4 * GIB) && tensorFoldCapableMachine('win32', 'x64', () => undefined, 8 * GIB) && !tensorFoldCapableMachine('win32', 'x64', () => undefined, 4 * GIB) && !tensorFoldCapableMachine('win32', 'arm64', () => undefined, 32 * GIB))
  const who = scene.FEED
  check("the feed's error lines name Mercury's engine on the adapter and TensorFold otherwise", who.exited('qwen3.5-4b', 8080, 'mercury-llamacpp') === "▲ Mercury's engine exited · qwen3.5-4b on 127.0.0.1:8080 · /tensorfold starts it again · c copies the support line" && who.exited('qwen3.5-4b', 8080).startsWith('▲ TensorFold exited') && who.portBusy(8080, 'mercury-llamacpp').startsWith("▲ Mercury's engine could not listen on 127.0.0.1:8080") && who.pullFailed('Qwen3.5 4B', 'x', 'mercury-llamacpp').startsWith("▲ Mercury's engine could not pull Qwen3.5 4B · x") && who.tight(2 * GIB, GIB, [], 'mercury-llamacpp').startsWith("▲ Mercury's engine needs 2.0 GiB · 1.0 GiB free") && who.refused('qwen3.5-4b', 131_072, { kind: 'memory', line: 'l', needGib: 8, leftGib: 5.65 }, 'mercury-llamacpp') === "▲ Mercury's engine refused qwen3.5-4b at 128k (needs 8.0 GiB, 5.7 GiB left) · /tensorfold · c copies the support line", who.refused('qwen3.5-4b', 131_072, { kind: 'memory', line: 'l', needGib: 8, leftGib: 5.65 }, 'mercury-llamacpp'))
}

section('serve against the fake llama-server: 503 while loading, the TensorFold-shaped API with the tell, the stream and the usage block, the keyed mode, the client abort, the stop')
{
  const world = worldWithLlama('tf-adapter-serve', { env: { FAKE_LLAMA_LOAD_MS: '1500' } })
  const port = await freePort()
  const child = adapterProcess(['serve', QWEN_2B.repo, '--name', 'qwen3.5-2b', '--context', '32768', '--prompt-cache-gib', '1', '--port', String(port)], { ...world.env, HOME: world.home, TF_DRAIN_S: '2' })
  const root = `http://127.0.0.1:${port}`
  const loading = await until(async () => (await status(`${root}/health`)) !== 0, 8_000, 50)
  const health503 = await fetch(`${root}/health`).then(r => r.json() as Promise<{ status: string; served_by: string }>)
  const models503 = await status(`${root}/v1/models`)
  check('the port opens at once and answers 503 loading on /health (readiness waits for 200) and on /v1/models (discovery never lists an unready model); the tell rides even the loading answer', loading && health503.status === 'loading' && health503.served_by === 'mercury-llamacpp' && models503 === 503, JSON.stringify({ health503, models503 }))
  const ready = await until(async () => (await status(`${root}/health`)) === 200, 15_000)
  check('ready when the child answers', ready, child.lines.join(' | '))
  const healthBody = await fetch(`${root}/health`).then(r => r.json() as Promise<Record<string, unknown>>)
  const engineFacts = healthBody.engine as Record<string, unknown>
  check("/health: his open shape (model, model_ids, memory.active from the child's RSS, live, version, backend cpu, device) plus served_by and the engine's name, build, commit and words", healthBody.status === 'ok' && healthBody.model === 'qwen3.5-2b' && JSON.stringify(healthBody.model_ids) === '["qwen3.5-2b"]' && (healthBody.memory as { active: number }).active > 0 && healthBody.backend === 'cpu' && typeof healthBody.device === 'string' && healthBody.version === CHILD_VERSION && healthBody.served_by === 'mercury-llamacpp' && engineFacts.name === 'llama.cpp' && engineFacts.build === '11829' && engineFacts.words === 'llama.cpp b11829' && engineFacts.binary === join(world.runtimeBin, 'llama-server'), JSON.stringify(healthBody))
  const list = await fetch(`${root}/v1/models`).then(r => r.json() as Promise<{ data: Array<Record<string, unknown>> }>)
  check("/v1/models: owned_by tensorfold (the road's identity), served_by mercury-llamacpp (the tell), the served window from the child's /props, the reasoning block with his efforts", list.data.length === 1 && list.data[0]!.id === 'qwen3.5-2b' && list.data[0]!.owned_by === 'tensorfold' && list.data[0]!.served_by === 'mercury-llamacpp' && list.data[0]!.context_length === 32_768 && JSON.stringify((list.data[0]!.reasoning as { supported_efforts: string[] }).supported_efforts) === '["max","xhigh","high","medium","low","minimal","none"]' && (list.data[0]!.reasoning as { default_enabled: boolean }).default_enabled === true, JSON.stringify(list))
  const memory = await fetch(`${root}/memory`).then(r => r.json() as Promise<Record<string, unknown>>)
  check('/memory: the window, the footprint, the tell', memory.context_window === 32_768 && (memory.process as { physical_footprint_bytes: number }).physical_footprint_bytes > 0 && memory.served_by === 'mercury-llamacpp', JSON.stringify(memory))
  const serverHeader = await fetch(`${root}/health`).then(r => r.headers.get('server'))
  check('the Server header names the adapter, never TensorFold', serverHeader === `Mercury-TensorFold-adapter/${CHILD_VERSION}`, String(serverHeader))
  const streamed = await fetch(`${root}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5-2b', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low', thinking_budget: 256, chat_template_kwargs: { keep: 1 } }) }).then(r => r.text())
  const chunks = streamed.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
  const usageChunks = chunks.filter(chunk => chunk.usage !== undefined)
  const finish = chunks.find(chunk => (chunk.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason === 'stop')
  const usageBlock = usageChunks[0]?.tensorfold as Record<string, unknown> | undefined
  check("a streamed turn: the content deltas and the finish chunk pass through, ONE choices: [] usage chunk (his shape, never doubled) carrying cached_tokens and the tensorfold runtime block, then [DONE]", streamed.trimEnd().endsWith('data: [DONE]') && finish !== undefined && usageChunks.length === 1 && JSON.stringify(usageChunks[0]!.choices) === '[]' && (usageChunks[0]!.usage as { prompt_tokens_details: { cached_tokens: number } }).prompt_tokens_details.cached_tokens === 12 && usageBlock?.tokens_per_second === FAKE_LLAMA_TIMINGS.predicted_per_second && usageBlock.served_by === 'mercury-llamacpp' && usageBlock.reasoning_effort === 'low' && usageChunks[0]!.timings === undefined && chunks.map(chunk => ((chunk.choices as Array<{ delta?: { content?: string } }>)[0]?.delta?.content ?? '')).join('').trim() === FAKE_LLAMA_REPLY, streamed.slice(0, 600))
  const seen = readFileSync(world.llamaLog, 'utf8')
  const request = seen.split('\n').filter(line => line.startsWith('request ')).map(line => JSON.parse(line.slice(8)) as Record<string, unknown>)
  check("the child saw the translated request: enable_thinking true merged beside the client's kwargs, thinking_budget_tokens 256, reasoning_effort low, no thinking_budget", request.length === 1 && JSON.stringify(request[0]!.chat_template_kwargs) === '{"keep":1,"enable_thinking":true}' && request[0]!.thinking_budget_tokens === 256 && request[0]!.reasoning_effort === 'low' && request[0]!.thinking_budget === undefined, JSON.stringify(request))
  check('the child was spawned with the pinned flags and without LLAMA_ARG_* in its environment (only the colour switch)', seen.includes('"--device","none"') && seen.includes('"--cache-ram","1024"') && seen.includes('"--ctx-size","32768"') && seen.includes('env ["LLAMA_LOG_COLORS"]'), seen.split('\n').slice(0, 2).join(' | '))
  const plain = await fetch(`${root}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5-2b', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none' }) }).then(r => r.json() as Promise<Record<string, unknown>>)
  check('a non-streamed turn gets the same usage details and tensorfold block', (plain.choices as Array<{ message: { content: string } }>)[0]!.message.content === FAKE_LLAMA_REPLY && (plain.tensorfold as Record<string, unknown>).enable_thinking === false && (plain.usage as { prompt_tokens_details: { cached_tokens: number } }).prompt_tokens_details.cached_tokens === 12 && plain.timings === undefined, JSON.stringify(plain))
  const missing = await status(`${root}/props`)
  check("/props and other llama.cpp paths are not exposed (the adapter is TensorFold-shaped, so probeLlamaCpp never claims it)", missing === 404)
  const probe = await probeTensorFold(root, { timeoutMs: 2_000 })
  check("Mercury's probe reads it as TensorFold-shaped with the tell: kind tensorfold, label TensorFold adapter 1.0.6 (Mercury's engine), engine.servedBy and the engine words, the model's servedBy", probe?.kind === 'tensorfold' && probe.label === `TensorFold adapter ${CHILD_VERSION} (Mercury's engine)` && probe.engine?.servedBy === 'mercury-llamacpp' && probe.engine.engineWords === 'llama.cpp b11829' && probe.engine.backend === 'cpu' && probe.models[0]?.servedBy === 'mercury-llamacpp' && probe.models[0].contextWindow?.tokens === 32_768, JSON.stringify(probe))
  await refreshLocalDiscovery({ force: true, env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=${root}` } })
  check("the prompt profile sees the engine underneath: localServerKind is llamacpp for the adapter's model (one call per message; declared tools only)", localServerKind('local/qwen3.5-2b') === 'llamacpp', String(localServerKind('local/qwen3.5-2b')))
  const snapshot = { probedAtMs: Date.now(), targetCount: 1, servers: [probe!] }
  const state = await (await import('../../src/services/providers/local/tensorfoldState.ts')).readTensorFoldState({ engine: async () => null, served: () => [], snapshot: async () => snapshot, hosts: () => [], app: async () => ({ running: false }), helper: () => ({ enabled: false }), exited: async () => undefined })
  const row = health.tensorFoldHealthRow(state)
  check("/health's TensorFold row says who serves: the adapter and llama.cpp b11829, CPU, the chip, and ends with the full sentence", row?.status === 'ok' && row.evidence.includes(`TensorFold adapter ${CHILD_VERSION} (Mercury's engine) · llama.cpp b11829 · CPU`) && row.evidence.endsWith(`${identity.ADAPTER_SENTENCE} · started outside Mercury`), JSON.stringify(row))
  const line = await support.readTensorFoldSupportLine({ repo: QWEN_2B.repo, context: 32_768, promptCacheGib: 1 }, undefined, state)
  check("the support line: the adapter's identity, llama.cpp b11829, CPU, the GGUF actually loaded (never the MLX id), the serve flags, Mercury's version, the full sentence last", line !== undefined && line.startsWith(`TensorFold adapter ${CHILD_VERSION} (Mercury's engine) · llama.cpp b11829 · CPU · `) && line.includes(' · unsloth/Qwen3.5-2B-GGUF · Qwen3.5-2B-Q4_K_M.gguf (Q4_K_M) @f6d5376 · --context 32768 --prompt-cache-gib 1 · Mercury 1.0.6 · ') && line.endsWith(identity.ADAPTER_SENTENCE) && !line.includes('MLX'), String(line))
  const adapterEngine = { version: CHILD_VERSION, binary: ENTRY, chip: 'Intel i7-4720HQ', backends: ['cpu'], families: [], servedBy: 'mercury-llamacpp', capabilities: { llamacpp: { found: true, build: '11829' } }, warnings: [] }
  const native = { kind: 'tensorfold' as const, root: 'http://127.0.0.1:8089', baseUrl: 'http://127.0.0.1:8089/v1', label: 'TensorFold 1.2.2', version: '1.2.2', models: [{ id: 'qwen3.5-2b', server: 'tensorfold' as const, baseUrl: 'http://127.0.0.1:8089/v1', contextWindow: { tokens: 32_768, source: 'served' as const }, thinkingDeclared: true, efforts: [], loaded: true }], engine: { keyed: false, backend: 'cpu', device: 'Intel64 Family 6 Model 60', inUseBytes: 2_040_109_465, streams: 8 } }
  const outsideState = await (await import('../../src/services/providers/local/tensorfoldState.ts')).readTensorFoldState({ engine: async () => adapterEngine as never, served: () => [], snapshot: async () => ({ probedAtMs: Date.now(), targetCount: 1, servers: [native as never] }), hosts: () => [], app: async () => ({ running: false }), helper: () => ({ enabled: false }), exited: async () => undefined })
  const outsideLine = await support.readTensorFoldSupportLine(undefined, undefined, outsideState)
  check("RED on the base — his engine served beside the adapter keeps its own identity on the support line: TensorFold 1.2.2 · CPU, never the adapter's name or llama.cpp's build (FRC2W: the box read 'TensorFold adapter 1.2.2 (Mercury's engine) · llama.cpp b11829' for a server that was TensorFold itself)", outsideLine !== undefined && outsideLine.startsWith('TensorFold 1.2.2 · CPU · ') && !outsideLine.includes('adapter') && !outsideLine.includes('llama.cpp') && outsideLine.includes(' · qwen3.5-2b · --context 32768 · '), outsideLine)
  const outsideRow = health.tensorFoldHealthRow(outsideState)
  check("/health's row for his engine beside the adapter names TensorFold 1.2.2, not the adapter", outsideRow?.status === 'ok' && !outsideRow.evidence.includes('adapter') && !outsideRow.evidence.includes('llama.cpp'), JSON.stringify(outsideRow))
  const typedPanel = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: WIN_16, engine: null, env: world.env, home: world.home, servedFile: join(world.home, 'nothing-served.json'), platform: 'win32', hosts: () => [{ name: '127.0.0.1', baseUrl: root, origin: 'typed' }], localModels: () => probe!.models, app: async () => undefined } as never)
  const typedHost = typedPanel.hosts[0]
  check("RED on the base — /tensorfold's own facts: a remembered host whose address discovery answers carries the live facts — the model served, the window, the version, who serves it — and the same server is not listed twice as an outside one (FRC2W-U-32: a typed host stored no serving and nothing filled it)", typedPanel.hosts.length === 1 && typedHost?.serving === 'qwen3.5-2b' && typedHost.window === 32_768 && typedHost.servedBy === 'mercury-llamacpp' && typedHost.version !== undefined && typedHost.origin === 'typed' && !typedPanel.outside.some(server => server.port === Number(new URL(root).port)), JSON.stringify({ hosts: typedPanel.hosts, outside: typedPanel.outside }))
  const typedRoad = readFileSync(join(ROOT, 'src', 'commands', 'tensorfold', 'tensorfold.tsx'), 'utf8')
  check("a typed loopback address is remembered as a port on this machine (an outside server under TENSORFOLD) and a legacy host record for it forgotten, a typed network address is a host, and discovery is refreshed before the panel re-reads", /case 'address'[\s\S]{0,900}rememberTensorFoldPort\(port\)[\s\S]{0,300}forgetTensorFoldHost\(host\.name\)[\s\S]{0,600}rememberTensorFoldHost\(\{ name: address\.replace[\s\S]{0,600}refreshLocalDiscovery\(\{ force: true \}\)[\s\S]{0,120}doors\.read/.test(typedRoad) && typedRoad.includes('a server on this machine appears under ${W.group} when it answers'))
  const slow = worldWithLlama('tf-adapter-slow', { env: { FAKE_LLAMA_SLOW_MS: '400' } })
  const slowPort = await freePort()
  const slowChild = adapterProcess(['serve', QWEN_2B.repo, '--name', 'qwen3.5-2b', '--context', '4096', '--port', String(slowPort)], { ...slow.env, HOME: slow.home, TF_DRAIN_S: '1' })
  await until(async () => (await status(`http://127.0.0.1:${slowPort}/health`)) === 200, 15_000)
  const controller = new AbortController()
  const aborted = fetch(`http://127.0.0.1:${slowPort}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5-2b', stream: true, messages: [{ role: 'user', content: 'hi' }] }), signal: controller.signal }).then(async r => { await r.body?.getReader().read(); controller.abort() }).catch(() => undefined)
  await aborted
  const cutSeen = await until(async () => slowChild.lines.some(line => line === '[tensorfold-adapter] the client dropped the reply; the request to llama.cpp was cut'), 5_000)
  const closedSeen = await until(async () => readFileSync(slow.llamaLog, 'utf8').includes('client closed before the end'), 3_000)
  check("a client that drops the stream (Esc, an interrupt) drops the child's generation too: the adapter cut the request to llama.cpp and said so; the fake llama-server saw the close before its end", cutSeen && closedSeen, JSON.stringify({ cutSeen, closedSeen, lines: slowChild.lines.slice(-3), log: readFileSync(slow.llamaLog, 'utf8').slice(-200) }))
  slowChild.kill('SIGTERM')
  await slowChild.exit
  const keyWorld = worldWithLlama('tf-adapter-keyed')
  const keyFile = join(keyWorld.home, 'api-key')
  writeFileSync(keyFile, 'mercury[inference]: SECRET-KEY\n')
  const keyPort = await freePort()
  const keyChild = adapterProcess(['serve', QWEN_2B.repo, '--name', 'qwen3.5-2b', '--context', '4096', '--host', '127.0.0.1', '--api-key-file', keyFile, '--port', String(keyPort)], { ...keyWorld.env, HOME: keyWorld.home, TF_DRAIN_S: '1' })
  await until(async () => (await status(`http://127.0.0.1:${keyPort}/health`)) === 200, 15_000)
  const keyedHealth = await fetch(`http://127.0.0.1:${keyPort}/health`).then(r => r.json() as Promise<Record<string, unknown>>)
  const keyedModels = await status(`http://127.0.0.1:${keyPort}/v1/models`)
  const withKey = await fetch(`http://127.0.0.1:${keyPort}/v1/models`, { headers: { authorization: 'Bearer SECRET-KEY' } }).then(r => r.status)
  check('keyed: /health shows status and the tell only; /v1/models answers 401 without the key and 200 with it', JSON.stringify(keyedHealth) === '{"status":"ok","served_by":"mercury-llamacpp"}' && keyedModels === 401 && withKey === 200, JSON.stringify({ keyedHealth, keyedModels, withKey }))
  keyChild.kill('SIGTERM')
  await keyChild.exit
  const pidFile = identity.adapterChildPidFile(port)
  const remembered = adapterServe.readChildPidFile(port)
  const childPid = remembered?.pid ?? 0
  check("the llama-server child's pid and its start token are remembered beside the front port while serving", remembered !== undefined && alive(childPid) && remembered.token !== '', JSON.stringify(remembered))
  child.kill('SIGTERM')
  const exit = await child.exit
  await sleep(200)
  check('SIGTERM: draining words in his grammar, the child stopped (its stop logged), the pid file gone, exit 0, the port free', exit.code === 0 && child.lines.some(line => line.startsWith('shutting down (SIGTERM): draining')) && child.lines.includes('shutting down: drained') && readFileSync(world.llamaLog, 'utf8').includes('stopped') && !existsSync(pidFile) && !alive(childPid) && (await status(`${root}/health`)) === 0, JSON.stringify({ exit, lines: child.lines.slice(-4) }))
  check('the serving line named the engine, the window and the prompt cache', child.lines.some(line => line.startsWith(`serving qwen3.5-2b at http://127.0.0.1:${port}/v1 (Mercury's engine: llama.cpp b11829 on the CPU; context: 32768; prompt cache: 1 GiB; loaded in`)), child.lines.join(' | '))
}

section('the refusals from the serve verb: not pulled, port in use, --drafter, an unknown model, llama.cpp missing, the child dying')
{
  const world = worldWithLlama('tf-adapter-refuse', { gguf: false })
  const run = async (args: string[], env: NodeJS.ProcessEnv = { ...world.env, HOME: world.home }): Promise<{ code: number | null; last: string }> => {
    const child = adapterProcess(args, env)
    const exit = await child.exit
    return { code: exit.code, last: child.lines[child.lines.length - 1] ?? '' }
  }
  const notPulled = await run(['serve', QWEN_4B.repo, '--port', '1'])
  check('a model not in the cache refuses before any spawn in his words (the road reads not-pulled)', notPulled.code === 1 && notPulled.last === `tensorfold-adapter: ${QWEN_4B.repo} is not in the Hugging Face cache; the engine does not download: run tensorfold pull ${QWEN_4B.repo} first`, notPulled.last)
  const drafter = await run(['serve', QWEN_2B.repo, '--drafter', 'z-lab/Some-Drafter', '--port', '1'])
  check('--drafter is refused: no drafter on Mercury\'s engine', drafter.code === 1 && drafter.last === `tensorfold-adapter: --drafter z-lab/Some-Drafter is not available on Mercury's engine; serve ${QWEN_2B.repo} without it`, drafter.last)
  const unknown = await run(['serve', 'someone/Other-MLX-4bit', '--port', '1'])
  check('an unknown model: no backend for it on Mercury\'s engine, the table named (the road reads family)', unknown.code === 1 && unknown.last.startsWith("tensorfold-adapter: no backend for someone/Other-MLX-4bit on Mercury's engine; it serves "), unknown.last)
  const pulled = worldWithLlama('tf-adapter-refuse-port')
  const holder = createNetServer()
  const busyPort = await freePort()
  await new Promise<void>(resolve => holder.listen(busyPort, '127.0.0.1', resolve))
  const busy = await run(['serve', QWEN_2B.repo, '--port', String(busyPort)], { ...pulled.env, HOME: pulled.home })
  holder.close()
  check('a port in use: cannot listen … (AddressInUse), nothing spawned', busy.code === 1 && busy.last === `tensorfold-adapter: cannot listen on 127.0.0.1:${busyPort} (AddressInUse)` && !existsSync(pulled.llamaLog), busy.last)
  const noLlama = worldWithLlama('tf-adapter-refuse-nollama', { pinned: false, env: { PATH: '/usr/bin:/bin' } })
  const missing = await run(['serve', QWEN_2B.repo, '--port', String(await freePort())], { ...noLlama.env, HOME: noLlama.home })
  check('llama.cpp missing: the refusal names the install', missing.code === 1 && missing.last === 'tensorfold-adapter: llama.cpp is not installed on this machine; /tensorfold installs it', missing.last)
  const dying = worldWithLlama('tf-adapter-refuse-die', { env: { FAKE_LLAMA_DIE: '1' } })
  const died = await run(['serve', QWEN_2B.repo, '--port', String(await freePort())], { ...dying.env, HOME: dying.home })
  check("the child dying before ready: the adapter exits with its code and speaks the child's last line (the road's exited reader)", died.code === 1 && died.last === 'tensorfold-adapter: llama.cpp exited 1 · error: failed to allocate the KV cache (fake)', died.last)
}

section('the stale-child reaper: a remembered pid is killed only when its start token matches and the image is a llama-server; an empty or stale token never kills')
{
  const reapPort = await freePort()
  const stray = spawn('sleep', ['60'], { stdio: 'ignore' })
  const strayExit = new Promise<string | null>(resolve => stray.once('exit', (_code, signal) => resolve(signal)))
  await adapterServe.rememberChild(reapPort, stray.pid!, async () => 'T1')
  const stored = adapterServe.readChildPidFile(reapPort)
  check('the pid file holds the pid and the token', stored?.pid === stray.pid && stored.token === 'T1', JSON.stringify(stored))
  const said: string[] = []
  const notMine = await adapterServe.reapStaleChild(reapPort, 'darwin', line => said.push(line), { startToken: async () => 'T2', isLlamaServer: async () => true })
  check('a pid whose live start token differs (reused since) is left alone and the file is dropped', !notMine && alive(stray.pid!) && adapterServe.readChildPidFile(reapPort) === undefined && said.length === 0)
  await adapterServe.rememberChild(reapPort, stray.pid!, async () => null)
  const noToken = await adapterServe.reapStaleChild(reapPort, 'darwin', line => said.push(line), { startToken: async () => 'T1', isLlamaServer: async () => true })
  check('a pid remembered without a token (the reader failed at start) is never killed', !noToken && alive(stray.pid!))
  await adapterServe.rememberChild(reapPort, stray.pid!, async () => 'T1')
  const notLlama = await adapterServe.reapStaleChild(reapPort, 'darwin', line => said.push(line), { startToken: async () => 'T1', isLlamaServer: async () => false })
  check('a matching token on a process that is not a llama-server is left alone', !notLlama && alive(stray.pid!))
  await adapterServe.rememberChild(reapPort, stray.pid!, async () => 'T1')
  const reaped = await adapterServe.reapStaleChild(reapPort, 'darwin', line => said.push(line), { startToken: async () => 'T1', isLlamaServer: async () => true })
  const signal = await strayExit
  check('pid, token and image all matching: the stray is stopped and the adapter says so', reaped && signal === 'SIGTERM' && said[0] === `[tensorfold-adapter] stopped a llama-server left behind by an earlier serve on port ${reapPort} (pid ${stray.pid})`, JSON.stringify({ reaped, signal, said }))
}

section('pull: the HF-hub layout under the mapped GGUF repo, Range resume, the pinned sha256, a hard link into the snapshot; the road polls the mapped blobs')
{
  const world = worldWithLlama('tf-adapter-pull', { gguf: false })
  const bytes = Buffer.alloc(300_000)
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = (at * 31 + 7) & 0xff
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const ranges: string[] = []
  const hub: Server = createServer((request, response) => {
    const range = request.headers.range
    ranges.push(range ?? 'none')
    const from = range !== undefined ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
    const body = bytes.subarray(from)
    response.writeHead(range !== undefined ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...(range !== undefined ? { 'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {}) })
    response.end(body)
  })
  const hubPort = await freePort()
  await new Promise<void>(resolve => hub.listen(hubPort, '127.0.0.1', resolve))
  const gguf = { repo: 'fixture/Small-GGUF', file: 'Small-Q4_K_M.gguf', quant: 'Q4_K_M', revision: 'abc1234567890abcdef1234567890abcdef123456', sha256, bytes: bytes.length }
  const env = { ...world.env, HF_ENDPOINT: `http://127.0.0.1:${hubPort}` }
  const paths = hfCache.ggufPaths(world.cache, gguf)
  mkdirSync(join(paths.base, 'blobs'), { recursive: true })
  writeFileSync(paths.incomplete, bytes.subarray(0, 100_000))
  const progress: number[] = []
  const outcome = await adapterPull.pullGguf(world.cache, gguf, { env, onBytes: have => progress.push(have) })
  check('a partial blob resumes with Range: bytes=100000-, the whole file is re-hashed and matches, the blob is named by its sha256 and hard-linked into snapshots/<revision>/<file>', ranges[0] === 'bytes=100000-' && outcome.downloaded && outcome.bytes === bytes.length && existsSync(paths.blob) && statSync(paths.blob).nlink === 2 && readFileSync(paths.snapshotFile).equals(bytes) && !existsSync(paths.incomplete) && progress[progress.length - 1] === bytes.length && hfCache.ggufOnDisk(world.cache, gguf).complete, JSON.stringify({ ranges, outcome, progress: progress.slice(-2) }))
  check('no refs/main is written (huggingface_hub owns that file)', !existsSync(join(paths.base, 'refs', 'main')))
  const again = await adapterPull.pullGguf(world.cache, gguf, { env })
  check('pulling again downloads nothing', !again.downloaded && ranges.length === 1)
  const wrong = { ...gguf, sha256: 'f'.repeat(64) }
  const wrongPaths = hfCache.ggufPaths(world.cache, wrong)
  const refused = await adapterPull.pullGguf(world.cache, wrong, { env }).then(() => undefined, error => error as Error)
  check('a download whose sha256 is not the pinned one is discarded with the refusal, the .incomplete removed', refused instanceof adapterPull.GgufPullError && refused.message.includes('did not match its pinned sha256') && !existsSync(wrongPaths.incomplete) && !existsSync(wrongPaths.blob), String(refused))
  check('the road polls the mapped GGUF repo dir for progress bytes', hfCache.cacheBlobBytes(world.cache, gguf.repo) === bytes.length && hfCache.cacheBlobBytes(world.cache, 'nobody/Nothing') === 0)
  const out: string[] = []
  const err: string[] = []
  const cli = await adapterMain.runTensorFoldAdapter(['pull', `${QWEN_2B.repo}@93760be4f1f69842a46bc13dbdc0f19e291392a3`], { env, home: world.home, stdout: text => out.push(text), stderr: text => err.push(text) })
  check("the pull verb takes the road's MLX id with its MLX pin, maps it to the GGUF and says so; against the fixture hub the bytes are not the pinned file, so the pull refuses and leaves no blob", cli === 1 && out[0]!.startsWith(`[tensorfold-adapter] downloading unsloth/Qwen3.5-2B-GGUF@f6d5376 Qwen3.5-2B-Q4_K_M.gguf (1.28 GB) from Hugging Face for ${QWEN_2B.repo}`) && (err[0]!.includes('did not match its pinned sha256') || err[0]!.includes('ended at')) && !existsSync(hfCache.ggufPaths(world.cache, QWEN_2B.gguf).blob), JSON.stringify({ cli, out, err }))
  hub.close()
}

section('install: the pinned zip fetched, its sha256 verified, unpacked flat into the runtime folder ggufServer.ts reads, llama-server --version run after; a wrong digest or an escaping entry is refused')
{
  const world = worldWithLlama('tf-adapter-install', { pinned: false, gguf: false })
  const exe = Buffer.from('MZ fake llama-server.exe')
  const zip = Buffer.from(zipSync({ 'llama-server.exe': new Uint8Array(exe), 'ggml-cpu-haswell.dll': new Uint8Array(Buffer.from('dll')), 'LICENSE-LLVM-OpenMP': new Uint8Array(Buffer.from('licence')) }))
  const asset = { name: 'llama-b11829-bin-win-cpu-x64.zip', url: 'http://fixture/llama.zip', bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') }
  const fetchImpl = (async (url: string | URL | Request) => new Response(String(url) === asset.url ? zip : 'nope', { status: String(url) === asset.url ? 200 : 404 })) as typeof fetch
  const lines: string[] = []
  const found = await adapterLlama.installLlamaServer({ platform: 'win32', arch: 'x64', home: world.home, env: world.env, fetchImpl, asset, onLine: line => lines.push(line), startCheck: async () => 0, exists: path => existsSync(path) })
  check('the install unpacks the zip flat into ~/.local/share/mercury-host/runtime/llama.cpp/build/bin (the folder ggufServer.ts checks first), names the digest and the count, and returns the binary', found.binary === join(world.runtimeBin, 'llama-server.exe') && readFileSync(found.binary).equals(exe) && existsSync(join(world.runtimeBin, 'ggml-cpu-haswell.dll')) && lines[0]!.startsWith('downloading llama-b11829-bin-win-cpu-x64.zip') && lines[1] === `sha256 verified · ${asset.sha256.slice(0, 12)}…` && lines[2] === `unpacked 3 files into ${world.runtimeBin}`, JSON.stringify({ found, lines }))
  const bad = await adapterLlama.installLlamaServer({ platform: 'win32', arch: 'x64', home: fakeWorld('tf-adapter-install-bad').home, fetchImpl, asset: { ...asset, sha256: 'a'.repeat(64) }, startCheck: async () => 0 }).then(() => undefined, error => error as Error)
  check('a zip whose sha256 is not the pinned one installs nothing', bad instanceof adapterLlama.LlamaInstallError && bad.message.includes('does not match the sha256 Mercury measured'), String(bad))
  const escaping = Buffer.from(zipSync({ '../escape.exe': new Uint8Array(exe) }))
  const escapeAsset = { ...asset, bytes: escaping.length, sha256: createHash('sha256').update(escaping).digest('hex') }
  const escaped = await adapterLlama.installLlamaServer({ platform: 'win32', arch: 'x64', home: fakeWorld('tf-adapter-install-escape').home, fetchImpl: (async () => new Response(escaping)) as typeof fetch, asset: escapeAsset, startCheck: async () => 0 }).then(() => undefined, error => error as Error)
  check('a zip entry that escapes its folder is refused by the hardened reader', escaped instanceof Error && /unsafe path|traversal/i.test(escaped.message), String(escaped))
  const dll = await adapterLlama.installLlamaServer({ platform: 'win32', arch: 'x64', home: fakeWorld('tf-adapter-install-dll').home, fetchImpl, asset, startCheck: async () => 3221225781, exists: path => existsSync(path) }).then(() => undefined, error => error as Error)
  check('llama-server.exe dying with STATUS_DLL_NOT_FOUND after the unpack names the Visual C++ runtime as the fix', dll instanceof adapterLlama.LlamaInstallError && dll.message === adapterLlama.VC_REDIST_WORDS, String(dll))
  const mac = await adapterLlama.installLlamaServer({ platform: 'darwin', arch: 'arm64', home: world.home, fetchImpl, asset }).then(() => undefined, error => error as Error)
  check('the install verb is Windows x64 only; elsewhere it says so', mac instanceof adapterLlama.LlamaInstallError && mac.message.startsWith("the adapter installs llama.cpp's Windows x64 build only"))
  check('the pinned asset in code is the b11829 win-cpu-x64 zip Mercury measured', identity.LLAMACPP_WINDOWS_CPU_ASSET.name === 'llama-b11829-bin-win-cpu-x64.zip' && identity.LLAMACPP_WINDOWS_CPU_ASSET.bytes === 24_076_171 && identity.LLAMACPP_WINDOWS_CPU_ASSET.sha256 === 'c534f35ce9c842f3bc224fadaecc82e1b49768f63e8320922f6dbd603f66395e' && identity.LLAMACPP_RELEASE.commit === (await import('../../src/services/host/recipes.ts')).LLAMACPP_ENGINE_SHA, JSON.stringify(identity.LLAMACPP_WINDOWS_CPU_ASSET))
}

section("the road end to end on the adapter: findTensorFoldEngine → the inventory → startTensorFold (a tensorfold project service running the adapter under process.execPath) → the probe → stopTensorFold")
{
  const world = worldWithLlama('tf-adapter-road')
  const servedFile = join(world.home, 'served.json')
  const found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'darwin', exists: () => false, adapter: ENTRY, machine: WIN_16 } as never)
  check('with no tensorfold binary and the adapter seam, the engine is the adapter: the entry as its binary, servedBy, llama.cpp found pinned in the runtime folder', found !== null && found.binary === ENTRY && found.servedBy === 'mercury-llamacpp' && found.capabilities.llamacpp?.found === true && found.capabilities.llamacpp.pinned === true, JSON.stringify({ binary: found?.binary, servedBy: found?.servedBy, llama: found?.capabilities.llamacpp }))
  const rows = await inventory.readTensorFoldInventory(found, { cacheRoot: world.cache, machine: WIN_16, served: [], env: world.env, home: world.home })
  check('the inventory on the adapter is the table: the 4B first (best fit at 128k), the 2B on disk from the GGUF cache, Lightning unqualified; the 27B absent', rows.map(row => `${row.shortName}:${row.state}:${row.window}:${row.qualified}`).join(',') === 'qwen3.5-4b:not-pulled:131072:true,qwen3.5-2b:on-disk:262144:true,nemotron-lightning:not-pulled:32768:false' && rows[1]!.bytesOnDisk === QWEN_2B.gguf.bytes && rows[1]!.quantisation === 'Q4_K_M' && inventory.bestTensorFoldFit(rows)?.repo === QWEN_4B.repo, rows.map(row => [row.shortName, row.state, row.window, row.qualified]).join(' | '))
  check("the card's will-run lines on the adapter name the adapter verb, no MLX pin", serve.tensorFoldWillRun(rows[0]!, 131_072, found).join('\n') === `mercury --tensorfold-adapter pull ${QWEN_4B.repo}\nmercury --tensorfold-adapter serve ${QWEN_4B.repo} --name qwen3.5-4b --context 131072 --prompt-cache-gib 1 --port 8080` && serve.tensorFoldWillRun(rows[1]!, 262_144, found)[0] === `mercury --tensorfold-adapter serve ${QWEN_2B.repo} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --port 8080`, serve.tensorFoldWillRun(rows[0]!, 131_072, found).join(' / '))
  const port = await freePort()
  process.env.PATH = world.env.PATH!
  const served = await serve.startTensorFold({ repo: QWEN_2B.repo, window: 32_768, promptCacheGib: 1, port }, { binary: ENTRY, cwd: world.cwd, sessionId: 'proof', env: { ...world.env, HOME: world.home }, serviceEnv: { ...world.serviceEnv, HOME: world.home }, servedFile, machine: WIN_16, app: async () => ({ running: false }), freeMemoryBytes: async () => 12 * GIB })
  const record = readRecord(world.cwd, 'tensorfold')
  check('the service record: the command is process.execPath, the args the entry, --tensorfold-adapter, then the serve line; readiness on /health; the served record carries servedBy', record?.spec.command === process.execPath && record.spec.args.join(' ') === `${ENTRY} --tensorfold-adapter serve ${QWEN_2B.repo} --name qwen3.5-2b --context 32768 --prompt-cache-gib 1 --port ${port}` && record.spec.readiness[0]?.kind === 'http' && served.servedBy === 'mercury-llamacpp' && serve.servedTensorFold({ servedFile })[0]?.servedBy === 'mercury-llamacpp', JSON.stringify({ command: record?.spec.command, args: record?.spec.args, served }))
  const probe = await probeTensorFold(`http://127.0.0.1:${port}`, { timeoutMs: 2_000 })
  check("the road's server probes as the adapter", probe?.engine?.servedBy === 'mercury-llamacpp' && probe.models[0]?.id === 'qwen3.5-2b', JSON.stringify(probe?.engine))
  const facts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: WIN_16, engine: found, env: world.env, home: world.home, servedFile, platform: 'win32', localModels: () => [{ id: 'qwen3.5-2b', server: 'tensorfold', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: { tokens: 32_768, source: 'served' }, servedBy: 'mercury-llamacpp' }], hosts: () => [], helper: () => undefined, app: async () => ({ running: false }), current: 'local/qwen3.5-2b' })
  check('the panel facts: the served 2B first with the port, the heading words from the picker builder are the adapter sentence', facts.rows[0]?.repo === QWEN_2B.repo && facts.rows[0].state === 'serving' && facts.rows[0].port === port && facts.live.startsWith(`serving qwen3.5-2b on 127.0.0.1:${port}`), JSON.stringify({ first: facts.rows[0]?.shortName, live: facts.live }))
  const feed = scene.FEED.serves('qwen3.5-2b', 32_768, port, true, served.servedBy)
  check("the feed line names Mercury's engine, his engine's line unchanged otherwise", feed === `● Mercury's engine serves qwen3.5-2b · 32k on 127.0.0.1:${port} · this session's model` && scene.FEED.serves('qwen3.5-2b', 32_768, port) === `● TensorFold serves qwen3.5-2b · 32k on 127.0.0.1:${port} · this session's model` && scene.FEED.stopped('qwen3.5-2b', 'mercury-llamacpp') === "◌ Mercury's engine stopped qwen3.5-2b · /tensorfold serves it again", feed)
  const childPid = adapterServe.readChildPidFile(port)?.pid ?? 0
  const busyFacts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: WIN_16, engine: found, env: world.env, home: world.home, servedFile: join(world.home, 'nothing-served.json'), platform: 'win32', localModels: () => [{ id: 'qwen3.5-2b', server: 'tensorfold', baseUrl: `http://127.0.0.1:${serve.TENSORFOLD_DEFAULT_PORT}/v1`, contextWindow: { tokens: 32_768, source: 'served' }, servedBy: 'mercury-llamacpp' }], hosts: () => [], helper: () => undefined, app: async () => ({ running: false }) })
  check("an adapter server Mercury did not start, holding the preferred port, is named Mercury's engine in the port note and the next port is offered", busyFacts.outside[0]?.servedBy === 'mercury-llamacpp' && busyFacts.port.busy?.port === serve.TENSORFOLD_DEFAULT_PORT && busyFacts.port.busy.answersAs === "Mercury's engine" && busyFacts.port.next === serve.TENSORFOLD_DEFAULT_PORT + 1, JSON.stringify(busyFacts.port))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  await sleep(300)
  check('stopTensorFold through stopService ends the adapter and its llama-server child; the port is free; the pid file is gone', serve.servedTensorFold({ servedFile }).length === 0 && !alive(served.pid) && !alive(childPid) && (await status(`http://127.0.0.1:${port}/health`)) === 0 && !existsSync(identity.adapterChildPidFile(port)), JSON.stringify({ adapter: alive(served.pid), child: alive(childPid), pidFile: existsSync(identity.adapterChildPidFile(port)) }))
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: the TensorFold adapter — verbs, surfaces, the tell, pull, install, the road`)
process.exit(failures === 0 ? 0 : 1)

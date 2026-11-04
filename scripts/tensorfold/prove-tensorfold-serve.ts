#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { FAKE_BIN, GIB, MAC_48, QWEN_27B_REPO, QWEN_2B_REPO, fakeWorld } from './fixtures/world.ts'
import { FAKE_REPLY_PREFIX } from './fixtures/fake-tensorfold.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const serve = await import('../../src/services/tensorfold/serve.ts')
const pull = await import('../../src/services/tensorfold/pull.ts')
const road = await import('../../src/commands/tensorfold/road.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')
const inventory = await import('../../src/services/tensorfold/inventory.ts')
const engine = await import('../../src/services/tensorfold/engine.ts')
const { readRecord } = await import('../../src/services/projectServices/serviceManager.ts')
const receipts = await import('../../src/utils/model/seatReceipts.ts')
const { cachedLocalModels } = await import('../../src/services/providers/local/localDiscovery.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const binary = `${FAKE_BIN}/tensorfold`
const seen: Array<{ text: string; level: string; copyText?: string }> = []
receipts.subscribeSeatReceipts(r => seen.push(r))
engine.__pinTensorFoldMachineForTest(MAC_48)

section('serve: a tensorfold project service, loading while the port is closed, ready on /health, stopped through stopService')
{
  const world = fakeWorld('tf-serve', { env: { FAKE_TENSORFOLD_LOAD_MS: '1200' } })
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  const loading: number[] = []
  const picks: unknown[] = []
  process.env.PATH = world.env.PATH!
  const served = await serve.startTensorFold(
    { repo: QWEN_2B_REPO, window: 262_144, promptCacheGib: 1, port },
    { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, onLoading: seconds => loading.push(seconds), onPort: pick => picks.push(pick) },
  )
  check('the served record: the repo, its short name, the port asked for, the window, a pid, the prompt cache', served.repo === QWEN_2B_REPO && served.name === 'qwen3.5-2b' && served.port === port && served.window === 262_144 && served.pid > 0 && served.promptCacheGib === 1, JSON.stringify(served))
  check('while the port was closed the road reported loading seconds (never "exited")', loading.length >= 1 && loading[0]! >= 0, JSON.stringify(loading))
  check('the port pick was told before the spawn', picks.length === 1 && JSON.stringify(picks[0]) === JSON.stringify({ port }))
  const record = readRecord(world.cwd, 'tensorfold')
  check('the service record: name tensorfold, lifecycle project, restart never, readiness http /health, the serve line with its flags, TF_DRAIN_S in its environment', record?.spec.lifecycle === 'project' && record.spec.restart === 'never' && record.spec.readiness[0]?.kind === 'http' && record.spec.readiness[0].url === `http://127.0.0.1:${port}/health` && record.spec.args.join(' ') === `serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --port ${port}` && record.spec.env?.TF_DRAIN_S === '4' && record.state !== 'failed', JSON.stringify(record?.spec))
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json() as Promise<{ status: string }>)
  check('the server answers /health ok', health.status === 'ok')
  check('servedTensorFold() lists it from the served file reconciled with the live service', serve.servedTensorFold({ servedFile }).length === 1 && serve.servedTensorFold({ servedFile })[0]!.port === port)
  check('the remembered port is the served one', serve.rememberedTensorFoldPort({ servedFile }) === port)
  const rows = await inventory.readTensorFoldInventory(null, { cacheRoot: world.cache, machine: MAC_48, served: serve.servedTensorFold({ servedFile }), env: world.env, home: world.home })
  check('the inventory puts the served row first, state serving, started by Mercury, at the served window', rows[0]?.repo === QWEN_2B_REPO && rows[0].state === 'serving' && rows[0].startedBy === 'mercury' && rows[0].window === 262_144 && rows[0].port === port, JSON.stringify(rows.map(row => [row.repo, row.state, row.window])))
  const again = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 131_072, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB }).catch(error => error as Error)
  check('a second start stops the first (never a second copy beside it) and serves at the new window on the same port', !(again instanceof Error) && again.window === 131_072 && again.port === port && serve.servedTensorFold({ servedFile }).length === 1, again instanceof Error ? again.message : JSON.stringify(again))
  const before = Date.now()
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  const stopped = readRecord(world.cwd, 'tensorfold')
  check('stop goes through stopService: the record says stopped, the served file is cleared, the port is free again', stopped?.state === 'stopped' && stopped.explicitStop && serve.servedTensorFold({ servedFile }).length === 0 && (await freePort()) > 0, JSON.stringify({ state: stopped?.state, ms: Date.now() - before }))
  await sleep(200)
  const gone = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)
  check('the fake engine drained and exited on SIGTERM', !gone)
  check('a stop for a name Mercury did not start is a no-op', (await serve.stopTensorFold('someone-elses', { servedFile }).then(() => 'ok', error => String(error))) === 'ok')
}

section('the port: a busy preferred port moves the serve to the next free one, said once and remembered')
{
  const world = fakeWorld('tf-port')
  const servedFile = join(world.home, 'served.json')
  const preferred = await freePort()
  const holder = createServer()
  await new Promise<void>(resolve => holder.listen(preferred, '127.0.0.1', resolve))
  const pick = await serve.pickTensorFoldPort(preferred, { answersAs: async () => 'llama.cpp' })
  check('the pick: the next port, the busy one named with what answers there', pick.port === preferred + 1 && pick.busy?.port === preferred && pick.busy.answersAs === 'llama.cpp', JSON.stringify(pick))
  const served = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port: preferred }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, answersAs: async () => 'llama.cpp' })
  check('the serve landed on the next port and the record carries what was busy', served.port === preferred + 1 && serve.readServedRecord({ servedFile })?.busy?.port === preferred, JSON.stringify(serve.readServedRecord({ servedFile })))
  const facts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  check('the facts remember the port for the next serve', facts.port.next === preferred + 1 && facts.served[0]?.port === preferred + 1)
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  holder.close()
  const taken = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port: preferred }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, answersAs: async () => undefined }).then(served => served, error => error as Error)
  check('with the port free again the serve takes the preferred port', !(taken instanceof Error) && taken.port === preferred)
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
}

section("refusals: the engine's last stderr line read, the port in use, a killed server, the memory check")
{
  const world = fakeWorld('tf-refuse')
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  const memory = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'refuse-memory' }, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  check("a memory refusal: TensorFoldStartError with the engine's line verbatim, kind memory, the next window read from the room", memory !== null && memory.refusal?.kind === 'memory' && memory.refusal.line.startsWith('qwen3_5: one stream at a 262144-token window takes 16.00 GiB, more than the 5.12 GiB left under the load limit') && memory.refusal.nextWindow === 131_072 && memory.refusal.cacheGibAt === 1.5, JSON.stringify(memory?.refusal))
  check('after a refusal nothing is served and the record says failed', serve.servedTensorFold({ servedFile }).length === 0 && readRecord(world.cwd, 'tensorfold')?.state === 'failed')
  const holder = createServer()
  await new Promise<void>(resolve => holder.listen(port, '127.0.0.1', resolve))
  const busy = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'refuse-port' }, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  holder.close()
  check('the port pick walks past a held port, so AddressInUse never reaches the engine for a port Mercury checked', busy === null || busy.refusal?.kind !== 'port', JSON.stringify(busy?.refusal))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  const killed = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'exit-9' }, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  check('a server killed by signal 9: exited, signal 9 (killed)', killed !== null && killed.refusal?.kind === 'exited' && killed.refusal.line === 'signal 9 (killed)', JSON.stringify(killed?.refusal))
  const tight = await serve.startTensorFold({ repo: QWEN_27B_REPO, window: 131_072, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 10 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  check('memory tight (10 GiB free for a 28.5 GiB need): the start is refused before the spawn with the need and what is free', tight !== null && tight.tight !== null && Math.round(tight.tight.needBytes / GIB) === 29 && tight.tight.freeBytes === 10 * GIB && tight.message === '28.5 GiB needed · 10.0 GiB free', tight?.message)
  check('the offers when memory is tight name ollama stop and Mercury\'s own llama.cpp', serve.memoryOffers([{ name: 'local-gguf' }], true).join(' | ') === "ollama stop frees its model | s on Mercury's own llama.cpp server stops it")
}

section('sharing on the network: an explicit step — 0.0.0.0 with the key file, announced; the key file set exactly while shared; stop ends the announcement')
{
  const world = fakeWorld('tf-share')
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  const refused = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port, share: true }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as Error)
  check('without the key file road a share is refused in words, nothing starts', refused !== null && refused.message === 'sharing on your network needs the key file road' && serve.servedTensorFold({ servedFile }).length === 0, refused?.message)
  const announced: unknown[] = []
  let stopped = 0
  const keyPath = join(world.home, 'api-key')
  const shared = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port, share: true }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_BIND_LOOPBACK: '1' }, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, keyFile: () => ({ path: keyPath, key: 'k'.repeat(32), line: `mercury[inference]: ${'k'.repeat(32)}` }), announce: offer => { announced.push(offer); return { stop: () => { stopped += 1 } } } })
  const spec = readRecord(world.cwd, 'tensorfold')?.spec
  check('a shared serve binds 0.0.0.0 with the key file and keeps the port', spec?.args.join(' ') === `serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --host 0.0.0.0 --api-key-file ${keyPath} --port ${port}`, spec?.args.join(' '))
  check('the served record carries keyFile exactly while shared (the picker\'s n line reads it)', shared.keyFile === keyPath && serve.servedTensorFold({ servedFile })[0]?.keyFile === keyPath)
  check('the announcer was given the model, the engine port, the window and the key', announced.length === 1 && JSON.stringify(announced[0]) === JSON.stringify({ model: 'qwen3.5-2b', enginePort: port, window: 262_144, key: 'k'.repeat(32) }) && serve.tensorFoldAnnouncing() === 'qwen3.5-2b', JSON.stringify(announced))
  const plain = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB })
  check('serving again without share restarts on loopback with no key file and ends the announcement', plain.keyFile === undefined && stopped === 1 && serve.tensorFoldAnnouncing() === null && !(readRecord(world.cwd, 'tensorfold')?.spec.args.includes('--host') ?? true))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
}

section('pull: resumable, its progress read from the cache\'s growth, stopped with the download kept')
{
  const world = fakeWorld('tf-pull', { seeds: [], env: { FAKE_TENSORFOLD_PULL_BYTES: '2000000', FAKE_TENSORFOLD_PULL_STEPS: '10', FAKE_TENSORFOLD_PULL_STEP_MS: '60' } })
  const progress: Array<{ bytes: number; totalBytes?: number }> = []
  await pull.pullTensorFold(QWEN_2B_REPO, p => progress.push({ bytes: p.bytes, ...(p.totalBytes !== undefined ? { totalBytes: p.totalBytes } : {}) }), { binary, env: world.env, cacheRoot: world.cache, pollMs: 25, logDir: join(world.home, 'logs'), totalBytes: 2_000_000 })
  check('the progress grew from the cache (several samples, the last the whole download)', progress.length >= 3 && progress[progress.length - 1]!.bytes === 2_000_000 && progress.every(p => p.totalBytes === 2_000_000) && progress.some(p => p.bytes > 0 && p.bytes < 2_000_000), JSON.stringify(progress.map(p => p.bytes)))
  const snapshot = inventory.readHfSnapshot(world.cache, QWEN_2B_REPO)
  check('after the pull the snapshot is whole: config.json and the weights', snapshot !== undefined && snapshot.weightsBytes === 2_000_000 && snapshot.incompleteBytes === 0, JSON.stringify(snapshot))
  const controller = new AbortController()
  const world2 = fakeWorld('tf-pull-stop', { seeds: [], env: { FAKE_TENSORFOLD_PULL_BYTES: '2000000', FAKE_TENSORFOLD_PULL_STEPS: '40', FAKE_TENSORFOLD_PULL_STEP_MS: '50' } })
  setTimeout(() => controller.abort(), 300)
  const stopped = await pull.pullTensorFold(QWEN_2B_REPO, () => undefined, { binary, env: world2.env, cacheRoot: world2.cache, pollMs: 25, logDir: join(world2.home, 'logs'), signal: controller.signal }).then(() => null, error => error as InstanceType<typeof pull.TensorFoldPullError>)
  const partial = inventory.readHfSnapshot(world2.cache, QWEN_2B_REPO)
  check('s on a pull stops it: the error says the download resumes next time, the partial blob stays on disk', stopped !== null && stopped.stopped && stopped.message === 'the download stopped · it resumes next time' && partial === undefined && existsSync(join(world2.cache, 'models--mlx-community--Qwen3.5-2B-MLX-4bit', 'blobs', 'weightsblob.incomplete')), JSON.stringify({ stopped: stopped?.message, partial }))
  check('the incomplete bytes count as what is on disk for the row', pull.cacheBytesOf(world2.cache, QWEN_2B_REPO) > 0 && pull.cacheBytesOf(world2.cache, QWEN_2B_REPO) < 2_000_000)
}

section('the road: ↵ on the on-disk 2B serves it, switches the session through pickAndProve and mints the feed line')
{
  const world = fakeWorld('tf-road')
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  road.__resetTensorFoldRoadForTest()
  seen.length = 0
  const facts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  const row = { ...facts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!, port }
  check('the 2B is on disk in the fixture cache', row.state === 'on-disk' && row.window === 262_144)
  let switched = ''
  const outcome = await road.serveTensorFoldRow(row, 262_144, {
    serve: { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, port, answersAs: async () => undefined } as never,
    prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: (setting: string) => { switched = setting; return { sentence: ' · saved' } }, setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never },
    supportLine: async () => 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture',
  })
  check('the road served the 2B on the free port', outcome !== null && outcome.served.port === port && outcome.served.name === 'qwen3.5-2b', JSON.stringify(outcome?.served))
  check('the switch went through pickAndProve: the model local/qwen3.5-2b, a reply from the server, the choice persisted, the in-process session switched', outcome?.switched.ok === true && outcome.switched.switched && outcome.switched.model === 'local/qwen3.5-2b' && switched === 'local/qwen3.5-2b' && outcome.switched.words.includes(FAKE_REPLY_PREFIX.trim().split(' ')[0]!), JSON.stringify(outcome?.switched))
  check('discovery now lists the server Mercury started (the record the switch used)', cachedLocalModels().some(record => record.id === 'qwen3.5-2b' && record.baseUrl === `http://127.0.0.1:${port}/v1`), JSON.stringify(cachedLocalModels().map(record => [record.id, record.server, record.baseUrl])))
  check("the feed line: ● TensorFold serves qwen3.5-2b · 256k on 127.0.0.1:<port> · this session's model", seen.some(r => r.text === `● TensorFold serves qwen3.5-2b · 256k on 127.0.0.1:${port} · this session's model` && r.level === 'info'), JSON.stringify(seen))
  const state = road.tensorFoldRoadState()
  check('no act is left on the row after the serve', Object.keys(state.acts).length === 0, JSON.stringify(state.acts))
  const served = serve.servedTensorFold({ servedFile })
  const first = await road.stopTensorFoldRow(row, served, { current: true }, { serve: { servedFile } as never })
  check('s on this session\'s model asks once more', first === 's again stops it' && road.tensorFoldRoadState().acts[QWEN_2B_REPO]?.kind === 'stop-confirm')
  const second = await road.stopTensorFoldRow(row, served, { current: true }, { serve: { servedFile } as never })
  check('s again stops it and mints the stopped line with its door', second === 'stopped qwen3.5-2b' && seen.some(r => r.text === '◌ TensorFold stopped qwen3.5-2b · /tensorfold serves it again') && serve.servedTensorFold({ servedFile }).length === 0, JSON.stringify(seen.map(r => r.text)))
  seen.length = 0
  const refusedRow = { ...row, state: 'on-disk' as const }
  const refused = await road.serveTensorFoldRow(refusedRow, 262_144, {
    serve: { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'refuse-memory' }, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, port } as never,
    supportLine: async () => 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture',
  })
  const act = road.tensorFoldRoadState().acts[QWEN_2B_REPO]
  check('a refusal leaves the refused act on the row with the engine\'s words and the window ↵ serves at', refused === null && act?.kind === 'refused' && act.words.startsWith('qwen3_5: one stream at a 262144-token window') && act.nextWindow === 131_072 && act.cacheGibAt === 1.5, JSON.stringify(act))
  const warning = seen.find(r => r.level === 'warning')
  check('the error receipt ends with c copies the support line and carries the support line as its copy text', warning !== undefined && warning.text === '▲ TensorFold refused qwen3.5-2b at 256k (needs 16.0 GiB, 5.1 GiB left) · /tensorfold · c copies the support line' && warning.copyText === 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture', JSON.stringify(warning))
  seen.length = 0
  await road.serveTensorFoldRow(refusedRow, 262_144, { serve: { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'exit-9' }, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB, port } as never })
  check('a killed server: the exited receipt with its door', seen.some(r => r.text === `▲ TensorFold exited · qwen3.5-2b on 127.0.0.1:${port} · /tensorfold starts it again · c copies the support line`), JSON.stringify(seen.map(r => r.text)))
  road.__resetTensorFoldRoadForTest()
  const served2 = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, freeMemoryBytes: async () => 40 * GIB })
  const reattached = serve.servedTensorFold({ servedFile })
  check('after a restart of Mercury the served file plus the live service record reattach the server (same pid, same port)', reattached.length === 1 && reattached[0]!.pid === served2.pid && reattached[0]!.port === port)
  const text = readFileSync(servedFile, 'utf8')
  check('the served file names the project whose service holds the process, so another project can stop it through stopService', text.includes(`"project":"${world.cwd}"`))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: TensorFold serve, port, refusals, pull and the road`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { FAKE_BIN, GIB, MAC_48, QWEN_27B_REPO, QWEN_2B_REPO, fakeExists, fakeWorld } from './fixtures/world.ts'
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
const noApp = async (): Promise<{ running: boolean }> => ({ running: false })
const { detectTensorFoldApp, TENSORFOLD_SECOND_COPY_REFUSAL } = await import('../../src/services/providers/local/tensorfoldApp.ts')
const { forgetTensorFoldHost, tensorFoldHostRecords } = await import('../../src/services/providers/local/tensorfoldHosts.ts')
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
    { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB, onLoading: seconds => loading.push(seconds), onPort: pick => picks.push(pick) },
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
  const again = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 131_072, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB }).catch(error => error as Error)
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
  const served = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port: preferred }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB, answersAs: async () => 'llama.cpp' })
  check('the serve landed on the next port and the record carries what was busy', served.port === preferred + 1 && serve.readServedRecord({ servedFile })?.busy?.port === preferred, JSON.stringify(serve.readServedRecord({ servedFile })))
  const facts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  check('the facts remember the port for the next serve', facts.port.next === preferred + 1 && facts.served[0]?.port === preferred + 1)
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  holder.close()
  const taken = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port: preferred }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB, answersAs: async () => undefined }).then(served => served, error => error as Error)
  check('with the port free again the serve takes the preferred port', !(taken instanceof Error) && taken.port === preferred)
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
}

section("refusals: the engine's last stderr line read, the port in use, a killed server, the memory check")
{
  const world = fakeWorld('tf-refuse')
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  const memory = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'refuse-memory' }, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  check("a memory refusal: TensorFoldStartError with the engine's line verbatim, kind memory, the next window read from the room", memory !== null && memory.refusal?.kind === 'memory' && memory.refusal.line.startsWith('qwen3_5: one stream at a 262144-token window takes 16.00 GiB, more than the 5.12 GiB left under the load limit') && memory.refusal.nextWindow === 131_072 && memory.refusal.cacheGibAt === 1.5, JSON.stringify(memory?.refusal))
  check('after a refusal nothing is served and the record says failed', serve.servedTensorFold({ servedFile }).length === 0 && readRecord(world.cwd, 'tensorfold')?.state === 'failed')
  const holder = createServer()
  await new Promise<void>(resolve => holder.listen(port, '127.0.0.1', resolve))
  const busy = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'refuse-port' }, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  holder.close()
  check('the port pick walks past a held port, so AddressInUse never reaches the engine for a port Mercury checked', busy === null || busy.refusal?.kind !== 'port', JSON.stringify(busy?.refusal))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  const killed = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'exit-9' }, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  check('a server killed by signal 9: exited, signal 9 (killed)', killed !== null && killed.refusal?.kind === 'exited' && killed.refusal.line === 'signal 9 (killed)', JSON.stringify(killed?.refusal))
  const tight = await serve.startTensorFold({ repo: QWEN_27B_REPO, window: 131_072, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 10 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  check('memory tight (10 GiB free for a 28.5 GiB need): the start is refused before the spawn with the need and what is free', tight !== null && tight.tight !== null && Math.round(tight.tight.needBytes / GIB) === 29 && tight.tight.freeBytes === 10 * GIB && tight.message === '28.5 GiB needed · 10.0 GiB free', tight?.message)
  check('the offers when memory is tight name ollama stop and Mercury\'s own llama.cpp', serve.memoryOffers([{ name: 'local-gguf' }], true).join(' | ') === "ollama stop frees its model | s on Mercury's own llama.cpp server stops it")
}

section("the roles: the helper is its own project service beside the session's, with its own record and its own port; a stop of one never touches the other")
{
  const world = fakeWorld('tf-roles')
  const servedFile = join(world.home, 'served.json')
  const io = { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB }
  const sessionPort = await freePort()
  const session = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port: sessionPort }, io)
  const helperPort = await freePort()
  const helper = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 32_768, name: 'qwen3.5-2b', port: helperPort, promptCacheGib: 1, role: 'helper' }, io)
  const up = async (port: number): Promise<boolean> => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) }).then(r => r.ok, () => false)
  check('both roles are up at once on their own ports', session.port === sessionPort && helper.port === helperPort && (await up(sessionPort)) && (await up(helperPort)), JSON.stringify({ session: session.port, helper: helper.port }))
  check('two project services: tensorfold for the session, tensorfold-helper for the helper, each with its own pid', readRecord(world.cwd, 'tensorfold')?.pid === session.pid && readRecord(world.cwd, 'tensorfold-helper')?.pid === helper.pid && session.pid !== helper.pid, JSON.stringify({ session: readRecord(world.cwd, 'tensorfold')?.pid, helper: readRecord(world.cwd, 'tensorfold-helper')?.pid }))
  check('two records: served.json for the session, helper.json beside it for the helper, each read only by its role', existsSync(join(world.home, 'helper.json')) && serve.servedTensorFold({ servedFile })[0]?.port === sessionPort && serve.servedTensorFold({ servedFile, role: 'helper' })[0]?.port === helperPort && serve.servedTensorFold({ servedFile }).length === 1 && serve.servedTensorFold({ servedFile, role: 'helper' }).length === 1, JSON.stringify({ session: serve.servedTensorFold({ servedFile }), helper: serve.servedTensorFold({ servedFile, role: 'helper' }) }))
  check('each role remembers its own port', serve.rememberedTensorFoldPort({ servedFile }) === sessionPort && serve.rememberedTensorFoldPort({ servedFile, role: 'helper' }) === helperPort)
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, role: 'helper' })
  check("stopping the helper by its role leaves the session's server serving", serve.servedTensorFold({ servedFile, role: 'helper' }).length === 0 && (await up(sessionPort)) && serve.servedTensorFold({ servedFile })[0]?.port === sessionPort && readRecord(world.cwd, 'tensorfold')?.state !== 'stopped')
  const helperAgain = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 32_768, port: helperPort, promptCacheGib: 1, role: 'helper' }, io)
  const sessionAgain = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 131_072, port: sessionPort }, io)
  check("a restart of the session's server (a new window) stops only the session's old copy; the helper keeps serving", sessionAgain.window === 131_072 && (await up(helperPort)) && serve.servedTensorFold({ servedFile, role: 'helper' })[0]?.pid === helperAgain.pid && readRecord(world.cwd, 'tensorfold-helper')?.pid === helperAgain.pid)
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  check("stopping the session's server leaves the helper serving", serve.servedTensorFold({ servedFile }).length === 0 && (await up(helperPort)) && serve.servedTensorFold({ servedFile, role: 'helper' }).length === 1)
  check('a stop of the session role names the helper in vain (the roles never cross)', (await serve.stopTensorFold('qwen3.5-2b', { servedFile }).then(() => 'ok', error => String(error))) === 'ok' && (await up(helperPort)))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, role: 'helper' })
  check('the helper stopped through stopService: its record says stopped, its port is free', readRecord(world.cwd, 'tensorfold-helper')?.state === 'stopped' && !(await up(helperPort)))
}

section("a second copy beside the TensorFold app is refused before anything spawns (the app's engine found in the process table)")
{
  const world = fakeWorld('tf-app')
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  const rows = [
    { pid: 500, ppid: 1, command: '/Applications/TensorFold.app/Contents/MacOS/TensorFold', args: '/Applications/TensorFold.app/Contents/MacOS/TensorFold' },
    { pid: 501, ppid: 500, command: '/Applications/TensorFold.app/Contents/Resources/tensorfold-native', args: `/Applications/TensorFold.app/Contents/Resources/tensorfold-native serve ${QWEN_27B_REPO} --port 8080` },
  ]
  const refused = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: () => detectTensorFoldApp({ processes: async () => rows }), freeMemoryBytes: async () => 40 * GIB }).then(() => null, error => error as InstanceType<typeof serve.TensorFoldStartError>)
  check("refused in the design's words, with no refusal to read and nothing tight", refused !== null && refused.message === TENSORFOLD_SECOND_COPY_REFUSAL && refused.message === "the TensorFold app is already serving on this Mac · quit the app first — two copies won't fit" && refused.refusal === null && refused.tight === null, refused?.message)
  check('nothing spawned: no service record, no served record, the port untouched', readRecord(world.cwd, 'tensorfold') === null && serve.servedTensorFold({ servedFile }).length === 0 && (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) }).then(() => false, () => true)))
  const appOnly = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: () => detectTensorFoldApp({ processes: async () => rows.slice(0, 1) }), freeMemoryBytes: async () => 40 * GIB })
  check('the app open without its engine serving is no refusal: the serve goes ahead', appOnly.port === port)
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
}

section('sharing on the network: an explicit step — 0.0.0.0 with the key file, announced; the key file set exactly while shared; stop ends the announcement')
{
  const world = fakeWorld('tf-share')
  const servedFile = join(world.home, 'served.json')
  const port = await freePort()
  const { tensorFoldKeyFilePath, readTensorFoldKeyFile } = await import('../../src/services/providers/local/tensorfoldKeyFile.ts')
  const { tensorFoldPorts } = await import('../../src/services/providers/local/tensorfoldHosts.ts')
  const own = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port, share: true }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_BIND_LOOPBACK: '1' }, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB })
  const ownKey = readTensorFoldKeyFile(tensorFoldKeyFilePath())
  check("with no seams given, a share writes Mercury's own key file (mercury[inference]: KEY at 0600) and the served record names it", own.keyFile === tensorFoldKeyFilePath() && ownKey !== undefined && ownKey.line === `mercury[inference]: ${ownKey.key}` && (statSync(tensorFoldKeyFilePath()).mode & 0o077) === 0, JSON.stringify({ keyFile: own.keyFile, line: ownKey?.line }))
  check('with no seams given, the pairing server announces it and the one-time code is readable for the serving Mac to show', serve.tensorFoldAnnouncing() === 'qwen3.5-2b' && /^\d{6}$/.test(serve.tensorFoldPairingCode() ?? ''), String(serve.tensorFoldPairingCode()))
  check('the served port is remembered in the hosts store (discovery probes it after a restart)', tensorFoldPorts().includes(port), JSON.stringify(tensorFoldPorts()))
  const ownHost = tensorFoldHostRecords().find(host => host.baseUrl === `http://127.0.0.1:${port}`)
  check("with no seams given, this Mac's own shared server is remembered as a host of origin shared with its key, what it serves and its window (discovery and the chat read the key from there)", ownHost !== undefined && ownHost.origin === 'shared' && ownHost.key === ownKey?.key && ownHost.serving === 'qwen3.5-2b' && ownHost.window === 262_144 && ownHost.name !== '', JSON.stringify(ownHost))
  const keyless = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(800) }).then(r => r.status, () => 0)
  check('the shared server asks for its key: /v1/models answers 401 without it, /health shows status only', keyless === 401 && JSON.stringify(await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())) === '{"status":"ok"}', String(keyless))
  road.__resetTensorFoldRoadForTest()
  let persisted = ''
  const keyedSwitch = await road.switchToTensorFold(own, { prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: (setting: string) => { persisted = setting; return { sentence: ' · saved' } }, setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never } })
  check('the switch to the shared server goes through with its key: discovery lists it through the host record and pickAndProve sends the key on the prove turn', keyedSwitch.ok && keyedSwitch.switched && keyedSwitch.model === 'local/qwen3.5-2b' && persisted === 'local/qwen3.5-2b' && keyedSwitch.words.includes(FAKE_REPLY_PREFIX.trim().split(' ')[0]!), JSON.stringify(keyedSwitch))
  const found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'darwin', exists: fakeExists, machine: MAC_48 } as never)
  const keyedFacts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: found, env: world.env, home: world.home, servedFile, served: [], localModels: () => [], hosts: () => [] })
  check('a keyed server on the remembered port that nothing lists is read live: the facts say it asks for a key and the next serve takes the next port', keyedFacts.keyed?.address === `127.0.0.1:${port}` && keyedFacts.port.next === port + 1 && keyedFacts.port.busy?.port === port && keyedFacts.port.busy.answersAs === 'TensorFold' && keyedFacts.live === `127.0.0.1:${port} answers with a key · /health shows status only`, JSON.stringify({ keyed: keyedFacts.keyed, port: keyedFacts.port, live: keyedFacts.live }))
  const announced: unknown[] = []
  let stopped = 0
  const keyPath = join(world.home, 'api-key')
  const remembered: unknown[] = []
  const forgotten: string[] = []
  const shared = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port, share: true }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_BIND_LOOPBACK: '1' }, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB, keyFile: () => { writeFileSync(keyPath, `mercury[inference]: ${'k'.repeat(32)}\n`, { mode: 0o600 }); return { path: keyPath, key: 'k'.repeat(32), line: `mercury[inference]: ${'k'.repeat(32)}` } }, announce: offer => { announced.push(offer); return { stop: () => { stopped += 1 }, code: '246810' } }, machineName: () => 'studio', rememberHost: async host => { remembered.push(host) }, forgetHost: async name => { forgotten.push(name); await forgetTensorFoldHost(name) } })
  check("a restart while shared forgot the old host record (the name the default road gave it) and remembered the new one through the seams: this Mac's name, the loopback base, origin shared, the key, what it serves, the window", forgotten.length === 1 && forgotten[0] === ownHost?.name && remembered.length === 1 && JSON.stringify(remembered[0]) === JSON.stringify({ name: 'studio', baseUrl: `http://127.0.0.1:${port}`, origin: 'shared', key: 'k'.repeat(32), serving: 'qwen3.5-2b', window: 262_144 }), JSON.stringify({ remembered: remembered.length, forgotten: forgotten.length }))
  check('a restart through the seams ended the default announcement; the seam\'s code is the one shown', serve.tensorFoldPairingCode() === '246810')
  const spec = readRecord(world.cwd, 'tensorfold')?.spec
  check('a shared serve binds 0.0.0.0 with the key file and keeps the port', spec?.args.join(' ') === `serve ${QWEN_2B_REPO} --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --host 0.0.0.0 --api-key-file ${keyPath} --port ${port}`, spec?.args.join(' '))
  check('the served record carries keyFile exactly while shared (the picker\'s n line reads it)', shared.keyFile === keyPath && serve.servedTensorFold({ servedFile })[0]?.keyFile === keyPath)
  check('the announcer was given the model, the engine port, the window and the key', announced.length === 1 && JSON.stringify(announced[0]) === JSON.stringify({ model: 'qwen3.5-2b', enginePort: port, window: 262_144, key: 'k'.repeat(32) }) && serve.tensorFoldAnnouncing() === 'qwen3.5-2b', JSON.stringify(announced))
  const plain = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB })
  check('serving again without share restarts on loopback with no key file and ends the announcement', plain.keyFile === undefined && stopped === 1 && serve.tensorFoldAnnouncing() === null && serve.tensorFoldPairingCode() === null && !(readRecord(world.cwd, 'tensorfold')?.spec.args.includes('--host') ?? true))
  check('unsharing leaves no shared host record: the store no longer lists the loopback host and the served record names no shared host', tensorFoldHostRecords().every(host => host.baseUrl !== `http://127.0.0.1:${port}`) && serve.readServedRecord({ servedFile })?.sharedAs === undefined, JSON.stringify({ hosts: tensorFoldHostRecords().map(host => host.baseUrl), record: serve.readServedRecord({ servedFile }) }))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
  check('stop forgets the port in the hosts store', !tensorFoldPorts().includes(port), JSON.stringify(tensorFoldPorts()))
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
    serve: { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB, port, answersAs: async () => undefined } as never,
    prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: (setting: string) => { switched = setting; return { sentence: ' · saved' } }, setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never },
    supportLine: async () => 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture',
  })
  check('the road served the 2B on the free port', outcome !== null && outcome.served.port === port && outcome.served.name === 'qwen3.5-2b', JSON.stringify(outcome?.served))
  check('the switch went through pickAndProve: the model local/qwen3.5-2b, a reply from the server, the choice persisted, the in-process session switched', outcome?.switched.ok === true && outcome.switched.switched && outcome.switched.model === 'local/qwen3.5-2b' && switched === 'local/qwen3.5-2b' && outcome.switched.words.includes(FAKE_REPLY_PREFIX.trim().split(' ')[0]!), JSON.stringify(outcome?.switched))
  check('discovery now lists the server Mercury started (the record the switch used)', cachedLocalModels().some(record => record.id === 'qwen3.5-2b' && record.baseUrl === `http://127.0.0.1:${port}/v1`), JSON.stringify(cachedLocalModels().map(record => [record.id, record.server, record.baseUrl])))
  check("the feed line: ● TensorFold serves qwen3.5-2b · 256k on 127.0.0.1:<port> · this session's model", seen.some(r => r.text === `● TensorFold serves qwen3.5-2b · 256k on 127.0.0.1:${port} · this session's model` && r.level === 'info'), JSON.stringify(seen))
  const found = await engine.findTensorFoldEngine({ env: world.env, home: world.home, platform: 'darwin', exists: fakeExists, machine: MAC_48 } as never)
  const after = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: found, env: world.env, home: world.home, servedFile, hosts: () => [], current: 'local/qwen3.5-2b', lastTurn: () => ({ model: 'local/qwen3.5-2b', address: `127.0.0.1:${port}`, tokensPerSecond: 110, timeToFirstTokenS: 0.04 }) })
  const servedRow = after.rows.find(candidate => candidate.repo === QWEN_2B_REPO)
  check("the served row carries what the server measures: the memory in use from discovery's /health reading and the last reply's speed from the usage ledger; the live line says so", servedRow?.state === 'serving' && servedRow.startedBy === 'mercury' && servedRow.inUseBytes === 3_015_330_576 && servedRow.lastReply?.tokensPerSecond === 110 && servedRow.lastReply.firstTokenMs === 40 && after.outside.length === 0 && after.live === `serving qwen3.5-2b on 127.0.0.1:${port} · first reply in 40 ms · ~110 tok/s`, JSON.stringify({ row: [servedRow?.state, servedRow?.inUseBytes, servedRow?.lastReply], live: after.live, outside: after.outside }))
  const state = road.tensorFoldRoadState()
  check('no act is left on the row after the serve', Object.keys(state.acts).length === 0, JSON.stringify(state.acts))
  const served = serve.servedTensorFold({ servedFile })
  const stopped = await road.stopTensorFoldRow(row, served, { serve: { servedFile } as never })
  check("the stop act stops it at once and mints the stopped line with its door (the picker is what asks s again on the session's own model — prove-tensorfold-t-frames t15b and the drive)", stopped === 'stopped qwen3.5-2b' && seen.some(r => r.text === '◌ TensorFold stopped qwen3.5-2b · /tensorfold serves it again') && serve.servedTensorFold({ servedFile }).length === 0, JSON.stringify(seen.map(r => r.text)))
  seen.length = 0
  const refusedRow = { ...row, state: 'on-disk' as const }
  const refused = await road.serveTensorFoldRow(refusedRow, 262_144, {
    serve: { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'refuse-memory' }, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB, port } as never,
    supportLine: async () => 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture',
  })
  const act = road.tensorFoldRoadState().acts[QWEN_2B_REPO]
  check('a refusal leaves the refused act on the row with the engine\'s words and the window ↵ serves at', refused === null && act?.kind === 'refused' && act.words.startsWith('qwen3_5: one stream at a 262144-token window') && act.nextWindow === 131_072 && act.cacheGibAt === 1.5, JSON.stringify(act))
  const warning = seen.find(r => r.level === 'warning')
  check('the error receipt ends with c copies the support line and carries the support line as its copy text', warning !== undefined && warning.text === '▲ TensorFold refused qwen3.5-2b at 256k (needs 16.0 GiB, 5.1 GiB left) · /tensorfold · c copies the support line' && warning.copyText === 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture', JSON.stringify(warning))
  seen.length = 0
  await road.serveTensorFoldRow(refusedRow, 262_144, { serve: { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'exit-9' }, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB, port } as never })
  check('a killed server: the exited receipt with its door', seen.some(r => r.text === `▲ TensorFold exited · qwen3.5-2b on 127.0.0.1:${port} · /tensorfold starts it again · c copies the support line`), JSON.stringify(seen.map(r => r.text)))
  road.__resetTensorFoldRoadForTest()
  const served2 = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, { binary, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile, machine: MAC_48, app: noApp, freeMemoryBytes: async () => 40 * GIB })
  const reattached = serve.servedTensorFold({ servedFile })
  check('after a restart of Mercury the served file plus the live service record reattach the server (same pid, same port)', reattached.length === 1 && reattached[0]!.pid === served2.pid && reattached[0]!.port === port)
  const text = readFileSync(servedFile, 'utf8')
  check('the served file names the project whose service holds the process, so another project can stop it through stopService', text.includes(`"project":"${world.cwd}"`))
  await serve.stopTensorFold('qwen3.5-2b', { servedFile })
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: TensorFold serve, port, refusals, pull and the road`)
process.exit(failures === 0 ? 0 : 1)

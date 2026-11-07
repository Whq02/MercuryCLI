#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as listenTcp } from 'node:net'
import { join } from 'node:path'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { FAKE_BIN, GIB, MAC_48, fakeWorld } from '../tensorfold/fixtures/world.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-helper-lifetime')
process.env.HOME = HOME
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_MODEL

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
async function finish(): Promise<never> {
  await releaseScratchHome(HOME)
  console.log(`\nprove-helper-lifetime: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}
const quiet = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = listenTcp()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
  })
})
const alive = (pid: number | null | undefined): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Route = (req: IncomingMessage, res: ServerResponse) => boolean
function listen(route: Route): Promise<{ server: Server; root: string; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        if (!route(req, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end('{}')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}`, port })
    })
  })
}
const json = (res: ServerResponse, body: unknown): true => {
  res.writeHead(200, { 'content-type': 'application/json', server: 'TensorFold' })
  res.end(JSON.stringify(body))
  return true
}
const tensorFold = (model: string, window: number): Route => (req, res) => {
  const url = req.url ?? ''
  if (url === '/health') return json(res, { status: 'ok', model, model_ids: [model], max_batch_size: 8, warming: false, memory: { active: 3006477107, cache: 0, peak: 3279555608 }, live: { connections: 0, waiting: 0 }, version: '1.2.2', backend: 'metal', device: 'Apple M5 Pro' })
  if (/\/models$/.test(url)) return json(res, { object: 'list', data: [{ id: model, object: 'model', created: 1, owned_by: 'tensorfold', context_length: window, max_model_len: window, reasoning: { default_enabled: true } }] })
  return false
}
const helper2b = await listen(tensorFold('qwen3.5-2b', 32768))
const session27b = await listen(tensorFold('qwen3.8-27b', 131072))
process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${session27b.root}`

section('§0 the modules import')
const mods = await (async () => {
  try {
    return {
      helper: await import('../../src/services/providers/local/tensorfoldHelper.js'),
      hosts: await import('../../src/services/providers/local/tensorfoldHosts.js'),
      discovery: await import('../../src/services/providers/local/localDiscovery.js'),
      serve: await import('../../src/services/tensorfold/serve.js'),
      engine: await import('../../src/services/tensorfold/engine.js'),
      manager: await import('../../src/services/projectServices/serviceManager.js'),
      lifecycle: await import('../../src/services/run/ownerLifecycle.js'),
      resolveOwner: await import('../../src/services/run/resolveOwner.js'),
      config: await import('../../src/utils/config/globalConfig.js'),
    }
  } catch (error) {
    check('the modules import', false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
    return undefined
  }
})()
const ready = mods ?? (await finish())
check('the modules import', true)
const { helper, hosts, discovery, serve, engine, manager, lifecycle, resolveOwner, config } = ready
config.enableConfigs()
await discovery.refreshLocalDiscovery({ force: true })
helper.__pinHelperReadsForTest({ engineFound: true, twoBOnDisk: true })
const owner = resolveOwner.processMainOwner()
const point = { repo: helper.HELPER_2B_REPO, shortName: helper.HELPER_2B_NAME, promptCacheGib: 1 }
const helper2bAgain = await listen(tensorFold('qwen3.5-2b', 32768))
const probeOnly27b = async (): Promise<void> => {
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await discovery.refreshLocalDiscovery({ force: true })
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${session27b.root}`
}

section('§1 the specs: the helper role is a session-lifecycle service, the session role stays a project service')
{
  const helperSpec = serve.tensorFoldServiceSpec('/opt/tensorfold/bin/tensorfold', point, 32768, 50876, HOME, 'qwen3.5-2b', {}, undefined, 'helper')
  const mainSpec = serve.tensorFoldServiceSpec('/opt/tensorfold/bin/tensorfold', point, 262144, 8080, HOME)
  check('the helper spec: tensorfold-helper · lifecycle session · restart never (red on the base: lifecycle project)', helperSpec.name === 'tensorfold-helper' && helperSpec.lifecycle === 'session' && helperSpec.restart === 'never', JSON.stringify({ name: helperSpec.name, lifecycle: helperSpec.lifecycle }))
  check('the main slot spec: tensorfold · lifecycle project · untouched', mainSpec.name === 'tensorfold' && mainSpec.lifecycle === 'project' && mainSpec.restart === 'never', JSON.stringify({ name: mainSpec.name, lifecycle: mainSpec.lifecycle }))
  const helperSrc = readFileSync(join(REPO, 'src/services/providers/local/tensorfoldHelper.ts'), 'utf8')
  const ggufSrc = readFileSync(join(REPO, 'src/services/localSetup/ggufServer.ts'), 'utf8')
  const serveSrc = readFileSync(join(REPO, 'src/services/tensorfold/serve.ts'), 'utf8')
  check('the 2B rides its seam with the session as owner and a no-op rememberPort, its stop and record with a no-op forgetPort', /serve\.startTensorFold\(request, \{ \.\.\.serveIo, owner: processMainOwner\(\), rememberPort: \(\) => undefined \}\)/.test(helperSrc) && /const roleIo = \{ \.\.\.serveIo, role: HELPER_ROLE, forgetPort: \(\) => undefined \}/.test(helperSrc))
  check('startTensorFold passes the owner it is given to startService, nothing else', /startService\(\{ spec, sessionId, \.\.\.\(io\.owner !== undefined \? \{ owner: io\.owner \} : \{\}\) \}\)/.test(serveSrc))
  check('the 4B: a session-lifecycle mercury-helper spec, started with the session as owner', /name: HELPER_SERVICE_NAME, lifecycle: 'session'/.test(helperSrc) && /startGgufServer\(model, spec, \{ port, owner: processMainOwner\(\) \}\)/.test(helperSrc))
  check('startGgufServer passes the owner it is given to startService; its own plan stays a project service', /startService\(\{ spec, sessionId: getSessionId\(\), \.\.\.\(seam\.owner !== undefined \? \{ owner: seam\.owner \} : \{\}\) \}\)/.test(ggufSrc) && /lifecycle: 'project'/.test(ggufSrc))
}

section('§2 the seam: the helper a session starts ends when that session\'s owner is disposed; the seam\'s stop sees the helper\'s name once, helperProcess is cleared')
{
  helper.__resetHelperForTest()
  const started: Array<Record<string, unknown>> = []
  const stopped: string[] = []
  let record: { repo: string; name: string; port: number; window: number; pid: number; startedAt: string } | undefined
  helper.__pinHelperServeSeamForTest(() => ({
    start: async request => {
      started.push({ ...request })
      record = { repo: request.repo, name: request.name ?? 'x', port: helper2b.port, window: request.window, pid: 777, startedAt: '2026-11-07T00:00:01.000Z' }
      return record
    },
    stop: async name => {
      stopped.push(name)
      record = undefined
    },
    served: () => (record === undefined ? [] : [record]),
  }))
  helper.writeHelperModelSetting({ size: '2b' })
  await helper.ensureHelperServing()
  check('the helper started once through the seam: role helper, the 2B by name', started.length === 1 && started[0]?.role === 'helper' && started[0].name === 'qwen3.5-2b', JSON.stringify(started))
  check('its own process is known by its port', helper.readHelperModelState().port === helper2b.port && helper.helperServedRecord()?.port === helper2b.port, JSON.stringify(helper.readHelperModelState()))
  await lifecycle.disposeOwner(owner)
  await quiet(100)
  check('disposing the owner stops the helper: the seam\'s stop called once with the helper\'s name (red on the base: nothing stops)', JSON.stringify(stopped) === JSON.stringify(['qwen3.5-2b']), JSON.stringify(stopped))
  await discovery.refreshLocalDiscovery({ force: true })
  check('helperProcess is cleared: no port in the state, no served record', helper.readHelperModelState().port === undefined && helper.helperServedRecord() === undefined, JSON.stringify(helper.readHelperModelState()))
  check('the session role saw no stop', !stopped.some(name => name === 'qwen3.8-27b'))
  await helper.ensureHelperServing()
  check('this session starts it again', started.length === 2 && helper.readHelperModelState().port === helper2b.port, JSON.stringify(started))
  record = { ...record!, port: helper2bAgain.port, pid: 778 }
  await lifecycle.disposeOwner(owner)
  await probeOnly27b()
  check('the starter\'s end leaves a helper another session restarted since: the record names another port, the seam saw no second stop, helperProcess is cleared', stopped.length === 1 && helper.readHelperModelState().port === undefined, JSON.stringify({ stopped, state: helper.readHelperModelState() }))
  record = undefined
  const stops: string[] = []
  const fourB = await manager.startService({ spec: { name: 'mercury-helper', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: HOME, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session' }, sessionId: 'proof' })
  const fourBPid = 'record' in fourB ? fourB.record.pid : null
  if (typeof helper.__pinHelperProcessForTest === 'function') helper.__pinHelperProcessForTest({ size: '4b', port: 4242, modelId: 'local/qwen3.5-4b', pid: 4242, stop: async () => { stops.push('stale') } })
  await lifecycle.disposeOwner(owner)
  check('a 4B this process no longer holds (its pid is not our child) is left alone at the owner\'s dispose: its stop is not called, helperProcess cleared', stops.length === 0 && helper.readHelperModelState().port === undefined, JSON.stringify({ stops, state: helper.readHelperModelState() }))
  if (typeof helper.__pinHelperProcessForTest === 'function' && fourBPid !== null) helper.__pinHelperProcessForTest({ size: '4b', port: 4243, modelId: 'local/qwen3.5-4b', pid: fourBPid, stop: async () => { stops.push('own'); await manager.stopService(HOME, 'mercury-helper') } })
  await lifecycle.disposeOwner(owner)
  check('a 4B this process started and still holds ends at the owner\'s dispose through its own stop: the child gone, helperProcess cleared', JSON.stringify(stops) === JSON.stringify(['own']) && !alive(fourBPid) && helper.readHelperModelState().port === undefined, JSON.stringify({ stops, alive: alive(fourBPid), state: helper.readHelperModelState() }))
  await manager.stopService(HOME, 'mercury-helper')
  helper.__pinHelperServeSeamForTest(undefined)
  helper.writeHelperModelSetting({ size: 'off' })
}

section('§3 the service manager: a session-lifecycle helper owned by the session dies at the owner\'s dispose; a project-lifecycle main slot in the same project is untouched')
{
  const idle = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], readiness: [] }
  const helperSpec = { ...serve.tensorFoldServiceSpec('/opt/tensorfold/bin/tensorfold', point, 32768, 50876, HOME, 'qwen3.5-2b', {}, undefined, 'helper'), ...idle }
  const mainSpec = { ...serve.tensorFoldServiceSpec('/opt/tensorfold/bin/tensorfold', point, 262144, 8080, HOME), ...idle }
  const helperStart = await manager.startService({ spec: helperSpec, sessionId: 'proof', owner })
  const mainStart = await manager.startService({ spec: mainSpec, sessionId: 'proof' })
  const helperPid = 'record' in helperStart ? helperStart.record.pid : null
  const mainPid = 'record' in mainStart ? mainStart.record.pid : null
  check('both services started: tensorfold-helper (owned by the session) and tensorfold (the main slot, no owner)', alive(helperPid) && alive(mainPid), JSON.stringify({ helperStart, mainStart }))
  check('the records: tensorfold-helper lifecycle session, tensorfold lifecycle project (red on the base: both project)', manager.readRecord(HOME, 'tensorfold-helper')?.spec.lifecycle === 'session' && manager.readRecord(HOME, 'tensorfold')?.spec.lifecycle === 'project', JSON.stringify({ helper: manager.readRecord(HOME, 'tensorfold-helper')?.spec.lifecycle, main: manager.readRecord(HOME, 'tensorfold')?.spec.lifecycle }))
  await lifecycle.disposeOwner(owner)
  await quiet(200)
  check('the owner\'s dispose ends the helper: its process gone, its record stopped', !alive(helperPid) && manager.readRecord(HOME, 'tensorfold-helper')?.state === 'stopped', JSON.stringify({ alive: alive(helperPid), state: manager.readRecord(HOME, 'tensorfold-helper')?.state }))
  check('the main slot is untouched by the same dispose: its process alive, its record live', alive(mainPid) && manager.readRecord(HOME, 'tensorfold')?.state !== 'stopped', JSON.stringify({ alive: alive(mainPid), state: manager.readRecord(HOME, 'tensorfold')?.state }))
  await manager.stopService(HOME, 'tensorfold-helper')
  await manager.stopService(HOME, 'tensorfold')
  check('the main slot stops only when asked', !alive(mainPid) && manager.readRecord(HOME, 'tensorfold')?.state === 'stopped')
}

section('§4 the hosts file is never written for the helper: a start leaves local-setup/tensorfold-hosts.json byte-identical, discovery probes the helper\'s port from its own record, a second session finds it there, a stop removes nothing because nothing was added')
{
  helper.__resetHelperForTest()
  const started: Array<Record<string, unknown>> = []
  const stopped: string[] = []
  let record: { repo: string; name: string; port: number; window: number; pid: number; startedAt: string } | undefined
  let startFails = false
  helper.__pinHelperServeSeamForTest(() => ({
    start: async request => {
      started.push({ ...request })
      if (startFails) throw new Error('the fake start refused')
      record = { repo: request.repo, name: request.name ?? 'x', port: helper2b.port, window: request.window, pid: 777, startedAt: '2026-11-07T00:00:02.000Z' }
      return record
    },
    stop: async name => {
      stopped.push(name)
      record = undefined
    },
    served: () => (record === undefined ? [] : [record]),
  }))
  hosts.forgetTensorFoldPort(helper2b.port)
  hosts.rememberTensorFoldPort(session27b.port)
  await discovery.refreshLocalDiscovery({ force: true })
  const hostsFile = join(HOME, 'local-setup', 'tensorfold-hosts.json')
  const before = readFileSync(hostsFile, 'utf8')
  check('the owner\'s hosts file remembers the session server\'s port and nothing of the helper', JSON.stringify(hosts.tensorFoldPorts()) === JSON.stringify([session27b.port]) && !before.includes(String(helper2b.port)), before)
  helper.writeHelperModelSetting({ size: '2b' })
  await helper.ensureHelperServing()
  check('the helper started once through the seam', started.length === 1 && helper.readHelperModelState().port === helper2b.port, JSON.stringify(started))
  check('the hosts file is byte-identical after the start (red on the base: the helper\'s port is appended to ports)', readFileSync(hostsFile, 'utf8') === before, readFileSync(hostsFile, 'utf8'))
  check('discovery probes the helper\'s port from the helper\'s own record, beside the remembered ports', discovery.localProbeTargets().some(target => target.kind === 'tensorfold' && target.root === helper2b.root) && discovery.localProbeTargets().some(target => target.root === session27b.root), JSON.stringify(discovery.localProbeTargets()))
  check('the helper\'s model is in the catalogue on its own port', discovery.cachedLocalModels().some(model => model.id === 'qwen3.5-2b' && model.baseUrl === `${helper2b.root}/v1`), JSON.stringify(discovery.cachedLocalModels().map(model => [model.id, model.baseUrl])))
  await helper.stopHelperServing()
  check('the owning session\'s stop goes through the seam once', JSON.stringify(stopped) === JSON.stringify(['qwen3.5-2b']), JSON.stringify(stopped))
  check('a stop removes nothing from the hosts file because nothing was added', readFileSync(hostsFile, 'utf8') === before && JSON.stringify(hosts.tensorFoldPorts()) === JSON.stringify([session27b.port]), readFileSync(hostsFile, 'utf8'))
  await discovery.refreshLocalDiscovery({ force: true })
  check('with the record gone discovery no longer probes the helper\'s port', !discovery.localProbeTargets().some(target => target.root === helper2b.root) && helper.readHelperModelState().port === undefined, JSON.stringify(discovery.localProbeTargets()))
  await helper.ensureHelperServing()
  check('the next job\'s ensureHelperServing starts it again', started.length === 2 && helper.readHelperModelState().port === helper2b.port, JSON.stringify(started))
  helper.__resetHelperForTest()
  await discovery.refreshLocalDiscovery({ force: true })
  const readPort = typeof helper.readHelperPort === 'function' ? helper.readHelperPort() : undefined
  const hostsPort = typeof hosts.helperPort === 'function' ? hosts.helperPort() : undefined
  check('a second session with the setting on finds the helper through the record, no process of its own in hand: readHelperPort and the hosts seam read its port, discovery lists it', readPort === helper2b.port && hostsPort === helper2b.port && discovery.localProbeTargets().some(target => target.root === helper2b.root), JSON.stringify({ readPort, hostsPort }))
  await helper.ensureHelperServing()
  check('that session uses the serving helper: no third start, its port known, its model in the catalogue', started.length === 2 && helper.readHelperModelState().port === helper2b.port && discovery.cachedLocalModels().some(model => model.id === 'qwen3.5-2b' && model.baseUrl === `${helper2b.root}/v1`), JSON.stringify(started))
  check('the hosts file is still byte-identical', readFileSync(hostsFile, 'utf8') === before)
  helper.__resetHelperForTest()
  record = undefined
  await probeOnly27b()
  await helper.ensureHelperServing()
  check('a session that started the helper holds its port', started.length === 3 && helper.readHelperModelState().port === helper2b.port, JSON.stringify(started))
  record = { ...record!, port: helper2bAgain.port, pid: 779 }
  await probeOnly27b()
  check('another session restarted the helper elsewhere and this session\'s catalogue does not list it yet', helper.readHelperModelState().port === helper2b.port && !discovery.cachedLocalModels().some(model => model.id === 'qwen3.5-2b'), JSON.stringify(helper.readHelperModelState()))
  await helper.ensureHelperServing()
  check('the next job adopts the live helper from the record instead of starting over it: no start, helperProcess names the record\'s port, readHelperPort too', started.length === 3 && helper.readHelperModelState().port === helper2bAgain.port && helper.readHelperPort() === helper2bAgain.port, JSON.stringify({ started, state: helper.readHelperModelState() }))
  await discovery.refreshLocalDiscovery({ force: true })
  check('discovery probes the adopted port and the catalogue carries the live helper there', discovery.localProbeTargets().some(target => target.root === helper2bAgain.root) && discovery.cachedLocalModels().some(model => model.id === 'qwen3.5-2b' && model.baseUrl === `${helper2bAgain.root}/v1`), JSON.stringify(discovery.cachedLocalModels().map(model => [model.id, model.baseUrl])))
  await lifecycle.disposeOwner(owner)
  check('the adopter\'s end leaves the helper it did not start: the seam saw no stop, the record stands', stopped.length === 1 && helper.helperServedRecord()?.port === helper2bAgain.port, JSON.stringify(stopped))
  record = undefined
  await probeOnly27b()
  startFails = true
  await helper.ensureHelperServing()
  check('with no live record and a start that fails, the stale own port was forgotten before the start: no port in hand, the failure recorded', started.length === 4 && helper.readHelperModelState().port === undefined && helper.helperFailureWords() === 'the fake start refused', JSON.stringify({ started: started.length, state: helper.readHelperModelState(), failure: helper.helperFailureWords() }))
  startFails = false
  await helper.ensureHelperServing()
  check('the next job\'s start happens and is held', started.length === 5 && helper.readHelperModelState().port === helper2b.port && helper.helperFailureWords() === undefined, JSON.stringify(started))
  helper.__pinHelperServeSeamForTest(undefined)
  helper.__resetHelperForTest()
  helper.writeHelperModelSetting({ size: 'off' })
}

section('§5 the real road: the helper\'s own seam drives serve.startTensorFold against a fake TensorFold; a real start and stop leave the hosts file byte-identical; a second session adopts the real record; only the starter\'s end stops the real process')
{
  helper.__resetHelperForTest()
  helper.__pinHelperServeSeamForTest(undefined)
  const hostsFile = join(HOME, 'local-setup', 'tensorfold-hosts.json')
  const before = readFileSync(hostsFile, 'utf8')
  if (typeof helper.__pinHelperServeIoForTest !== 'function') {
    check('the helper\'s real seam takes a pinned serve io (red on the base: no pin, the real engine would be found)', false)
  } else {
    const world = fakeWorld('helper-lifetime')
    const realPath = process.env.PATH
    process.env.PATH = world.env.PATH
    engine.__pinTensorFoldMachineForTest(MAC_48)
    const serveIo = { binary: `${FAKE_BIN}/tensorfold`, cwd: world.cwd, sessionId: 'proof', env: world.env, serviceEnv: world.serviceEnv, servedFile: join(world.home, 'served.json'), machine: MAC_48, app: async () => ({ running: false }), freeMemoryBytes: async () => 40 * GIB, startWaitMs: 30_000 }
    helper.__pinHelperServeIoForTest(serveIo)
    helper.writeHelperModelSetting({ size: '2b' })
    await probeOnly27b()
    await helper.ensureHelperServing()
    const record = helper.helperServedRecord()
    const service = manager.readRecord(world.cwd, 'tensorfold-helper')
    check('a real tensorfold-helper service started through serve.startTensorFold: a live record with a pid, lifecycle session', record !== undefined && service !== null && alive(service.pid) && service.spec.lifecycle === 'session' && service.spec.command === `${FAKE_BIN}/tensorfold`, JSON.stringify({ record, state: service?.state, lifecycle: service?.spec.lifecycle, failure: helper.helperFailureWords() }))
    check('the hosts file is byte-identical after the real start (red with the no-op rememberPort hook removed from the seam)', readFileSync(hostsFile, 'utf8') === before, readFileSync(hostsFile, 'utf8'))
    check('readHelperPort reads the real record; discovery lists the port; the catalogue carries the 2B the fake serves there', record !== undefined && helper.readHelperPort() === record.port && discovery.localProbeTargets().some(target => target.root === `http://127.0.0.1:${record.port}`) && discovery.cachedLocalModels().some(model => model.id === 'qwen3.5-2b' && model.baseUrl === `http://127.0.0.1:${record.port}/v1`), JSON.stringify(discovery.cachedLocalModels().map(model => [model.id, model.baseUrl])))
    helper.__resetHelperForTest()
    await probeOnly27b()
    const disposers = lifecycle.ownerLifecycleCounts().adhoc
    await helper.ensureHelperServing()
    check('a second session adopts the real record: the same pid serves, no second service, helperProcess names the record\'s port', manager.readRecord(world.cwd, 'tensorfold-helper')?.pid === service?.pid && record !== undefined && helper.readHelperModelState().port === record.port, JSON.stringify({ pid: manager.readRecord(world.cwd, 'tensorfold-helper')?.pid, state: helper.readHelperModelState() }))
    check('adoption registers no end-of-session stop: the owner\'s disposers are as before, the process still serves', lifecycle.ownerLifecycleCounts().adhoc === disposers && service !== null && alive(service.pid), JSON.stringify({ before: disposers, after: lifecycle.ownerLifecycleCounts().adhoc }))
    const otherCwd = join(world.root, 'other-project')
    mkdirSync(otherCwd, { recursive: true })
    const overlapping = await serve.startTensorFold(helper.helper2bRequest(await freePort()), { ...serveIo, cwd: otherCwd, owner, rememberPort: () => undefined }).then(served => served, error => ({ error: String(error) }))
    check('a second session\'s start arriving while a live helper record exists adopts it in serve.startTensorFold itself: the live record\'s facts come back, the first process still serves, no second service was spawned, no stop was issued', 'port' in overlapping && record !== undefined && service !== null && overlapping.port === record.port && overlapping.pid === service.pid && alive(service.pid) && manager.readRecord(world.cwd, 'tensorfold-helper')?.pid === service.pid && manager.readRecord(otherCwd, 'tensorfold-helper') === null, JSON.stringify({ overlapping, firstAlive: alive(service?.pid), other: manager.readRecord(otherCwd, 'tensorfold-helper')?.state }))
    await manager.stopService(otherCwd, 'tensorfold-helper')
    const helperFile = join(world.home, 'helper.json')
    const liveRecordText = readFileSync(helperFile, 'utf8')
    writeFileSync(helperFile, 'null\n')
    let restored = false
    const failing = await serve.startTensorFold(helper.helper2bRequest(await freePort()), { ...serveIo, cwd: otherCwd, owner, rememberPort: () => undefined, serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_SERVE: 'exit-9', FAKE_TENSORFOLD_LOAD_MS: '1500' }, onLoading: () => { if (!restored) { writeFileSync(helperFile, liveRecordText); restored = true } } }).then(() => 'started', error => String(error))
    check('a helper start that fails while another session\'s live record was written meanwhile never blanks that record: the first helper is still the record', failing !== 'started' && restored && readFileSync(helperFile, 'utf8') === liveRecordText && record !== undefined && helper.helperServedRecord()?.port === record.port, JSON.stringify({ failing, restored, file: readFileSync(helperFile, 'utf8') }))
    await manager.stopService(otherCwd, 'tensorfold-helper')
    if (typeof helper.__pinHelperProcessForTest === 'function' && record !== undefined) helper.__pinHelperProcessForTest({ size: '2b', port: record.port, modelId: 'local/qwen3.5-2b' })
    check('the starter holds one end-of-session stop', lifecycle.ownerLifecycleCounts().adhoc === disposers + 1)
    if (record !== undefined) hosts.rememberTensorFoldPort(record.port)
    const seeded = readFileSync(hostsFile, 'utf8')
    check('for the stop, the owner remembers a server on the helper\'s own number', record !== undefined && seeded !== before && hosts.tensorFoldPorts().includes(record.port))
    await lifecycle.disposeOwner(owner)
    await quiet(200)
    check('the starter\'s end stops the real helper through stopHelperServing: process gone, service record stopped, helper.json written null (only the seam\'s stop writes that)', service !== null && !alive(service.pid) && manager.readRecord(world.cwd, 'tensorfold-helper')?.state === 'stopped' && readFileSync(helperFile, 'utf8').trim() === 'null' && helper.helperServedRecord() === undefined, JSON.stringify({ alive: alive(service?.pid), state: manager.readRecord(world.cwd, 'tensorfold-helper')?.state, file: readFileSync(helperFile, 'utf8') }))
    check('the real stop leaves the owner\'s remembered port on the helper\'s number alone (red with the no-op forgetPort hook removed from the seam)', readFileSync(hostsFile, 'utf8') === seeded, readFileSync(hostsFile, 'utf8'))
    if (record !== undefined) hosts.forgetTensorFoldPort(record.port)
    check('the hosts file is back to its bytes before the real road', readFileSync(hostsFile, 'utf8') === before)
    await discovery.refreshLocalDiscovery({ force: true })
    check('nothing of the helper is listed or held once it is gone: helperProcess cleared, no port in the state', !discovery.cachedLocalModels().some(model => model.id === 'qwen3.5-2b') && helper.readHelperModelState().port === undefined, JSON.stringify(helper.readHelperModelState()))
    helper.__pinHelperServeIoForTest(undefined)
    engine.__pinTensorFoldMachineForTest(null)
    process.env.PATH = realPath
    rmSync(world.root, { recursive: true, force: true })
  }
  helper.__resetHelperForTest()
  helper.writeHelperModelSetting({ size: 'off' })
}

for (const s of [helper2b.server, helper2bAgain.server, session27b.server]) s.close()
await finish()

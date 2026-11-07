#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'

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
const { helper, hosts, discovery, serve, manager, lifecycle, resolveOwner, config } = ready
config.enableConfigs()
await discovery.refreshLocalDiscovery({ force: true })
helper.__pinHelperReadsForTest({ engineFound: true, twoBOnDisk: true })
const owner = resolveOwner.processMainOwner()
const point = { repo: helper.HELPER_2B_REPO, shortName: helper.HELPER_2B_NAME, promptCacheGib: 1 }

section('§1 the specs: the helper role is a session-lifecycle service, the session role stays a project service')
{
  const helperSpec = serve.tensorFoldServiceSpec('/opt/tensorfold/bin/tensorfold', point, 32768, 50876, HOME, 'qwen3.5-2b', {}, undefined, 'helper')
  const mainSpec = serve.tensorFoldServiceSpec('/opt/tensorfold/bin/tensorfold', point, 262144, 8080, HOME)
  check('the helper spec: tensorfold-helper · lifecycle session · restart never (red on the base: lifecycle project)', helperSpec.name === 'tensorfold-helper' && helperSpec.lifecycle === 'session' && helperSpec.restart === 'never', JSON.stringify({ name: helperSpec.name, lifecycle: helperSpec.lifecycle }))
  check('the main slot spec: tensorfold · lifecycle project · untouched', mainSpec.name === 'tensorfold' && mainSpec.lifecycle === 'project' && mainSpec.restart === 'never', JSON.stringify({ name: mainSpec.name, lifecycle: mainSpec.lifecycle }))
  const helperSrc = readFileSync(join(REPO, 'src/services/providers/local/tensorfoldHelper.ts'), 'utf8')
  const ggufSrc = readFileSync(join(REPO, 'src/services/localSetup/ggufServer.ts'), 'utf8')
  const serveSrc = readFileSync(join(REPO, 'src/services/tensorfold/serve.ts'), 'utf8')
  check('the 2B rides its seam with the session as owner', /serve\.startTensorFold\(request, \{ owner: processMainOwner\(\)/.test(helperSrc))
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
  helper.__pinHelperServeSeamForTest(() => ({
    start: async request => {
      started.push({ ...request })
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
  helper.__pinHelperServeSeamForTest(undefined)
  helper.__resetHelperForTest()
  helper.writeHelperModelSetting({ size: 'off' })
}

for (const s of [helper2b.server, session27b.server]) s.close()
await finish()

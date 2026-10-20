import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, liveCatalogue } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const bundle = resolve(option('--bundle') ?? join(import.meta.dir, '../../dist/mercury.mjs'))
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const f = await llmhostFixture()
f.state.dialect = 'llamacpp'; f.state.window = 524288; f.state.slots = 4
const rp = await runpodFixture()
const { settingsChangeDetector } = await import('../../src/utils/settings/changeDetector.ts')
await settingsChangeDetector.initialize()
let m: Mounted | undefined
let daemon: ChildProcess | undefined
let daemonLog = ''
const workers = new Set<string>()
const config = { modelBaseUrl: f.baseUrl, hold: true, failLaunch: false, log: 'MERCURY_STEP installing\nMERCURY_STEP building llama.cpp\nMERCURY_STEP downloading weights\nfixture weights are downloading\n' }
const save = () => writeFileSync(join(f.home, 'ssh-fixture.json'), JSON.stringify(config))
save()
const bin = join(f.home, 'bin'); mkdirSync(bin)
copyFileSync(join(import.meta.dir, 'sshJobFixture.mjs'), join(bin, 'ssh')); chmodSync(join(bin, 'ssh'), 0o700)
const startDaemon = () => {
  daemon = spawn('node', [bundle, 'daemon', 'run', f.home], { cwd: f.home, env: { ...process.env, PATH: bin + ':' + process.env.PATH, MERCURY_DAEMON_DIR: join(f.home, 'daemon'), MERCURY_SATURN_DISABLE: '1', MERCURY_DAEMON_NO_SELF_WARM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  daemon.stdout?.on('data', chunk => { daemonLog += String(chunk) }); daemon.stderr?.on('data', chunk => { daemonLog += String(chunk) })
}
process.env.MERCURY_DAEMON_DIR = join(f.home, 'daemon')
startDaemon()
const { hostRecords, readHostRecord, patchHostRecord } = await import('../../src/services/host/store.ts')
const { stopHostSetup, sweepHostJobs } = await import('../../src/services/host/jobs.ts')
const { reconcileRecord } = await import('../../src/services/projectServices/serviceManager.ts')
const { deliverHostNotices } = await import('../../src/services/host/notices.ts')
const { getCommandQueue, resetCommandQueue } = await import('../../src/utils/messageQueueManager.ts')
try {
  check('built daemon owns the control plane', await waitFor(() => daemonLog.includes('control socket up'), 20000))
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const { namedCompatModelOptions, refreshCompatCatalogues } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, sessionId: 'rental-session' })
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  open()
  m = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot)))), 120, 44)
  const screen = async (text: string) => assert.ok(await waitFor(() => m!.screen().includes(text), 15000), text + '\n' + m!.screen() + '\n' + daemonLog)
  const choose = async (text: string) => {
    for (let n = 0; n < 30; n++) {
      const before = m!.lines().find(line => line.includes('› ')) ?? ''
      if (before.includes(text)) { m!.push(KEY.enter); return }
      m!.push(KEY.down)
      assert.ok(await waitFor(() => (m!.lines().find(line => line.includes('› ')) ?? '') !== before, 3000), 'selection moves to ' + text + '\n' + m!.screen())
    }
    throw new Error('Choice not found: ' + text)
  }
  const capture = async (name: string) => {
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), m!.screen())
    const grid = m!.lines().map((line, y) => Array.from(line.padEnd(120)).map((c, x) => { const style = m!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const path = join(frames, name + '.json'); writeFileSync(path, JSON.stringify({ grid, cols: 120, rows: 44 }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  await screen('Where should the model run?'); await choose('Rent a GPU')
  await screen('Runpod API key'); m.push(rp.key); await screen('********'); m.push(KEY.enter)
  await screen('Optional spending budget'); m.push(KEY.enter)
  await screen('live Runpod stock')
  const api = new RunpodClient(rp.key, rp.baseUrl)
  const offers = await api.offers(new AbortController().signal)
  const payload = await (await fetch(rp.baseUrl + '/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=1&minCudaVersion=13.0', { headers: { Authorization: 'Bearer ' + rp.key } })).json()
  assert.deepEqual(payload, liveCatalogue)
  assert.deepEqual(offers.map(row => row.recipe.id).sort(), ['nemotron35-super-gguf-rtx-pro-6000', 'qwen38-27b-rtx-pro-6000'])
  check('catalogue is the live snapshot, including zero Secure prices and the live RTX PRO 6000 name', liveCatalogue.gpus.some((gpu: any) => gpu.price.secure === 0) && offers.every(row => row.price === 2.49))
  check('no paid action before price confirmation', rp.state.creates === 0)
  await choose('UD-Q3_K_XL'); await screen('Confirm the hourly price'); await choose('Confirm $2.49/hr')
  check('rental is recorded before popup dismissal', await waitFor(() => hostRecords().length === 1, 15000))
  const id = hostRecords()[0]!.id; workers.add(id)
  const generation = readHostRecord(id)!.generation
  m.push(KEY.esc)
  check('Escape closes the popup immediately', await waitFor(() => !popup.isSettingsPopupOpen(), 5000))
  check('the built daemon starts a detached setup worker after Escape', await waitFor(() => readHostRecord(id)?.jobState === 'running', 20000))
  const service = reconcileRecord(join(f.home, 'host'), 'host-' + id)!
  check('setup lives in the project Service owner, not the popup process', service.spec.lifecycle === 'project' && service.pid !== process.pid && service.pid !== daemon!.pid)
  check('worker advances and tails the engine log while popup is closed', await waitFor(() => readHostRecord(id)?.step?.startsWith('downloading weights') ?? false, 15000))
  open(); await screen('Where should the model run?'); await choose(id); await screen('Pod controls'); await screen('downloading weights'); await screen('so far')
  await capture('01-mid-job')
  check('reopening shows live progress without restarting', readHostRecord(id)!.generation === generation && readHostRecord(id)!.jobState === 'running')
  m.push('\x1b[<0;1;44M\x1b[<0;1;44m')
  check('click outside closes only the window', await waitFor(() => !popup.isSettingsPopupOpen(), 5000))
  check('outside click leaves the job running', readHostRecord(id)!.jobState === 'running')
  daemon!.kill('SIGTERM')
  check('daemon exits for the restart test', await waitFor(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 15000))
  check('project-owned setup survives even its launching daemon exiting', reconcileRecord(join(f.home, 'host'), 'host-' + id)?.pid === service.pid)
  daemonLog = ''; startDaemon(); check('replacement daemon starts', await waitFor(() => daemonLog.includes('control socket up'), 20000))
  config.hold = false; config.log += 'MERCURY_STEP starting engine\n'; save()
  check('closed popup job reaches ready on the built worker', await waitFor(() => readHostRecord(id)?.jobState === 'ready', 25000))
  const ready = readHostRecord(id)!
  assert.deepEqual(ready.steps!.filter(row => !row.step.startsWith('downloading weights ') && !row.step.startsWith('tunnel on ')).map(row => row.step), ['waiting for SSH', 'installing', 'building llama.cpp', 'downloading weights', 'starting engine', 'ready'])
  check('durable step sequence and local log survive runner ownership changes', readFileSync(ready.log!, 'utf8').includes('fixture weights are downloading'))
  const settings = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'))
  const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
  check('background registration keeps the llama.cpp dialect', settings.compatProvider[ready.provider!].dialect === 'llamacpp')
  await refreshCompatCatalogues({ force: true })
  check('/model can enumerate the registered server and per-slot context window through the settings watcher', await waitFor(() => namedCompatModelOptions().some(row => row.value === 'compat/' + ready.provider + '/' + f.model) && getContextWindowForModel('compat/' + ready.provider + '/' + f.model) === 131072, 10000))
  resetCommandQueue(); deliverHostNotices('other-session')
  check('notice is addressed to the renting session, not the focused stranger', getCommandQueue().length === 0)
  deliverHostNotices('rental-session')
  check('ready notice reaches the session completion channel', getCommandQueue().some(row => row.mode === 'task-notification' && String(row.value).includes('is ready on compat/' + ready.provider) && String(row.value).includes('so far')))
  deliverHostNotices('rental-session'); check('one ready notice, not one per popup open', getCommandQueue().length === 1)
  open(); await screen('Where should the model run?'); await choose(id); await screen('ready'); await capture('02-ready')
  await choose('Stop ·'); await screen('Confirm stop'); check('Stop has a separate confirmation', rp.state.stops === 0)
  await choose('Confirm stop'); await screen('Stopped · compute ended'); check('Stop releases compute but retains the pod disk', rp.state.stops === 1 && rp.state.pods.has(id))
  await choose('Terminate'); await screen('Confirm terminate'); check('Terminate has a separate confirmation', rp.state.deletes === 0)
  await choose('Confirm terminate'); await screen('Pod terminated'); m.push(KEY.esc)
  check('terminated pod is verified absent', !readHostRecord(id) && !rp.state.pods.has(id))
  const stalled = { ...ready, id: 'fixture-stalled', name: 'fixture-stalled', jobState: 'running' as const, generation: 'stall-generation', step: 'building llama.cpp', advancedAt: Date.now() - 250, error: undefined }
  const { writeHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
  writeHostRecord(stalled)
  await sweepHostJobs({ stallMs: 100, alive: () => true }); deliverHostNotices('rental-session')
  check('stalled progress raises the notice within a scaled window', getCommandQueue().some(row => String(row.value).includes('fixture-stalled · setup stalled at building llama.cpp')))
  patchHostRecord(stalled.id, { generation: 'dead-generation', advancedAt: Date.now() }); await sweepHostJobs({ alive: () => false }); deliverHostNotices('rental-session')
  check('a vanished job reports stalled without waiting ten minutes', readHostRecord(stalled.id)?.jobState === 'failed' && getCommandQueue().filter(row => String(row.value).includes('fixture-stalled · setup stalled')).length === 2)
  removeHostRecord(stalled.id)
  config.failLaunch = true; save()
  open(); await screen('Where should the model run?'); await choose('Rent a GPU'); await screen('Optional spending budget'); m.push(KEY.enter); await screen('live Runpod stock'); await choose('UD-Q3_K_XL'); await screen('Confirm the hourly price'); await choose('Confirm $2.49/hr')
  check('failure rental recorded', await waitFor(() => hostRecords().length === 1, 15000))
  const failedId = hostRecords()[0]!.id; workers.add(failedId)
  check('outer launch failure is durable', await waitFor(() => readHostRecord(failedId)?.jobState === 'failed', 20000))
  await screen('launch.log'); await screen('Resume setup'); await capture('03-launch-failure')
  deliverHostNotices('rental-session')
  check('launch.log words reach both the pod view and the notice', getCommandQueue().some(row => String(row.value).includes('launch.log: fixture outer launch permission denied')))
  config.failLaunch = false; save(); await choose('Resume setup')
  check('explicit Resume completes the failed setup without another rental', await waitFor(() => readHostRecord(failedId)?.jobState === 'ready', 20000) && rp.state.creates === 2)
  await choose('Terminate'); await screen('Confirm terminate'); await choose('Confirm terminate'); await screen('Pod terminated')
  const calls = readFileSync(join(f.home, 'ssh-fixture-calls.jsonl'), 'utf8')
  check('API key never appears in command, URL, log, settings or pod record', !calls.includes(rp.key) && !JSON.stringify(rp.requests).includes(rp.key) && !JSON.stringify(settings).includes(rp.key) && !JSON.stringify(ready).includes(rp.key))
  console.log('HOST JOB DRIVE GREEN — ' + checks + ' checks; built daemon + project worker, real popup, live-shape REST fixture and SSH process shim; zero billable calls')
} finally {
  m?.unmount()
  for (const id of workers) await stopHostSetup(id)
  daemon?.kill('SIGTERM')
  if (daemon) await waitFor(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 15000)
  if (frames) writeFileSync(join(frames, 'daemon.log'), daemonLog)
  await settingsChangeDetector.dispose()
  await rp.close(); f.close()
}

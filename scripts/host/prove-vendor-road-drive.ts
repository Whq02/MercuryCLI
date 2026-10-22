import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
const rp = await runpodFixture()
const vast = await vastFixture()
const lambda = await lambdaFixture()
lambda.state.types.push({ name: 'gpu_1x_rtxpro6000', description: '1x RTX PRO 6000', gpu_description: 'NVIDIA RTX PRO 6000 Blackwell (96 GB)', price_cents_per_hour: 210, specs: { vcpus: 32, memory_gib: 256, storage_gib: 2000, gpus: 1 }, architecture: 'x86_64' })
const nativeFetch = globalThis.fetch
const escaped: string[] = []
let denyVastStock = false
let denyVastPods = false
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const base = ({ 'https://api.runpod.io': rp.baseUrl.replace('/v2', ''), 'https://console.vast.ai': vast.baseUrl.replace('/api/v0', ''), 'https://cloud.lambda.ai': lambda.baseUrl.replace('/api/v1', '') } as Record<string, string>)[url.origin]
  if (url.origin === 'https://console.vast.ai' && (denyVastStock && url.pathname === '/api/v0/bundles/' || denyVastPods && url.pathname === '/api/v0/instances/')) return Response.json({ error: 'fixture list unavailable' }, { status: 503 })
  if (base) return nativeFetch(new Request(base + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Vendor road proof only permits loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { hostRecords, readHostRecord } = await import('../../src/services/host/store.ts')
  const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const { namedCompatModelOptions } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  const { retuneHostEngine, defaultTune } = await import('../../src/services/host/tune.ts')
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  let fail = false
  const runner = { ...ssh.runner, run: async (...args: Parameters<typeof hostRunner.run>) => {
    if (fail && args[0] === 'ssh') throw new Error('fixture setup failure')
    if (args[0] === 'ssh' && args[1].at(-1)?.includes('nvidia-smi')) return 'NVIDIA RTX PRO 6000 Blackwell, 98304\nDOCKER_ENGINE_PRESENT\n'
    return ssh!.runner.run(...args)
  } }
  const jobs: Promise<void>[] = []
  const road = createHostRoad({ runner, pauseMs: 10, readyTimeoutMs: 1000, sessionId: 'vendor-road-proof', startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner, pauseMs: 10, timeoutMs: 2000, keepAlive: false })) } })
  let width = 120
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  const mount = async (columns: number) => {
    width = columns
    mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: 44 }, React.createElement(SettingsPopupSlot)))), columns, 44)
  }
  const until = async (needle: string) => assert.ok(await waitFor(() => mounted!.screen().includes(needle), 30000), 'screen reaches ' + needle + '\n' + mounted!.screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const select = async (needle: string) => {
    for (let n = 0; n < 50; n++) {
      const before = selected()
      if (before.includes(needle)) return
      mounted!.push(KEY.down)
      assert.ok(await waitFor(() => selected() !== before, 3000), 'selection reaches ' + needle + '\n' + mounted!.screen())
    }
    throw new Error('Choice not found: ' + needle)
  }
  const choose = async (needle: string) => { await select(needle); mounted!.push(KEY.enter) }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const capture = async (name: string) => {
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), mounted!.screen())
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: 44 }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  open(); await mount(120); await until('Which model?'); await choose('Qwen3.8-27B'); await until('WEIGHTS')
  check('WHERE offers every disconnected vendor, not just Runpod', ['Connect Runpod', 'Connect Vast.ai', 'Connect Lambda'].every(label => mounted!.screen().includes(label)))
  const { vendorClient, runpodOnly } = await import('../../src/services/host/vendors/client.ts')
  await capture('120-three-vendors')
  await close(); mounted!.unmount(); await mount(80)
  open(); await until('Which model?'); await choose('Qwen3.8-27B'); await until('WEIGHTS'); await capture('80-three-vendors')
  for (const [vendor, label, fixture] of [['vast', 'Vast.ai', vast], ['lambda', 'Lambda', lambda]] as const) {
    await choose('Connect ' + label); await until(label + ' API key'); mounted!.push(fixture.key); await until('********'); mounted!.push(KEY.enter)
    await until('Rent · ' + label); check(label + ' offers appear after key validation', mounted!.screen().includes('in stock'))
    await choose('Rent · ' + label); await until('Confirm the hourly price')
    await capture('80-' + vendor + '-confirmation')
    const confirmation = mounted!.screen().replace(/[│\s]+/g, ' ')
    check(label + ' confirms before creating', fixture.state.creates === 0 && confirmation.includes('Billing starts now.'))
    check(label + ' discloses key registration, storage and failure cleanup', confirmation.includes('SSH public key') && confirmation.includes('/workspace') && confirmation.includes('setup fails'))
    await choose('Confirm $'); await until('Pod controls')
    check(label + ' queues and reaches ready', await waitFor(() => hostRecords().some(record => record.vendor === vendor && record.jobState === 'ready'), 30000))
    const record = hostRecords().find(record => record.vendor === vendor)!
    check(label + ' registers its model', Boolean(record.provider) && configuredCompatEndpoints().some(endpoint => endpoint.name === record.provider) && namedCompatModelOptions().some(row => row.value === 'compat/' + record.provider + '/' + f.model))
    check(label + ' saved key routes reads through its own API', (await vendorClient(record).get(record.id)).id === record.id)
    assert.throws(() => runpodOnly(vendorClient(record), 'Fast-load weights disks'), /Runpod-only/)
    assert.throws(() => runpodOnly(vendorClient(record), 'Clusters'), /Runpod-only/)
    check(label + ' explicitly refuses Runpod-only reload, disks and clusters', (await retuneHostEngine(record, defaultTune(currentHostRecipes().find(row => row.id === record.recipe)!), runner)).words.includes('Runpod-only'))
    if (vendor === 'lambda') {
      check('Lambda offers no Stop', !mounted!.screen().includes('Stop ·'))
      check('Lambda waits for cloud-init and launches the recipe in Docker as ubuntu', record.target?.user === 'ubuntu' && ssh!.commands.some((row: any) => row.args?.at(-1)?.includes('cloud-init status --wait')) && ssh!.commands.some((row: any) => row.args?.at(-1)?.includes('docker run --rm --gpus all')))
    } else check('Vast uses direct root SSH', record.target?.user === 'root' && record.target?.port === 2222)
    await choose('Logs ·'); await until('Pod controls')
    if (vendor === 'vast') {
      check('Vast log tail uses its own vendor client', await waitFor(() => vast.requests.some((row: any) => row.path.includes('/request_logs/')), 5000))
      await choose('Stop ·'); await until('Confirm stop'); await choose('Confirm stop'); await until('Stopped · compute ended')
      check('Vast Stop retains the instance and verifies stopped state', vast.state.stops === 1 && vast.state.pods.size === 1 && readHostRecord(record.id)?.status === 'EXITED')
    }
    await close(); open(); await until('Which model?'); await choose('Pods I’m paying for'); await until(record.id)
    check('Paid pods names ' + label, mounted!.screen().includes(label))
    await choose(record.id); await until('Pod controls'); await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await until('Pod terminated')
    check(label + ' termination uses the right client and verifies absence', fixture.state.deletes === 1 && fixture.state.pods.size === 0 && !readHostRecord(record.id))
    await close(); open(); await until('Which model?'); await choose('Qwen3.8-27B'); await until('WEIGHTS')
  }
  fail = true
  await choose('Rent · Vast.ai'); await until('Confirm the hourly price'); await choose('Confirm $')
  check('Failed Vast setup is terminated through Vast', await waitFor(() => vast.state.deletes === 2 && vast.state.pods.size === 0, 15000))
  await Promise.all(jobs)
  check('Failed Vast setup leaves a truthful terminated receipt', hostRecords().some(row => row.vendor === 'vast' && row.status === 'TERMINATED' && row.error?.includes('verified absent')))
  await close(); open(); await until('Which model?'); await choose('Qwen3.8-27B'); await until('WEIGHTS')
  await choose('Connect Runpod'); await until('Runpod API key'); mounted!.push(rp.key); await until('********'); mounted!.push(KEY.enter)
  await until('Rent · Vast.ai'); await select('Rent · Runpod')
  check('Every connected vendor has a labelled WHERE rental row', ['Rent · Runpod', 'Rent · Vast.ai', 'Rent · Lambda'].every(label => mounted!.screen().includes(label)))
  await capture('80-connected-three-vendors')
  await close(); mounted!.unmount(); await mount(120)
  open(); await until('Which model?'); await choose('Qwen3.8-27B'); await until('Rent · Runpod'); await capture('120-connected-three-vendors')
  await close(); denyVastStock = true
  open(); await until('Which model?'); await choose('Qwen3.8-27B'); await until('WEIGHTS'); await until('Vast.ai stock could not be read')
  check('Unreadable Vast stock keeps the other rental rows', ['Rent · Runpod', 'Rent · Lambda'].every(label => mounted!.screen().includes(label)))
  await close(); denyVastStock = false; denyVastPods = true
  open(); await until('Which model?'); await until('Vast.ai paid machines could not be read')
  await choose('Pods I’m paying for'); await until('Live account list'); await until('Vast.ai paid machines could not be read')
  check('Unreadable paid list is named, not presented as a complete zero', mounted!.screen().includes('count incomplete'))
  await close(); denyVastPods = false
  open(); await until('Which model?'); await choose('Other roads'); await until('Where should the model run?'); await choose('Rent a GPU'); await until('Rent from which vendor?')
  check('Other roads offers the same three vendors', ['Runpod', 'Vast.ai', 'Lambda'].every(label => mounted!.screen().includes(label)))
  await choose('Lambda'); await until('Optional spending budget'); mounted!.push(KEY.enter); await until('live Lambda stock')
  check('Where-first Lambda stock is never labelled Runpod or Secure Cloud', !mounted!.screen().includes('Secure Cloud') && !mounted!.screen().includes('live Runpod stock'))
  await close()
  writeFileSync(join(f.home, 'host', 'pods', 'old-record.json'), JSON.stringify({ id: 'old-record', name: 'old', recipe: 'qwen38-27b-rtx-pro-6000', price: 1, startedAt: new Date().toISOString(), status: 'EXITED' }))
  check('Records without a vendor read as Runpod', readHostRecord('old-record')?.vendor === 'runpod')
  check('No Runpod create or cleanup is used for other vendors', rp.state.creates === 0 && rp.state.deletes === 0)
  check('All network requests stay on loopback fixtures', escaped.length === 0)
  console.log('VENDOR ROAD DRIVE GREEN — ' + checks + ' checks; real popup, Vast and Lambda fixtures, setup workers and model registration; zero billable calls')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); await vast.close(); await lambda.close(); f.close(); globalThis.fetch = nativeFetch }

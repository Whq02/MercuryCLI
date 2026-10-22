import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner, liveCatalogue } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
let checks = 0
const check = (name: string, truth: unknown): void => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const bundlePath = option('--bundle')
const f = await llmhostFixture()
const rp = await runpodFixture()
const { hostDirectory, hostRecords, patchHostRecord, readHostRecord, removeHostRecord, writeHostRecord } = await import('../../src/services/host/store.ts')
const { queueHostWatch, stopHostSetup, sweepHostJobs } = await import('../../src/services/host/jobs.ts')
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
const images: Promise<unknown>[] = []
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
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { deliverHostNotices } = await import('../../src/services/host/notices.ts')
  const { getCommandQueue, resetCommandQueue } = await import('../../src/utils/messageQueueManager.ts')

  f.state.dialect = 'llamacpp'; f.state.window = 524288; f.state.slots = 4
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const jobOptions = { runner: ssh.runner, pauseMs: 25, timeoutMs: 30_000, keepAlive: false }
  const road = createHostRoad({
    apiBaseUrl: rp.baseUrl,
    runner: ssh.runner,
    pauseMs: 25,
    readyTimeoutMs: 5000,
    sessionId: 'rental-session',
    startJob: record => { void runHostJob(record.id, record.generation!, jobOptions) },
  })
  const api = new RunpodClient(rp.key, rp.baseUrl)
  const posts = () => rp.requests.filter((r: any) => r.method === 'POST' && r.path === '/v2/pods').length
  const notices = () => { deliverHostNotices('rental-session'); return getCommandQueue().filter(row => row.mode === 'task-notification').map(row => String(row.value)) }
  const watchLog = (id: string) => { try { return readFileSync(join(hostDirectory(), 'logs', id + '.log'), 'utf8') } catch { return '' } }
  const watchRecord = (id: string, extra: Record<string, unknown> = {}) => queueHostWatch({ id, name: 'GLM-5.3-Flash · UD-Q4_K_XL', recipe: 'glm53-flash-gguf-b300', price: 8.99, maxPrice: 8.99, pollIntervalMs: 25, startedAt: new Date().toISOString(), status: 'WATCHING', sessionId: 'rental-session', workspace: process.cwd(), sshKey: join(hostDirectory(), 'keys', 'id_ed25519'), apiBaseUrl: rp.baseUrl, ...extra })
  const stockNow = () => { rp.state.noStock = false; rp.state.stockAfterReads = rp.state.catalogReads }
  const terminate = async (id: string) => { await stopHostSetup(id); await api.terminate(id); removeHostRecord(id) }
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  open()
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot)))), 120, 44)
  const m = mounted
  const until = async (needle: string) => assert.ok(await waitFor(() => m.screen().includes(needle), 15_000), 'screen reaches ' + needle + '\n' + m.screen())
  const heading = async (needle: string) => {
    if (needle === 'Where should the model run?') { await until('Which model?'); await choose('More options →') }
    assert.ok(await waitFor(() => m.lines().slice(0, 10).join(' ').includes(needle), 15_000), 'active question reaches ' + needle + '\n' + m.screen())
  }
  const selected = () => m.lines().find(line => line.includes('› ')) ?? ''
  const capture = (name: string) => {
    check(name + ' paints without errors or a key', !m.screen().includes('RENDER ERROR') && !m.screen().includes(rp.key))
    if (frames) {
      writeFileSync(join(frames, name + '.txt'), m.screen())
      const grid = m.lines().map((line, y) => Array.from(line.padEnd(120)).map((c, x) => { const style = m.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false } }))
      const path = join(frames, name + '.json')
      writeFileSync(path, JSON.stringify({ grid, cols: 120, rows: 44 }))
      images.push(gridToPng(path, join(frames, name + '.png')))
    }
  }
  const choose = async (needle: string) => {
    for (let n = 0; n < 40; n++) {
      const before = selected()
      if (before.includes(needle)) {
        m.push(KEY.enter)
        if (needle === 'Rent a GPU') {
          await heading('Rent from which vendor?')
          check('where-first rental offers all three vendors', ['Runpod', 'Vast.ai', 'Lambda'].every(label => m.screen().includes(label)))
          await choose('Runpod')
        }
        return
      }
      m.push(KEY.down)
      assert.ok(await waitFor(() => selected() !== before, 5000), 'selection moves toward ' + needle + '\n' + m.screen())
    }
    throw new Error('Missing choice ' + needle + '\n' + m.screen())
  }
  const text = async (title: string, value = '') => { await until(title); if (value) { m.push('\u0015'); m.push(value); await until(value) } m.push(KEY.enter) }
  const close = async () => { m.push(KEY.esc); if (!await waitFor(() => !popup.isSettingsPopupOpen(), 1000)) m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const rent = async () => { open(); await heading('Where should the model run?'); await choose('Rent a GPU'); await text('Optional spending budget', '70'); await heading('Choose a model · live Runpod stock') }

  const distinctModels = [...new Set(HOST_RECIPES.map(row => row.label.split(' · ')[0]!))]
  await heading('Which model?')
  await choose('Qwen3.8-27B'); await heading('Qwen3.8-27B'); await choose('Connect Runpod')
  await until('Runpod API key'); m.push(rp.key); await until('********'); m.push(KEY.enter)
  await heading('Qwen3.8-27B'); await choose('Back to models')
  await heading('Which model?')
  capture('01-model-list')

  const modelLabel = (name: string) => name.padEnd(Math.max(...distinctModels.map(name => name.length))) + ' · '
  const modelLines = m.lines().filter(line => distinctModels.some(name => line.includes(modelLabel(name))))
  check('model list shows one row per distinct model across recipes', modelLines.length === distinctModels.length && distinctModels.every(name => m.lines().filter(line => line.includes(modelLabel(name))).length === 1))
  check('model rows show cheapest in-stock price or no stock now', m.screen().includes(modelLabel('Nemotron 3.5 Super VL 120B') + 'Runpod 1× RTX PRO 6000 · $2.49/hr · in stock') && m.screen().includes(modelLabel('Qwen3.8-27B') + 'Runpod 1× RTX PRO 6000 · $2.49/hr · in stock') && m.screen().includes(modelLabel('GLM-5.3-Flash') + 'no stock · watch →'))
  const stamps = ['measured', 'documented', 'community']
  const ranks = modelLines.map(line => stamps.findIndex(stamp => line.includes(' · ' + stamp)))
  check('every model row carries one of the stamp words', ranks.every(rank => rank >= 0))
  check('stocked models sort before no-stock models and by price, whatever their stamp (the stamp only breaks ties)', (() => {
    const prices = modelLines.map(line => line.includes('no stock') ? Infinity : Number(/\$([\d.]+)\/hr/.exec(line)![1]))
    return prices.every((price, index) => !index || price >= prices[index - 1]!)
  })())
  check('cursor starts on the cheapest model in stock', selected().includes('in stock') && selected().includes('$2.49/hr'))
  check('a pre-chosen cursor says it starts on a suggestion, never that nothing is pre-chosen', m.screen().includes('↑↓ then ↵ · the cursor starts on a suggestion') && !m.screen().includes('nothing is pre-chosen'))

  rp.state.customGpus = [
    { ...liveCatalogue.gpus.find((g: any) => g.id === 'NVIDIA H200'), availability: 'HIGH', price: { secure: 5.29 } },
    { ...liveCatalogue.gpus.find((g: any) => g.id === 'NVIDIA B300 SXM6 AC'), availability: 'LOW', price: { secure: 8.99 } },
  ]
  await choose('Refresh stock and prices')
  await until('$5.29/hr')
  check('refresh keeps the design order: the cheapest model in stock leads, whatever its stamp', selected().includes('in stock') && selected().includes('$5.29/hr') && m.screen().includes('$8.99/hr'))
  rp.state.customGpus = null
  await choose('Refresh stock and prices')
  await until('$2.49/hr')

  await choose('Qwen3.8-27B'); await heading('Qwen3.8-27B'); await choose('Rent · Runpod')
  await heading('Confirm the hourly price')
  await until('1× RTX PRO 6000 · $2.49/hr')
  check('the model’s WHERE row opens confirm with the chosen shape named', !m.screen().includes('Choose a GPU shape') && m.screen().includes('1× RTX PRO 6000'))
  check('the price confirmation pre-chooses nothing and says so', m.screen().includes('↑↓ then ↵ · nothing is pre-chosen') && !selected())
  for (let n = 0; n < 5; n++) { const before = selected(); m.push(KEY.down); await waitFor(() => selected() !== before, 300) }
  check('pressing ↓ repeatedly on the price confirmation settles on keep things as they are, never back on Confirm', selected().includes('keep things as they are') && rp.state.creates === 0)
  m.push(KEY.enter)
  await close()

  const defaultWatch = queueHostWatch({ id: 'watch-defaults-probe', name: 'GLM-5.3-Flash', recipe: 'glm53-flash-gguf-b300', price: 8.99, startedAt: new Date().toISOString(), status: 'WATCHING' })
  check('watch job record states one catalogue read every 5 s (12 a minute) within Runpod’s per-account metering, and a 12h window', defaultWatch.jobKind === 'watch' && defaultWatch.pollIntervalMs === 5000 && defaultWatch.pollWindowMs === 12 * 3600_000 && defaultWatch.rateLimit === 'one catalogue read every 5 s (12 a minute) · Runpod meters each account per minute, hour and day' && !JSON.stringify(defaultWatch).includes('60/min'))
  await stopHostSetup(defaultWatch.id)
  removeHostRecord(defaultWatch.id)

  resetCommandQueue()
  await rent()
  await choose('GLM-5.3-Flash')
  await heading('Confirm the hourly price')
  await until('Watch for stock and rent at this price or less ($8.99/hr)')
  check('a model with no stock offers Watch for stock and rent at this price or less with the catalogue price ceiling', m.screen().includes('ceiling $8.99/hr (catalogue $8.99/hr)') && m.screen().includes('Watch for stock and rent at this price or less ($8.99/hr)'))

  await choose('Set a lower price ceiling')
  await text('Price ceiling in USD/hr', '8.99')
  await heading('Confirm the hourly price')
  await until('Watch for stock and rent at this price or less ($8.99/hr)')

  const readsBeforeWatch = rp.state.catalogReads
  let readsAtCreate = 0
  const origCreates = rp.state.creates
  rp.state.stockAfterReads = readsBeforeWatch + 2
  await choose('Watch for stock and rent at this price or less ($8.99/hr)')
  assert.ok(await waitFor(() => {
    if (rp.state.creates > origCreates && readsAtCreate === 0) readsAtCreate = rp.state.catalogReads
    return rp.state.creates === origCreates + 1
  }, 15_000), 'watch job creates the pod once stock appears')
  check('watch job polls catalogue and creates pod on the first read that shows stock without a second read', readsAtCreate === readsBeforeWatch + 3 && rp.state.catalogReads === readsBeforeWatch + 3)

  check('chat receives the rented notice with model, shape, price and data centre', await waitFor(() => notices().some(n => n.includes('Rented GLM-5.3-Flash · 1× B300 · $8.99/hr in EU-NL-1 · setting up')), 5000))
  assert.ok(await waitFor(() => readHostRecord('fixture-pod-1')?.jobState === 'ready', 15_000), 'setup job handed off from watch reaches ready')
  check('watch job hands off to normal setup job which reaches ready', readHostRecord('fixture-pod-1')?.jobState === 'ready' && readHostRecord('fixture-pod-1')?.jobKind === 'setup')
  await close()

  open()
  await heading('Where should the model run?'); await choose('fixture-pod-1')
  await heading('Pod controls'); await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await until('Pod terminated')
  await close()

  rp.state.stockAfterReads = 0
  rp.state.noStock = true
  await rent()
  await choose('GLM-5.3-Flash')
  await heading('Confirm the hourly price')
  const readsAtWatch2 = rp.state.catalogReads
  await choose('Watch for stock and rent at this price or less ($8.99/hr)')
  await heading('Pod controls')
  assert.ok(await waitFor(() => rp.state.catalogReads >= readsAtWatch2 + 2, 10_000), 'watch job polls while waiting')
  const waiting = hostRecords().find(row => row.jobKind === 'watch')!
  check('after a read, the watch record states the account’s quota from Runpod’s RateLimit-Policy header', await waitFor(() => readHostRecord(waiting.id)?.rateLimit === 'one catalogue read every 0.025 s (2400 a minute) · this account’s Runpod quota: 60 a minute, 3000 an hour, 50000 a day', 5000))
  await close()

  await rent()
  await choose('GLM-5.3-Flash')
  await until('A stock watch for GLM-5.3-Flash is already running · ' + waiting.id)
  const duplicate = queueHostWatch({ id: 'watch-duplicate-probe', name: 'GLM-5.3-Flash · UD-Q4_K_XL', recipe: 'glm53-flash-gguf-b300', price: 7, startedAt: new Date().toISOString(), status: 'WATCHING' })
  check('a second watch for a model already watched opens the running watch instead of starting another', m.screen().includes('Cancel · stop watching for stock') && duplicate.id === waiting.id && !readHostRecord('watch-duplicate-probe') && hostRecords().filter(row => row.jobKind === 'watch').length === 1)
  await close()

  open()
  await heading('Where should the model run?')
  await choose('Pods I’m paying for')
  await heading('Pods I’m paying for')
  await until('WATCHING ≤ $8.99/hr · Cancel')
  capture('02-watch-row')
  check('Pods I’m paying for shows the active watch as a row with Cancel while it waits', m.screen().includes('GLM-5.3-Flash · UD-Q4_K_XL') && m.screen().includes('WATCHING ≤ $8.99/hr · Cancel'))
  await choose('Cancel')
  await until('Stock watch cancelled · no pod was created.')
  const readsAtCancel = rp.state.catalogReads
  await delay(200)
  check('Cancel on the watch row stops the polling and fixture read count stops rising', rp.state.catalogReads === readsAtCancel && hostRecords().filter(r => r.jobKind === 'watch').length === 0 && rp.state.creates === 1)
  await close()

  rp.state.noStock = false
  rp.state.failCreate = true
  await rent()
  await choose('Qwen3.8-27B')
  await heading('Confirm the hourly price')
  const readsBeforeConfirm = rp.state.catalogReads
  const postsBeforeConfirm = posts()
  await choose('Confirm $2.49/hr')
  await heading('Choose a GPU shape · live Runpod stock')
  await until('Runpod could not place 1× RTX PRO 6000 · no pod was created')
  await until('Qwen3.8-27B · FP8 · 1× RTX PRO 6000 · $2.49/hr')
  check('confirm never re-reads stock before creating and a 400 refusal returns to fresh offers (one catalogue read per GPU count the single-machine rows ask: 1, 2, 4 and 8) with Runpod’s reason and no pod created', posts() === postsBeforeConfirm + 1 && rp.state.creates === 1 && rp.state.catalogReads === readsBeforeConfirm + 4 && m.screen().includes('Choose a GPU shape · live Runpod stock'))
  await close()

  rp.state.customGpus = [
    { ...liveCatalogue.gpus.find((g: any) => g.id === 'NVIDIA RTX PRO 6000 Blackwell Server Edition'), availability: 'HIGH' },
    { ...liveCatalogue.gpus.find((g: any) => g.id === 'NVIDIA H200'), availability: 'HIGH', price: { secure: 5.29 } },
  ]
  await rent()
  await choose('Nemotron 3.5 Super VL 120B')
  await heading('Choose a GPU shape')
  await choose('UD-Q3_K_XL')
  await heading('Confirm the hourly price')
  rp.state.customGpus = [{ ...liveCatalogue.gpus.find((g: any) => g.id === 'NVIDIA H200'), availability: 'HIGH', price: { secure: 5.29 } }]
  await choose('Confirm $2.49/hr')
  await heading('Choose a GPU shape · live Runpod stock')
  await until('Nemotron 3.5 Super VL 120B · no stock now')
  check('after a refusal the shape list shows only the chosen model’s shapes, and offers the watch when it has none', !m.screen().includes('Qwen3.8-27B') && !m.screen().includes('GLM-5.3 · FP8') && m.screen().includes('Watch for stock and rent at this price or less') && rp.state.creates === 1)
  rp.state.failCreate = false
  rp.state.customGpus = null
  await close()

  rp.state.createOutcomes = ['http503']
  await rent()
  await choose('Qwen3.8-27B')
  await heading('Confirm the hourly price')
  const postsBeforeAmbiguous = posts()
  await choose('Confirm $2.49/hr')
  const ambiguousName = await waitFor(() => rp.state.createBodies.length === 2, 10_000) ? rp.state.createBodies.at(-1).name : ''
  await until(ambiguousName + ' may exist; check Pods I’m paying for before retrying')
  check('a create Runpod answered with a 5xx says the pod may exist and points at Pods I’m paying for, never that no pod was created', !m.screen().includes('no pod was created') && !m.screen().includes('Choose a GPU shape') && posts() === postsBeforeAmbiguous + 1)
  await close()
  const ambiguousPod = [...rp.state.pods.values()].find((pod: any) => pod.name === ambiguousName)
  open()
  await heading('Where should the model run?'); await choose(ambiguousPod.id)
  await heading('Pod controls'); await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await until('Pod terminated')
  check('the pod the ambiguous create made is in the live Pods list and can be terminated', !rp.state.pods.has(ambiguousPod.id) && posts() === postsBeforeAmbiguous + 1)
  await close()

  resetCommandQueue()
  stockNow()
  rp.state.createOutcomes = ['refuse']
  const postsBeforeRefusal = posts()
  const createsBeforeRefusal = rp.state.creates
  const refusing = watchRecord('watch-refusal-probe')
  void runHostJob(refusing.id, refusing.generation!, jobOptions)
  assert.ok(await waitFor(() => hostRecords().some(row => row.watchedFrom === refusing.id && row.jobState === 'ready'), 15_000), 'the watch rents after a refused placement')
  const rentedAfterRefusal = hostRecords().find(row => row.watchedFrom === refusing.id)!
  check('a 400 placement refusal at create keeps the watch going and it rents on a later stocked read', posts() === postsBeforeRefusal + 2 && rp.state.creates === createsBeforeRefusal + 1 && watchLog(refusing.id).includes('Runpod could not place 1× B300 · $8.99/hr in EU-NL-1 · no pod was created · still watching · fixture: this GPU and data center combination could not be placed'))
  check('a pod rented by the watch is recorded like a door rental: SSH key, session, workspace, setup job', rentedAfterRefusal.jobKind === 'setup' && rentedAfterRefusal.sshKey === join(hostDirectory(), 'keys', 'id_ed25519') && rentedAfterRefusal.sessionId === 'rental-session' && rentedAfterRefusal.workspace === process.cwd() && rentedAfterRefusal.apiBaseUrl === rp.baseUrl && rentedAfterRefusal.recipe === 'glm53-flash-gguf-b300' && rentedAfterRefusal.price === 8.99)
  await terminate(rentedAfterRefusal.id)

  stockNow()
  rp.state.createOutcomes = ['lost']
  const postsBeforeLost = posts()
  const losing = watchRecord('watch-lost-probe')
  await runHostJob(losing.id, losing.generation!, jobOptions)
  const lostName = rp.state.createBodies.at(-1).name
  const lostRecord = readHostRecord(losing.id)
  await delay(300)
  check('a create whose answer is lost stops the watch with words that the pod may exist, and it never rents twice', lostRecord?.jobState === 'failed' && lostRecord.creating === lostName && String(lostRecord.error).startsWith(lostName + ' may exist: Runpod gave no clear answer to the create') && String(lostRecord.error).includes('/llmhost → Pods I’m paying for') && posts() === postsBeforeLost + 1)
  check('the may-exist words reach the renting session', notices().some(row => row.includes(lostName + ' may exist: Runpod gave no clear answer to the create')))
  const lostPod = [...rp.state.pods.values()].find((pod: any) => pod.name === lostName)
  await terminate(lostPod.id)
  removeHostRecord(losing.id)

  rp.state.noStock = true
  rp.state.catalogFailures = [503, 503, 429]
  const readsBeforeFailures = rp.state.catalogReads
  const backingOff = watchRecord('watch-backoff-probe')
  void runHostJob(backingOff.id, backingOff.generation!, jobOptions)
  assert.ok(await waitFor(() => rp.state.catalogReads >= readsBeforeFailures + 5, 15_000), 'the watch keeps reading after failed reads')
  const times = rp.state.catalogTimes.slice(readsBeforeFailures, readsBeforeFailures + 4)
  const gaps = times.slice(1).map((at: number, index: number) => at - times[index]!)
  check('failed reads back off (5xx doubles the wait, 429 waits its Retry-After) and the watch keeps watching', gaps[0]! >= 45 && gaps[1]! >= 90 && gaps[2]! >= 950 && readHostRecord(backingOff.id)?.jobState === 'running' && watchLog(backingOff.id).includes('Runpod read failed · next read in 1 s · Error: Runpod GET /catalog/gpus returned HTTP 429 · rate limit exceeded for the minute window'))
  await stopHostSetup(backingOff.id)
  removeHostRecord(backingOff.id)
  await delay(150)
  const readsAtStop = rp.state.catalogReads
  await delay(200)
  check('stopping the backed-off watch stops its reads', rp.state.catalogReads === readsAtStop)

  const expiring = watchRecord('watch-window-probe', { pollWindowMs: 2000 })
  await runHostJob(expiring.id, expiring.generation!, { runner: ssh.runner, pauseMs: 25, keepAlive: false })
  const expired = readHostRecord(expiring.id)
  check('the watch window ends with a stopped record and a notice that names the real window', expired?.jobState === 'stopped' && expired.status === 'EXPIRED' && expired.step === 'watch ended after 2 s without stock ≤ $8.99/hr · no pod was created' && notices().some(n => n.includes('GLM-5.3-Flash · UD-Q4_K_XL · watch ended after 2 s without stock ≤ $8.99/hr · no pod was created')))
  removeHostRecord(expiring.id)

  const gone = watchRecord('watch-sweep-gone')
  const inflight = queueHostWatch({ id: 'watch-sweep-inflight', name: 'DeepSeek-V4.1-Flash-1017', recipe: 'deepseek41-b200', price: 31.96, startedAt: new Date().toISOString(), status: 'WATCHING', sessionId: 'rental-session' })
  patchHostRecord(gone.id, { jobState: 'running' })
  patchHostRecord(inflight.id, { jobState: 'running', creating: 'mercury-sweep-inflight' })
  await sweepHostJobs({ alive: row => !row.id.startsWith('watch-sweep-') })
  check('a watch whose process ended is reported ended in watch words: no pod, or the pod it was creating may exist', readHostRecord(gone.id)?.error === 'stock watch stopped: its process ended · no pod was created · /llmhost → Rent a GPU to watch again' && readHostRecord(inflight.id)?.error === 'mercury-sweep-inflight may exist: the stock watch stopped while creating it · /llmhost → Pods I’m paying for' && notices().some(row => row.includes('GLM-5.3-Flash · UD-Q4_K_XL · stock watch stopped: its process ended · no pod was created · /llmhost → Rent a GPU to watch again')) && !notices().some(row => row.includes('watch-sweep') || row.includes('setup stalled at watching')))
  removeHostRecord(gone.id); removeHostRecord(inflight.id)

  stockNow()
  const createsBeforeRivals = rp.state.creates
  const first = watchRecord('watch-rival-a')
  writeHostRecord({ ...first, id: 'watch-rival-b', jobStartedAt: first.jobStartedAt! + 1, log: join(hostDirectory(), 'logs', 'watch-rival-b.log') })
  await Promise.all([runHostJob('watch-rival-b', first.generation!, jobOptions), runHostJob(first.id, first.generation!, jobOptions)])
  await delay(300)
  const rivalPods = hostRecords().filter(row => row.watchedFrom === first.id || row.watchedFrom === 'watch-rival-b')
  check('two watches for the same model never both buy: the later one ends and names the earlier', rp.state.creates === createsBeforeRivals + 1 && rivalPods.length === 1 && rivalPods[0]!.watchedFrom === first.id && readHostRecord('watch-rival-b')?.step === 'stock watch ended: watch-rival-a already watches GLM-5.3-Flash · no pod was created')
  await terminate(rivalPods[0]!.id)
  removeHostRecord('watch-rival-b')

  rp.state.noStock = false
  rp.state.stockAfterReads = 0
  rp.state.customGpus = [{ ...liveCatalogue.gpus.find((g: any) => g.id === 'NVIDIA H200'), availability: 'NONE' }]
  await rent()
  await choose('GLM-5.3-Flash')
  await heading('Confirm the hourly price')
  await until('no catalogue price now · set a price ceiling')
  check('a model with no catalogue price asks for a ceiling instead of inventing one', !m.screen().includes('Watch for stock and rent at this price or less (') && !m.screen().includes('$8.99'))
  await choose('Set a price ceiling')
  await text('Price ceiling in USD/hr', '7.5')
  await heading('Confirm the hourly price')
  await until('Watch for stock and rent at this price or less ($7.50/hr)')
  check('the entered ceiling is what the watch would rent at', m.screen().includes('ceiling $7.50/hr (no catalogue price now)'))
  await choose('keep things as they are')
  await close()
  rp.state.customGpus = null

  if (bundlePath) {
    const bundleText = readFileSync(resolve(bundlePath), 'utf8')
    check('built bundle carries model-first, watch-and-rent and money-safety words', ['Watch for stock and rent at this price or less', 'Choose a GPU shape · live Runpod stock', 'one catalogue read', ' per provider (', 'the cursor starts on a suggestion', ' may exist: ', ' gave no clear answer to the create'].every(part => bundleText.includes(part)))
  }

  await Promise.all(images)
  console.log('RENT MODEL FIRST DRIVE GREEN — ' + checks + ' checks; model-first picker, one-shape direct confirm, watch-and-rent handoff, cancel, one watch per model, refusal, ambiguous-create and backoff legs; zero billable calls')
} finally {
  mounted?.unmount()
  for (const record of hostRecords()) await stopHostSetup(record.id)
  ssh?.close()
  await rp.close()
  f.close()
}

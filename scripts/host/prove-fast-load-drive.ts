import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, truncateSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
assert.ok(currentHostRecipes().every(row => Number.isFinite(row.weightsGb) && row.weightsGb > 0), 'every recipe declares its measured weights size')
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const framesIndex = process.argv.indexOf('--frames')
const frames = framesIndex >= 0 ? process.argv[framesIndex + 1] : undefined
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
f.state.dialect = 'sglang'; f.state.window = 131072
process.env.HOME = f.home
const rp = await runpodFixture()
const originalFetch = globalThis.fetch
const external: string[] = []
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { external.push(url.origin); return Promise.reject(new Error('Proof refused off-loopback request')) }
  return originalFetch(input, init)
}) as typeof fetch
const jobs: Promise<void>[] = []
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const { settingsChangeDetector } = await import('../../src/utils/settings/changeDetector.ts')
  await settingsChangeDetector.initialize()
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const { hostRunner, ensureHostKey } = await import('../../src/services/host/ssh.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { readHostRecord, hostRecords, removeHostRecord } = await import('../../src/services/host/store.ts')
  const { queueHostSetup, queueHostWatch } = await import('../../src/services/host/jobs.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const volumes = await import('../../src/services/host/volumes.ts')
  const { fastLoadRecipes, fastLoadState, mirrorToVolume, volumeDeleteDoor } = await import('../../src/services/host/fastLoad.ts')
  const bankHome = join(f.home, 'mercury-model-bank')
  const { sizeWords } = await import('../../src/services/host/bank.ts')
  const { weightManifest, weightCheckScript, keptWeightsPath, keptDownloadMinutes } = await import('../../src/services/host/keptWeights.ts')
  writeStoredRunpodApiKey(rp.key)
  const api = new RunpodClient(rp.key, rp.baseUrl)
  const signal = new AbortController().signal
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const options = { apiBaseUrl: rp.baseUrl, runner: ssh.runner, sessionId: 'fast-load-proof', pauseMs: 5, readyTimeoutMs: 3000, startJob: (record: any) => { jobs.push(runHostJob(record.id, record.generation, { runner: ssh!.runner, pauseMs: 20, timeoutMs: 3000, keepAlive: false })) } }
  const road = createHostRoad(options)
  const table = currentHostRecipes()
  check('every shipped recipe has exact on-disk bytes from its pinned HF files', table.every(row => weightManifest(row).files.reduce((sum, file) => sum + file.size, 0) === Math.round(row.weightsGb * 1e9)))
  check('catalogue has one row for each model and weight variant, not duplicate GPU rows', fastLoadRecipes().length === new Set(table.map(volumes.volumeModel)).size)
  let catalogue: any
  await road(async q => { if (q.step === 'door-models') return 'other'; if (q.step === 'where') return 'fast-load'; if (q.step === 'door-bank-folder') return bankHome; catalogue = q; return null }, () => {}, signal)
  check('the Bank lists every known model with its size and no volume', catalogue.step === 'door-bank' && fastLoadRecipes().every(recipe => catalogue.rows.some((row: any) => row.value === recipe.id && row.label.includes(sizeWords(recipe.weightsGb)) && /—\s*$/.test(row.label))))
  check('opening or cancelling catalogue creates no disk and rents no pod', rp.state.volumeCreates === 0 && rp.state.creates === 0)
  rp.state.customGpus = [
    { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', name: 'RTX PRO 6000', memory: 96, secure: true, price: { secure: 2.49 }, maxCount: { secure: 8 }, availability: 'LOW', dataCenters: [{ id: 'EU-NL-1', availability: 'LOW' }] },
    { id: 'NVIDIA H200', name: 'H200', memory: 141, secure: true, price: { secure: 4.49 }, maxCount: { secure: 8 }, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] },
  ]
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  open()
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 160, height: 44 }, React.createElement(SettingsPopupSlot)))), 160, 44)
  const m = mounted
  const until = async (needle: string) => assert.ok(await waitFor(() => m.screen().includes(needle), 15000), 'screen reaches ' + needle + '\n' + m.screen())
  const heading = async (needle: string) => {
    if (needle.startsWith('Where should the model run')) { await until('Which model?'); await choose('More options →') }
    assert.ok(await waitFor(() => m.lines().slice(0, 4).join(' ').includes(needle), 15000), 'active screen reaches ' + needle + '\n' + m.screen())
  }
  const select = async (needle: string) => {
    for (let i = 0; i < 80; i++) {
      const selected = m.lines().find(line => line.includes('› ')) ?? ''
      if (selected.includes(needle)) return
      m.push(KEY.down)
      assert.ok(await waitFor(() => (m.lines().find(line => line.includes('› ')) ?? '') !== selected, 3000), 'selection moves toward ' + needle + '\n' + m.screen())
    }
    throw new Error('Missing choice ' + needle)
  }
  const focus = select
  const choose = async (needle: string) => { await select(needle); m.push(KEY.enter) }
  const close = async () => { m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const capture = async (name: string) => {
    check(name + ' renders without errors or secrets', !m.screen().includes('RENDER ERROR') && !m.screen().includes(rp.key))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), m.screen())
    const grid = m.lines().map((line, y) => Array.from(line.padEnd(160)).map((c, x) => { const s = m.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
    writeFileSync(join(frames, name + '.json'), JSON.stringify({ grid, cols: 160, rows: 44 }))
    await gridToPng(join(frames, name + '.json'), join(frames, name + '.png'))
  }
  await heading('Where should the model run?'); await choose('Bank · your weights'); await heading('Bank'); await capture('01-bank')
  await select('Qwen3.8-27B'); m.push('m'); await heading('How?'); await capture('02-per-model-how')
  check('per-model choice offers network, global and explicit SSH stub', m.screen().includes('network volume') && m.screen().includes('global volume (beta)') && m.screen().includes('mercury host'))
  await choose('network volume'); await heading('Where should'); await until('EU-NL-1')
  check('data centres come from catalogue and exclude non-standard-only storage', rp.requests.some((r: any) => r.path.endsWith('/catalog/datacenters')) && !m.screen().includes('HPS-ONLY'))
  await choose('EU-NL-1'); await heading('When should'); await choose('Prepare now'); await heading('Confirm weights disk')
  await capture('03-storage-confirm')
  check('price confirm names monthly charge, ongoing billing and cheapest temporary pod', m.screen().includes('$5.60/month') && m.screen().includes('whether or not a pod exists') && m.screen().includes('$2.49/hr') && rp.state.volumeCreates === 0 && rp.state.creates === 0)
  await choose('Confirm $5.60/month')
  assert.ok(await waitFor(() => volumes.keptVolumes().some(row => row.state === 'kept') && rp.state.deletes === 1, 15000), 'prepare job verifies weights and deletes temporary pod')
  const qwen = table.find(row => row.model === 'Qwen/Qwen3.8-27B-FP8')!
  const kept = volumes.keptVolumes().find(row => row.model === qwen.model)!
  check('prepare now creates one volume and only the cheapest fitting pod', rp.state.volumeCreates === 1 && rp.state.creates === 1 && rp.state.createBodies[0].gpu.id.includes('RTX PRO 6000') && rp.state.pods.size === 0)
  check('network attachment uses documented create-time mounts and no persistent disk', rp.state.createBodies[0].mounts.network[0].volumeId === kept.id && !rp.state.createBodies[0].mounts.persistent)
  rp.state.volumes.get(kept.id).size = 100
  await volumes.reconcileVolumes(api, signal)
  check('external disk resize updates its recorded monthly price', volumes.readKeptVolume(kept.id)?.price === 7 && volumes.volumeLabel(rp.state.volumes.get(kept.id)).includes('$7.00/month'))
  rp.state.volumes.get(kept.id).size = 80
  await volumes.reconcileVolumes(api, signal)
  check('worker records verified sums, sizes, fill pod and private record permissions', Boolean(kept.verifiedSums?.sha256) && kept.verifiedSums!.bytes === Math.round(qwen.weightsGb * 1e9) && kept.filledBy === 'fixture-pod-1' && (statSync(join(f.home, 'host/volumes', kept.id + '.json')).mode & 0o777) === 0o600)
  check('preparation does not build or start an inference engine', ssh.state.weightFetches === 1 && !ssh.commands.some((r: any) => r.args.at(-1)?.includes('nohup setsid')))
  await close(); open(); await heading('Where should the model run?'); await choose('Bank · your weights'); await heading('Bank'); await select('Qwen3.8-27B'); await until('✓ EU-NL-1'); await capture('04-kept-bank'); await close()
  open(); await heading('Where should the model run?'); await choose('Rent a GPU'); await heading('Rent from which vendor?'); await choose('Runpod'); await heading('Optional spending budget'); m.push(KEY.enter); await until('Qwen3.8-27B'); await choose('Qwen3.8-27B'); await heading('Choose a GPU shape'); await choose('RTX PRO 6000'); await heading('Confirm the hourly price'); await capture('05-kept-rental-confirm')
  check('rental confirm gives per-step short estimate and monthly disk charge', m.screen().includes('weights kept ~0') && m.screen().includes('loads ~3 min') && m.screen().includes('$5.60/month'))
  await choose('Confirm $2.49/hr'); assert.ok(await waitFor(() => readHostRecord('fixture-pod-2')?.jobState === 'ready', 15000), 'kept model reaches ready')
  check('kept rental reattaches same disk and skips weight fetch', rp.state.createBodies[1].mounts.network[0].volumeId === kept.id && ssh.state.weightFetches === 1)
  check('warm worker uses samples, records the method and shows it on the pod row', ssh.state.sampledChecks === 1 && readHostRecord('fixture-pod-2')?.weightsCheck === 'weights kept · sampled check passed' && volumes.readKeptVolume(kept.id)?.verifiedSums?.check === 'sampled')
  check('warm verification preserves the original filling pod and records the checker separately', volumes.readKeptVolume(kept.id)?.filledBy === 'fixture-pod-1' && volumes.readKeptVolume(kept.id)?.checkedBy === 'fixture-pod-2')
  check('engine runs from verified kept path', ssh.commands.some((r: any) => r.args.at(-1)?.includes('nohup setsid') && r.args.at(-1).includes(keptWeightsPath(qwen))))
  await heading('Pod controls'); await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await heading('Keep the weights disk'); await capture('06-terminate-weights')
  check('terminate does not delete pod or disk before keep-or-delete answer', rp.state.deletes === 1 && rp.state.volumeDeletes === 0)
  await choose('Keep the weights disk'); await until('Pod terminated'); check('keep terminates the pod while retaining the billed disk', rp.state.pods.size === 0 && rp.state.volumes.has(kept.id)); await close()
  open(); await until('Which model?'); await focus('Pods I’m paying for'); check('first-screen paid count includes a volume with no pod', m.screen().includes('Pods I’m paying for · 1')); await choose('Pods I’m paying for'); await until(kept.id); await choose(kept.id); await heading('Delete weights disk?')
  check('Delete warns that the next rental downloads again before removal', m.screen().includes('next rental downloads') && rp.state.volumeDeletes === 0)
  await choose('Cancel'); await close(); check('cancelled Delete leaves the disk intact', rp.state.volumes.has(kept.id))
  open(); await until('Which model?'); await choose('Pods I’m paying for'); await until(kept.id); await choose(kept.id); await heading('Delete weights disk?'); await choose('Confirm Delete'); await until('Weights disk deleted'); await close()
  check('confirmed Delete removes and verifies the live disk', !rp.state.volumes.has(kept.id) && rp.state.volumeDeletes === 1 && volumes.readKeptVolume(kept.id)?.state === 'gone')
  const nemotron = table.find(row => row.id === 'nemotron35-super-gguf-rtx-pro-6000')!
  let nextConfirm: any
  await mirrorToVolume(api, fastLoadRecipes().find(row => row.model === nemotron.model)!, async q => {
    if (q.step === 'fast-load-how') return 'global'
    if (q.step === 'fast-load-when') return 'next'
    if (q.step === 'fast-load-confirm') { nextConfirm = q; return 'confirm' }
    throw new Error('Unexpected step ' + q.step)
  }, () => {}, signal, options)
  const global = volumes.keptVolumes().find(row => row.model === nemotron.model)!
  check('next-rental opt-in creates elastic global volume without renting now', rp.state.creates === 2 && global.kind === 'global' && Object.keys(rp.state.volumeBodies.at(-1)).join(',') === 'name')
  check('global confirm says estimated usage, IOPS and billing without a pod', nextConfirm.found.includes('estimated usage') && nextConfirm.title.includes('+ IOPS') && nextConfirm.willRun.includes('whether or not a pod exists'))
  const offer = (await api.offers(signal)).find(row => row.recipe.id === nemotron.id)!
  const sshKey = await ensureHostKey(ssh.runner, signal)
  const pod = await api.create(offer, sshKey.publicKey, 'fixture-global-rental', global)
  check('global mounts use the documented volumeId/path array and no persistent disk', rp.state.createBodies.at(-1).mounts.global[0].volumeId === global.id && !rp.state.createBodies.at(-1).mounts.persistent)
  const globalRecord = queueHostSetup({ id: pod.id, name: pod.name, recipe: nemotron.id, price: offer.price, status: pod.status, startedAt: pod.createdAt, sshKey: sshKey.path, apiBaseUrl: rp.baseUrl, volumeId: global.id, prepareWeightsOnly: true })
  await runHostJob(globalRecord.id, globalRecord.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 3000, keepAlive: false })
  check('next rental fills the opted-in global disk', volumes.readKeptVolume(global.id)?.state === 'kept')
  rp.state.volumes.delete(global.id)
  await volumes.reconcileVolumes(api, signal)
  check('external deletion reconciles to gone and never trusts old sums', fastLoadState(nemotron) === 'not kept · disk gone' && !volumes.readKeptVolume(global.id)?.verifiedSums)
  const gguf = table.find(row => row.id === 'glm53-flash-gguf-b300')!
  for (const outcome of ['lost', 'http503']) {
    rp.state.volumeOutcomes.push(outcome)
    await assert.rejects(volumes.createKeptVolume(api, gguf, 'global', 'any DC', signal), /may exist and bill/)
    const before = rp.state.volumeCreates
    await volumes.reconcileVolumes(api, signal)
    const reconciled = volumes.keptVolumes().find(row => row.model === gguf.model && row.state !== 'gone')!
    check(outcome + ' create reconciles once without claiming nothing was created', reconciled.state === 'preparing' && rp.state.volumeCreates === before)
    await volumes.deleteKeptVolume(api, reconciled.id)
  }
  rp.state.volumeOutcomes.push('drop')
  await assert.rejects(volumes.createKeptVolume(api, gguf, 'global', 'any DC', signal), /may exist and bill/)
  const dropped = volumes.keptVolumes().find(row => row.model === gguf.model && row.state === 'creating')!
  await volumes.reconcileVolumes(api, signal)
  await assert.rejects(volumes.rentalVolume(api, gguf, signal), /may exist/)
  check('an unanswered create that Runpod does not list yet still blocks a second create and the rental', volumes.readKeptVolume(dropped.id)?.state === 'creating' && fastLoadState(gguf).includes('may exist and bill'))
  volumes.writeKeptVolume({ ...dropped, createdAt: new Date(Date.now() - 11 * 60_000).toISOString() })
  await volumes.reconcileVolumes(api, signal)
  check('ten minutes on, a create Runpod never listed is resolved and no longer blocks renting that model', volumes.readKeptVolume(dropped.id)?.state === 'gone' && volumes.readKeptVolume(dropped.id)?.error === 'Runpod never listed ' + dropped.name + '; no disk was created' && fastLoadState(gguf).startsWith('not kept') && await volumes.rentalVolume(api, gguf, signal) === undefined)
  rp.state.volumes.set('late-volume', { id: 'late-volume', name: dropped.name, createdAt: new Date().toISOString(), kind: 'global' })
  await volumes.reconcileVolumes(api, signal)
  check('a disk that appears after it was given up is adopted by name and shown as billed again', volumes.readKeptVolume('late-volume')?.state === 'preparing' && !volumes.readKeptVolume(dropped.id) && volumes.volumeLabel(rp.state.volumes.get('late-volume')).includes('weights disk'))
  await volumes.deleteKeptVolume(api, 'late-volume')
  rp.state.volumes.set('external-disk', { id: 'external-disk', name: 'External', size: 80, dataCenter: 'EU-NL-1', type: 'STANDARD', kind: 'network' })
  const deletes = rp.state.volumeDeletes
  const externalDisk = await volumeDeleteDoor(api, 'external-disk', async () => { throw new Error('External disks must not offer Delete') }, signal)
  check('outside volumes show monthly price and remain read-only', externalDisk.words.includes('read-only') && volumes.volumeLabel(rp.state.volumes.get('external-disk')).includes('$5.60/month') && rp.state.volumeDeletes === deletes)
  rp.state.volumePageSize = 1
  rp.state.volumes.set('external-disk-2', { ...rp.state.volumes.get('external-disk'), id: 'external-disk-2' })
  check('live volume listing follows pagination', (await api.volumes()).length === 2)
  rp.state.repeatVolumeCursor = true
  await assert.rejects(api.volumes(), /pagination is incomplete/)
  check('repeated cursors cannot silently undercount billed disks', true)
  rp.state.repeatVolumeCursor = false; rp.state.volumePageSize = 100
  const failVolume = await volumes.createKeptVolume(api, qwen, 'network', 'EU-NL-1', signal)
  const failOffer = (await api.offers(signal)).find(row => row.recipe.id === qwen.id)!
  const failPod = await api.create(failOffer, sshKey.publicKey, 'fixture-ssh-failure', failVolume)
  const failed = queueHostSetup({ id: failPod.id, name: failPod.name, recipe: qwen.id, price: failOffer.price, startedAt: failPod.createdAt, status: failPod.status, apiBaseUrl: rp.baseUrl, sshKey: sshKey.path, volumeId: failVolume.id, prepareWeightsOnly: true })
  ssh.state.refuse = true
  await runHostJob(failed.id, failed.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: vshotBudgetMs(60), keepAlive: false })
  ssh.state.refuse = false
  check('prepare-only failure before SSH terminates its temporary billed pod', !rp.state.pods.has(failPod.id) && !readHostRecord(failPod.id) && volumes.readKeptVolume(failVolume.id)?.state === 'failed')
  const watch = queueHostWatch({ id: 'watch-kept', name: qwen.label, recipe: qwen.id, price: 5, maxPrice: 5, startedAt: new Date().toISOString(), status: 'WATCHING', apiBaseUrl: rp.baseUrl, sessionId: 'fast-load-proof' })
  await runHostJob(watch.id, watch.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 3000, keepAlive: false })
  const watched = hostRecords().find(row => row.watchedFrom === watch.id)!
  check('stock-watch rental carries the opted-in volume through setup', watched?.volumeId === failVolume.id && watched.jobState === 'ready' && rp.state.createBodies.at(-1).mounts.network[0].volumeId === failVolume.id)
  let deleteAsked = false
  const bothDeleted = await road(async q => {
    if (q.step === 'door-models') return 'other'; if (q.step === 'where') return 'pod:' + watched.id
    if (q.step === 'pod-controls') return 'terminate'
    if (q.step === 'pod-confirm') return 'terminate'
    if (q.step === 'terminate-weights') { deleteAsked = true; return 'delete' }
    throw new Error('Unexpected termination step ' + q.step)
  }, () => {}, signal)
  check('terminate Delete removes both resources after an explicit disk answer', bothDeleted.ok && deleteAsked && !rp.state.pods.has(watched.id) && !rp.state.volumes.has(failVolume.id))
  const shared = await volumes.createKeptVolume(api, qwen, 'global', 'any DC', signal)
  const sharedPod = await api.create(failOffer, sshKey.publicKey, 'fixture-shared-one', shared)
  const otherPod = await api.create(failOffer, sshKey.publicKey, 'fixture-shared-two', shared)
  let liveMountAsked = false
  const failedDelete = await road(async q => {
    if (q.step === 'door-models') return 'other'; if (q.step === 'where') return 'pod:' + sharedPod.id
    if (q.step === 'pod-controls') return 'terminate'
    if (q.step === 'pod-confirm') return 'terminate'
    if (q.step === 'terminate-weights') { liveMountAsked = true; return 'delete' }
    throw new Error('Unexpected shared-volume step ' + q.step)
  }, () => {}, signal)
  check('lost local pod record still asks about the owned disk using live mounts', liveMountAsked)
  check('disk delete refusal reports pod gone and surviving billed disk, never pod still running', !failedDelete.ok && failedDelete.words.includes('Pod terminated') && failedDelete.words.includes('may still bill') && !rp.state.pods.has(sharedPod.id) && rp.state.volumes.has(shared.id))
  const deletesBeforeMounted = rp.state.volumeDeletes
  const mountedDelete = await volumeDeleteDoor(api, shared.id, async q => q.step === 'volume-delete' ? 'delete' : null, signal)
  check('Delete on a disk a pod still mounts names that pod, says terminate it first and that nothing was deleted', !mountedDelete.ok && mountedDelete.words.startsWith('Runpod refused to delete ' + shared.id + ' while ' + otherPod.id + ' (') && mountedDelete.words.includes('still mounts it; terminate that pod first (a stopped pod still counts).') && mountedDelete.words.includes('Nothing was deleted; the disk still bills ~$') && rp.state.volumes.has(shared.id) && rp.state.volumeDeletes === deletesBeforeMounted && volumes.readKeptVolume(shared.id)?.state !== 'gone')
  rp.state.failVolumeDelete = true
  const unclearDelete = await volumeDeleteDoor(api, shared.id, async q => q.step === 'volume-delete' ? 'delete' : null, signal)
  rp.state.failVolumeDelete = false
  check('a delete without a clear answer says the disk may still exist and bill, and keeps its record', !unclearDelete.ok && unclearDelete.words.startsWith('Runpod gave no clear answer to deleting ' + shared.id + '; it may still exist and bill') && volumes.readKeptVolume(shared.id)?.state !== 'gone')
  const cleanupFailure = queueHostSetup({ id: otherPod.id, name: otherPod.name, recipe: qwen.id, price: failOffer.price, startedAt: otherPod.createdAt, status: otherPod.status, apiBaseUrl: rp.baseUrl, sshKey: sshKey.path, volumeId: shared.id, prepareWeightsOnly: true })
  ssh.state.refuse = true; rp.state.failDelete = true
  await runHostJob(cleanupFailure.id, cleanupFailure.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: vshotBudgetMs(60), keepAlive: false })
  check('failed cleanup keeps the billed pod id and names it in durable error words', readHostRecord(otherPod.id)?.error?.includes(otherPod.id + ' may still bill') && rp.state.pods.has(otherPod.id))
  ssh.state.refuse = false; rp.state.failDelete = false
  await api.terminate(otherPod.id); removeHostRecord(otherPod.id)
  const deleteWords: string[] = []
  const retriedDelete = await volumeDeleteDoor(api, shared.id, async q => { if (q.step !== 'volume-delete') return null; rp.state.failNext = { route: 'GET /v2/network-volumes', status: 503, times: 2 }; return 'delete' }, signal, event => deleteWords.push(event.words), 20000)
  check('a delete whose listing hiccups twice says it is waiting, retries with words, and still verifies the disk gone', retriedDelete.ok && retriedDelete.words === 'Weights disk deleted · next rental downloads the weights again.' && deleteWords[0] === shared.id + ' · deleting · waiting for Runpod to drop it from the volume list' && deleteWords.filter(words => /Runpod read failed \(HTTP 503\) · retrying in \d+ s · attempt [12]/.test(words)).length === 2 && rp.state.failNext.times === 0 && volumes.readKeptVolume(shared.id)?.state === 'gone' && !rp.state.volumes.has(shared.id))
  rp.state.failNext = null
  const unconfirmedDisk = await volumes.createKeptVolume(api, qwen, 'global', 'any DC', signal)
  const unconfirmedDelete = await volumeDeleteDoor(api, unconfirmedDisk.id, async q => { if (q.step !== 'volume-delete') return null; rp.state.failNext = { route: 'GET /v2/network-volumes', status: 503, times: 1000 }; return 'delete' }, signal, () => {}, 300)
  rp.state.failNext = null
  check('a delete whose listing never answers says the deletion was sent but not confirmed, that the disk may still bill, and keeps its record', !unconfirmedDelete.ok && unconfirmedDelete.words.startsWith('Deletion of ' + unconfirmedDisk.id + ' was sent, but Runpod did not confirm the disk is gone: ') && unconfirmedDelete.words.includes('it may still bill') && unconfirmedDelete.words.includes('refresh Pods I’m paying for') && volumes.readKeptVolume(unconfirmedDisk.id)?.state !== 'gone' && !rp.state.volumes.has(unconfirmedDisk.id))
  await volumes.deleteKeptVolume(api, unconfirmedDisk.id)
  const beforeStub = { disks: rp.state.volumeCreates, pods: rp.state.creates, commands: ssh.commands.length }
  await mirrorToVolume(api, fastLoadRecipes().find(row => row.model === qwen.model)!, async q => {
    if (q.step === 'fast-load-how') return 'ssh'
    throw new Error('SSH bank stub must not invent another step')
  }, () => {}, signal, options)
  check('own SSH bank choice is only a named road, with no copy or billed action', rp.state.volumeCreates === beforeStub.disks && rp.state.creates === beforeStub.pods && ssh.commands.length === beforeStub.commands)
  const createsBeforeRace = rp.state.volumeCreates
  const simultaneous = await Promise.allSettled([volumes.createKeptVolume(api, qwen, 'global', 'any DC', signal), volumes.createKeptVolume(api, qwen, 'global', 'any DC', signal)])
  check('simultaneous confirms cannot buy two weights disks for one model', simultaneous.filter(row => row.status === 'fulfilled').length === 1 && rp.state.volumeCreates === createsBeforeRace + 1)
  const winner = simultaneous.find(row => row.status === 'fulfilled')!
  if (winner.status === 'fulfilled') {
    const seedPod = await api.create(failOffer, sshKey.publicKey, 'fixture-verify-seed', winner.value)
    const seedJob = queueHostSetup({ id: seedPod.id, name: seedPod.name, recipe: qwen.id, price: failOffer.price, status: seedPod.status, startedAt: seedPod.createdAt, apiBaseUrl: rp.baseUrl, sshKey: sshKey.path, volumeId: winner.value.id, prepareWeightsOnly: true })
    await runHostJob(seedJob.id, seedJob.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 3000, keepAlive: false })
    const fullBefore = ssh.state.fullChecks
    const podsBefore = rp.state.creates
    await mirrorToVolume(api, fastLoadRecipes().find(row => row.model === qwen.model)!, async q => {
      if (q.step === 'fast-load-kept') return 'verify'
      if (q.step === 'fast-load-verify-confirm') { check('Verify fully asks a separate temporary-pod price before creating it', q.willRun.includes('$2.49/hr') && rp.state.creates === podsBefore); return 'verify' }
      throw new Error('Unexpected full verification step ' + q.step)
    }, () => {}, signal, options)
    await Promise.all(jobs)
    check('explicit full verification performs full check and terminates its temporary pod', ssh.state.fullChecks === fullBefore + 1 && volumes.readKeptVolume(winner.value.id)?.verifiedSums?.check === 'full' && rp.state.pods.size === 0)
    const keptBefore = volumes.readKeptVolume(winner.value.id)!
    const fetchesBefore = ssh.state.weightFetches
    const transportPod = await api.create(failOffer, sshKey.publicKey, 'fixture-transport', winner.value)
    const transportJob = queueHostSetup({ id: transportPod.id, name: transportPod.name, recipe: qwen.id, price: failOffer.price, status: transportPod.status, startedAt: transportPod.createdAt, apiBaseUrl: rp.baseUrl, sshKey: sshKey.path, volumeId: winner.value.id, prepareWeightsOnly: true, sessionId: 'fast-load-proof' })
    ssh.state.checkTransport = true
    await runHostJob(transportJob.id, transportJob.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 3000, keepAlive: false })
    ssh.state.checkTransport = false
    const keptAfter = volumes.readKeptVolume(winner.value.id)!
    check('a dropped SSH connection during a warm check neither downloads again nor discards the verified disk', keptAfter.state === 'kept' && keptAfter.verifiedSums?.sha256 === keptBefore.verifiedSums?.sha256 && ssh.state.weightFetches === fetchesBefore && !rp.state.pods.has(transportPod.id))
    await volumes.deleteKeptVolume(api, winner.value.id)
  }
  const stallBefore = { creates: rp.state.creates, fetches: ssh.state.weightFetches }
  ssh.state.weights.delete(keptWeightsPath(nemotron))
  ssh.state.stallDownload = 11.2e9
  await mirrorToVolume(api, fastLoadRecipes().find(row => row.model === nemotron.model)!, async q => {
    if (q.step === 'fast-load-how') return 'network'
    if (q.step === 'fast-load-where') return 'EU-NL-1'
    if (q.step === 'fast-load-when') return 'now'
    if (q.step === 'fast-load-confirm') { check('prepare-now confirm states the stall and deadline bound before any disk or pod exists', q.willRun.includes('A stalled download (under 1 GB in 10 min) or one past ' + keptDownloadMinutes(nemotron) + ' min also terminates the pod and keeps the partial disk') && rp.state.creates === stallBefore.creates); return 'confirm' }
    throw new Error('Unexpected stall step ' + q.step)
  }, () => {}, signal, options)
  await Promise.all(jobs)
  ssh.state.stallDownload = 0
  const stalled = volumes.keptVolumes().find(row => row.model === nemotron.model && row.state !== 'gone')!
  const stallPodId = 'fixture-pod-' + rp.state.creates
  check('a stalled download marks the kept disk failed with its partial bytes and the stall words', stalled?.state === 'failed' && stalled.partialBytes === 11.2e9 && stalled.error === 'Download stalled at 11.20 GB of ' + (nemotron.weightsGb * 1e9 / 1e9).toFixed(2) + ' GB (under 1 GB in 10 min)')
  const deleteAt = rp.requests.findIndex((r: any) => r.method === 'DELETE' && r.path === '/v2/pods/' + stallPodId)
  check('the stalled temporary pod is terminated and the live list is read back before it counts as gone', rp.state.creates === stallBefore.creates + 1 && deleteAt >= 0 && rp.requests.slice(deleteAt + 1).some((r: any) => r.method === 'GET' && r.path === '/v2/pods') && !rp.state.pods.has(stallPodId) && !readHostRecord(stallPodId) && ssh.state.weightFetches === stallBefore.fetches)
  const notices = readdirSync(join(f.home, 'host/notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(f.home, 'host/notices', name), 'utf8')).words as string)
  check('the stall notice names the stall, the verified termination and the half-filled disk price', notices.some(words => words.includes('preparation stopped: Download stalled at 11.20 GB of ' + (nemotron.weightsGb * 1e9 / 1e9).toFixed(2) + ' GB') && words.includes('temporary pod ' + stallPodId + ' terminated') && words.includes('with 11.20 GB downloaded') && words.includes('$8.40/month for its 120 GB')))
  check('catalogue and paid list show the failed partial disk and its monthly price', fastLoadState(nemotron).startsWith('failed · ' + stalled.id) && fastLoadState(nemotron).includes('$8.40/month for its 120 GB') && volumes.volumeLabel(rp.state.volumes.get(stalled.id)).includes('failed · 11.20 GB downloaded'))
  check('a finished preparation leaves a notice naming the kept disk and the terminated pod', notices.some(words => words.includes('weights kept on ' + kept.id) && words.includes('temporary pod fixture-pod-1 terminated')))
  await volumes.deleteKeptVolume(api, stalled.id)
  const watchDisk = await volumes.createKeptVolume(api, qwen, 'network', 'EU-NL-1', signal)
  const stocked = rp.state.customGpus
  rp.state.customGpus = [{ ...stocked[1], availability: 'HIGH', dataCenters: [{ id: 'US-CA-2', availability: 'HIGH' }] }]
  const elsewhere = queueHostWatch({ id: 'watch-elsewhere', name: qwen.label, recipe: qwen.id, price: 5, maxPrice: 5, startedAt: new Date().toISOString(), status: 'WATCHING', apiBaseUrl: rp.baseUrl, sessionId: 'fast-load-proof' })
  const createsBeforeWatch = rp.state.creates
  const watching = runHostJob(elsewhere.id, elsewhere.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 15000, keepAlive: false })
  const outsideSeen = await waitFor(() => readHostRecord(elsewhere.id)?.step?.startsWith('stock only in US-CA-2 · weights disk ' + watchDisk.id + ' lives in EU-NL-1') ?? false, 4000)
  check('a watch whose network disk lives elsewhere says where the stock is and announces no pod there', outsideSeen && rp.state.creates === createsBeforeWatch && !readHostRecord(elsewhere.id)?.creating)
  check('the watch prefers its own shape, which here has stock only outside the disk’s data centre', readHostRecord(elsewhere.id)?.recipe === 'qwen38-27b-h200')
  rp.state.failVolumeRead = true
  const backedOff = await waitFor(() => readHostRecord(elsewhere.id)?.step?.startsWith('weights disk not ready · next read in') ?? false, 4000)
  check('a volume-list outage during a watch backs off and keeps watching instead of ending it', backedOff && readHostRecord(elsewhere.id)?.jobState === 'running' && rp.state.creates === createsBeforeWatch)
  rp.state.failVolumeRead = false
  rp.state.customGpus = [rp.state.customGpus[0], { ...stocked[0], availability: 'LOW', dataCenters: [{ id: 'EU-NL-1', availability: 'LOW' }] }]
  await watching
  const rentedHere = hostRecords().find(row => row.watchedFrom === elsewhere.id)!
  const rentedNotices = readdirSync(join(f.home, 'host/notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(f.home, 'host/notices', name), 'utf8')).words as string)
  check('the watch rents in the disk’s data centre and its rented words name the shape and price it bought', rentedHere?.volumeId === watchDisk.id && rp.state.createBodies.at(-1).dataCenterIds[0] === 'EU-NL-1' && rp.state.createBodies.at(-1).gpu.id === 'NVIDIA RTX PRO 6000 Blackwell Server Edition' && rentedNotices.some(words => words.includes('Rented Qwen3.8-27B · 1× RTX PRO 6000 · $2.49/hr in EU-NL-1')) && !rentedNotices.some(words => words.includes('Rented Qwen3.8-27B · 1× H200 · $4.49/hr in US-CA-2')))
  rp.state.customGpus = stocked
  await api.terminate(rentedHere.id); removeHostRecord(rentedHere.id)
  await volumes.deleteKeptVolume(api, watchDisk.id)
  const tiny = join(f.home, 'tiny-weights'); mkdirSync(tiny)
  const bytes = Buffer.from('verified weights')
  writeFileSync(join(tiny, 'model.gguf'), bytes)
  const manifest = { model: 'fixture/tiny', include: '', revision: 'd'.repeat(40), files: [{ path: 'model.gguf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
  const verify = (options: { fully?: boolean; sampleManifestSha256?: string } = {}) => spawnSync('python3', ['-c', weightCheckScript(manifest, tiny, false, options)], { encoding: 'utf8' })
  const firstCheck = verify()
  check('real verification executes SHA256 and writes sizes plus SHA256SUMS', firstCheck.status === 0 && readFileSync(join(tiny, 'SHA256SUMS'), 'utf8').includes(manifest.files[0]!.sha256) && JSON.parse(readFileSync(join(tiny, 'SIZES.json'), 'utf8'))[0][1] === bytes.length)
  const firstReceipt = JSON.parse(firstCheck.stdout.split('\n').find(line => line.startsWith('MERCURY_WEIGHTS '))!.slice('MERCURY_WEIGHTS '.length))
  const sampleOptions = { sampleManifestSha256: firstReceipt.sampleManifestSha256 }
  const warmCheck = verify(sampleOptions)
  check('real warm check uses size, mtime and recorded block samples without full hashing', warmCheck.status === 0 && warmCheck.stdout.includes('sampled check passed') && !warmCheck.stdout.includes('full check running'))
  const sampleManifest = JSON.parse(readFileSync(join(tiny, 'SAMPLES.json'), 'utf8'))
  check('sample manifest records first/last 64 MB, eight 1 MB blocks, fixed seed and mtimes', sampleManifest.headTailBytes === 64 * 1024 * 1024 && sampleManifest.blockBytes === 1024 * 1024 && sampleManifest.blocks === 8 && sampleManifest.seed === 40 && typeof sampleManifest.samples[0].mtimeNs === 'string')
  check('Verify fully bypasses matching samples and reports the full check', verify({ ...sampleOptions, fully: true }).stdout.includes('full check running'))
  unlinkSync(join(tiny, 'SAMPLES.json'))
  check('missing sample manifest falls back to full verification without a download', verify(sampleOptions).stdout.includes('full check running'))
  writeFileSync(join(tiny, 'model.gguf'), Buffer.alloc(bytes.length, 1))
  check('same-size corruption triggers full verification and is rejected', verify(sampleOptions).status !== 0 && verify(sampleOptions).stdout.includes('full check running'))
  unlinkSync(join(tiny, 'model.gguf'))
  check('missing shard is rejected rather than trusting an old SHA256SUMS', verify().status !== 0)
  const fakeHub = join(f.home, 'fake-hub', 'huggingface_hub'); mkdirSync(fakeHub, { recursive: true })
  writeFileSync(join(fakeHub, '__init__.py'), ['import os, pathlib, time', 'def snapshot_download(repo_id, revision, allow_patterns, local_dir, force_download):', '    root = pathlib.Path(local_dir)', "    if os.environ['FAKE_HF_MODE'] == 'stall':", "        with open(root / 'partial.incomplete', 'wb') as out:", "            out.write(b'x' * 4096)", '        time.sleep(30)', '        return str(root)', "    source = pathlib.Path(os.environ['FAKE_HF_SOURCE'])", '    for name in allow_patterns:', '        data = (source / name).read_bytes()', "        with open(root / name, 'wb') as out:", '            for start in range(0, len(data), 2048):', '                out.write(data[start:start + 2048])', '                out.flush()', '                time.sleep(0.05)', '    return str(root)'].join('\n') + '\n')
  const source = join(f.home, 'fake-hub-source'); mkdirSync(source)
  const payload = Buffer.alloc(60 * 1024, 7)
  writeFileSync(join(source, 'model.gguf'), payload)
  const netDev = join(f.home, 'fake-net-dev')
  writeFileSync(netDev, 'Inter-|   Receive\n face |bytes    packets\n  eth0: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n')
  const fillManifest = { model: 'fixture/fill', include: '', revision: 'd'.repeat(40), files: [{ path: 'model.gguf', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }] }
  const fill = (name: string, mode: string, extra: NonNullable<Parameters<typeof weightCheckScript>[3]>) => {
    const started = Date.now()
    const run = spawnSync('python3', ['-c', weightCheckScript(fillManifest, join(f.home, name), true, { stallSeconds: 0.5, stallBytes: 1000, stallPollSeconds: 0.05, netDevPath: netDev, ...extra })], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONPATH: join(f.home, 'fake-hub'), FAKE_HF_MODE: mode, FAKE_HF_SOURCE: source } })
    return { status: run.status, stdout: run.stdout ?? '', seconds: (Date.now() - started) / 1000, report: JSON.parse(/MERCURY_STALL (\{.*\})/.exec(run.stdout ?? '')?.[1] ?? 'null') as { reason: string; bytes: number } | null }
  }
  const stopped = fill('fill-stall', 'stall', {})
  check('a real download that stops growing exits 75 with its partial bytes long before the stalled transfer would return', stopped.status === 75 && stopped.report?.reason === 'stall' && stopped.report.bytes >= 4096 && stopped.seconds < 20)
  const flowing = fill('fill-flowing', 'copy', {})
  check('a real download still writing bytes past the stall window is never called stalled and verifies', flowing.status === 0 && !flowing.report && flowing.stdout.includes('full check passed') && flowing.seconds > 1)
  const late = fill('fill-deadline', 'stall', { stallSeconds: 100, deadlineSeconds: 0.5 })
  check('a real download past its deadline exits 75 and reports the deadline', late.status === 75 && late.report?.reason === 'deadline')
  const blind = fill('fill-unmeasured', 'stall', { netDevPath: join(f.home, 'missing-net-dev'), deadlineSeconds: 2 })
  check('without a readable transfer counter the stall rule stays off and only the deadline stops the download', blind.status === 75 && blind.report?.reason === 'deadline' && blind.seconds >= 2)
  const MiB = 1024 * 1024
  const zerosHash = (size: number) => { const hash = createHash('sha256'); const block = Buffer.alloc(16 * MiB); for (let left = size; left > 0; left -= block.length) hash.update(left >= block.length ? block : block.subarray(0, left)); return hash.digest('hex') }
  const sparse = join(f.home, 'sparse-weights'); mkdirSync(sparse)
  const sparseFiles = [{ path: 'big.gguf', size: 2048 * MiB }, { path: 'mid.gguf', size: 300 * MiB + 7 }, { path: 'small.json', size: 1000 }]
  for (const file of sparseFiles) { writeFileSync(join(sparse, file.path), ''); truncateSync(join(sparse, file.path), file.size) }
  const sparseManifest = { model: 'fixture/sparse', include: '', revision: 'd'.repeat(40), files: sparseFiles.map(file => ({ ...file, sha256: zerosHash(file.size) })) }
  const counted = "import pathlib as _pl, atexit as _ax\n_read = [0]\n_open = _pl.Path.open\nclass _Counted:\n    def __init__(self, f): self.f = f\n    def read(self, n=-1):\n        b = self.f.read(n)\n        _read[0] += len(b)\n        return b\n    def __getattr__(self, name): return getattr(self.f, name)\n    def __enter__(self): return self\n    def __exit__(self, *a): return self.f.__exit__(*a)\ndef _counted_open(self, mode='r', *a, **k):\n    f = _open(self, mode, *a, **k)\n    return _Counted(f) if 'r' in mode and 'b' in mode else f\n_pl.Path.open = _counted_open\n_ax.register(lambda: print('BYTES_READ ' + str(_read[0])))\n"
  const sparseFill = spawnSync('python3', ['-c', weightCheckScript(sparseManifest, sparse, false)], { encoding: 'utf8', timeout: 120_000 })
  const sparseAnchor = JSON.parse(sparseFill.stdout.split('\n').find(line => line.startsWith('MERCURY_WEIGHTS '))!.slice('MERCURY_WEIGHTS '.length)).sampleManifestSha256 as string
  const samplesRaw = readFileSync(join(sparse, 'SAMPLES.json'), 'utf8')
  const recorded = JSON.parse(samplesRaw) as { samples: { path: string; size: number; mtimeNs: string; regions: number[][]; sampleSha256: string }[] }
  check('the fill records each file’s sample positions: head, tail and eight fixed-seed 1 MB blocks, or the whole of a small file', recorded.samples[0]!.regions.length === 10 && JSON.stringify(recorded.samples[0]!.regions.slice(0, 2)) === JSON.stringify([[0, 64 * MiB], [2048 * MiB - 64 * MiB, 64 * MiB]]) && recorded.samples[0]!.regions.slice(2).every(([offset, count]) => count === MiB && offset! >= 0 && offset! + MiB <= 2048 * MiB) && JSON.stringify(recorded.samples[2]!.regions) === JSON.stringify([[0, 1000]]))
  const warmCount = spawnSync('python3', ['-c', counted + weightCheckScript(sparseManifest, sparse, false, { sampleManifestSha256: sparseAnchor })], { encoding: 'utf8', timeout: 120_000 })
  const bytesRead = Number(/BYTES_READ (\d+)/.exec(warmCount.stdout)?.[1])
  const regionBytes = recorded.samples.reduce((sum, row) => sum + row.regions.reduce((n, [, count]) => n + count!, 0), 0)
  const expectedRead = regionBytes + Buffer.byteLength(samplesRaw) + readFileSync(join(sparse, 'SHA256SUMS')).length
  check('a warm check reads exactly the recorded samples and its two receipts, not the weights (counted bytes)', warmCount.status === 0 && warmCount.stdout.includes('sampled check passed') && bytesRead === expectedRead && regionBytes === 2 * 136 * MiB + 1000 && bytesRead < sparseFiles.reduce((sum, file) => sum + file.size, 0) / 8)
  const moved = recorded.samples.map(row => row.path !== 'big.gguf' ? row : (() => { const regions = [...row.regions.slice(0, 2), ...Array.from({ length: 8 }, (_, index) => [(index + 1) * 200 * MiB, MiB])]; const hash = createHash('sha256'); for (const [offset, count] of regions) { hash.update(offset + ':' + count + ':'); hash.update(Buffer.alloc(count!)) } return { ...row, regions, sampleSha256: hash.digest('hex') } })())
  const movedRaw = JSON.stringify({ ...JSON.parse(samplesRaw), samples: moved })
  writeFileSync(join(sparse, 'SAMPLES.json'), movedRaw)
  const movedCheck = spawnSync('python3', ['-c', weightCheckScript(sparseManifest, sparse, false, { sampleManifestSha256: createHash('sha256').update(movedRaw).digest('hex') })], { encoding: 'utf8', timeout: 120_000 })
  check('the warm check hashes the positions written in the anchored manifest, not positions re-derived on the pod', movedCheck.status === 0 && movedCheck.stdout.includes('sampled check passed') && !movedCheck.stdout.includes('full check running'))
  const engineWords = volumes.fastLoadEstimate(gguf, { ...kept, state: 'kept' })
  check('GGUF estimate names the prebuilt engine image and the kept weights', engineWords.includes('Engine from image ~1 min · no engine build') && !engineWords.includes('builds llama.cpp') && engineWords.includes('weights kept ~0') && engineWords.includes('loads ~3 min'))
  const builtWords = volumes.fastLoadEstimate({ ...gguf, image: 'nvidia/cuda:13.0.2-devel-ubuntu24.04' }, { ...kept, state: 'kept' })
  check('a GGUF row without the prebuilt image still admits the retained build instead of promising image-only startup', builtWords.includes('builds llama.cpp ~10 min') && builtWords.includes('weights kept ~0'))
  const filling = await volumes.createKeptVolume(api, nemotron, 'global', 'any DC', signal)
  const fillOffer = (await api.offers(signal)).find(row => row.recipe.id === nemotron.id)!
  const fillPod = await api.create(fillOffer, sshKey.publicKey, 'fixture-filling', filling)
  volumes.writeKeptVolume({ ...volumes.readKeptVolume(filling.id)!, state: 'preparing', preparingPod: fillPod.id })
  const whileFilling = await volumes.rentalVolume(api, nemotron, signal).then(() => '', error => String(error))
  await api.terminate(fillPod.id)
  check('a rental never attaches a disk another pod is still filling, and attaches it once that pod is gone', whileFilling.includes('Pod ' + fillPod.id + ' is still filling weights disk ' + filling.id + '; rent when the Bank shows it kept') && (await volumes.rentalVolume(api, nemotron, signal))?.id === filling.id)
  rp.state.failVolumeRead = true
  const blindRental = await volumes.rentalVolume(api, nemotron, signal).then(() => '', error => String(error))
  check('a model with a disk is not rented blind while the volume list is unreadable', blindRental.includes('cannot be confirmed while Runpod’s volume list is unavailable; no pod was created'))
  let sawUnavailable = false
  let reachedSsh = false
  await road(async q => { if (q.step === 'door-models') return 'other'; if (q.step === 'where') { sawUnavailable = Boolean(q.rows?.some(row => row.label.includes('volumes unread'))); return 'ssh' } if (q.step === 'ssh-host') reachedSsh = true; return null }, () => {}, signal)
  check('volume-list failure admits the unknown count without blocking the SSH road', sawUnavailable && reachedSsh)
  const plainPod = await api.create(failOffer, sshKey.publicKey, 'fixture-plain')
  const paidWords: string[] = []
  let paidRows: string[] = []
  await road(async q => { if (q.step === 'door-models') return 'other'; if (q.step === 'where') return 'pods'; if (q.step === 'paid-pods') paidRows = (q.rows ?? []).map(row => row.value); return null }, update => { paidWords.push(update.words) }, signal)
  check('an unreadable volume list still lists billed pods for Stop or Terminate and says disks are not shown', paidRows.includes(plainPod.id) && paidWords.some(words => words.includes('Volume list unavailable; weights disks are not shown and may still bill')))
  let reachedRentConfirm = false
  await road(async q => { if (q.step === 'door-models') return 'other'; if (q.step === 'where') return 'rent'; if (q.step === 'rental-vendor') return 'runpod'; if (q.step === 'budget') return ''; if (q.step === 'models') return 'Qwen3.8-27B'; if (q.step === 'offers') return '0'; if (q.step === 'rent-confirm') reachedRentConfirm = true; return null }, () => {}, signal)
  check('renting a model without a weights disk needs no volume read, so a volume outage does not block it', reachedRentConfirm)
  rp.state.failVolumeRead = false
  await api.terminate(plainPod.id)
  await volumes.deleteKeptVolume(api, filling.id)
  check('proof refused all non-loopback traffic and attempted none', external.length === 0)
  check('only opted-in models have records and no preparation pod remains', volumes.keptVolumes().every(row => [qwen.model, nemotron.model, gguf.model].includes(row.model)) && rp.state.pods.size === 0)
  console.log('FAST LOAD DRIVE GREEN — ' + checks + ' checks; catalogue, opt-in, prepare-now, kept rental, disk deletion, reconciliation, corruption, watch and failure cleanup; zero billable calls')
} finally { mounted?.unmount(); await Promise.all(jobs); ssh?.close(); await (await import('../../src/utils/settings/changeDetector.ts')).settingsChangeDetector.dispose(); globalThis.fetch = originalFetch; await rp.close(); f.close() }

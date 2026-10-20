import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { KEY, mountOffscreen, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'

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
  const { fastLoadRecipes, fastLoadState, fastLoadDoor, volumeDeleteDoor } = await import('../../src/services/host/fastLoad.ts')
  const { weightManifest, weightCheckScript, keptWeightsPath } = await import('../../src/services/host/keptWeights.ts')
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
  await road(async q => { if (q.step === 'where') return 'fast-load'; catalogue = q; return null }, () => {}, signal)
  check('catalogue lists every known model with its size and not kept', fastLoadRecipes().every(recipe => catalogue.rows.some((row: any) => row.value === recipe.id && row.label.includes(recipe.weightsGb.toFixed(2) + ' GB') && row.label.endsWith('not kept'))))
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
  const heading = async (needle: string) => assert.ok(await waitFor(() => m.lines().slice(0, 4).join(' ').includes(needle), 15000), 'active screen reaches ' + needle + '\n' + m.screen())
  const choose = async (needle: string) => {
    for (let i = 0; i < 25; i++) {
      const selected = m.lines().find(line => line.includes('› ')) ?? ''
      if (selected.includes(needle)) { m.push(KEY.enter); return }
      m.push(KEY.down)
      assert.ok(await waitFor(() => (m.lines().find(line => line.includes('› ')) ?? '') !== selected, 3000), 'selection moves toward ' + needle + '\n' + m.screen())
    }
    throw new Error('Missing choice ' + needle)
  }
  const close = async () => { m.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const capture = async (name: string) => {
    check(name + ' renders without errors or secrets', !m.screen().includes('RENDER ERROR') && !m.screen().includes(rp.key))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), m.screen())
    const grid = m.lines().map((line, y) => Array.from(line.padEnd(160)).map((c, x) => { const s = m.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
    writeFileSync(join(frames, name + '.json'), JSON.stringify({ grid, cols: 160, rows: 44 }))
    await gridToPng(join(frames, name + '.json'), join(frames, name + '.png'))
  }
  await heading('Where should the model run?'); await choose('Fast-load'); await heading('Fast-load (keep weights'); await capture('01-catalogue')
  await choose('Qwen3.8-27B'); await heading('How?'); await capture('02-per-model-how')
  check('per-model choice offers network, global and explicit SSH stub', m.screen().includes('network volume') && m.screen().includes('global volume (beta)') && m.screen().includes('mercury-host road'))
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
  await close(); open(); await heading('Where should'); await choose('Fast-load'); await heading('Fast-load (keep weights'); await until('kept on ' + kept.id); await capture('04-kept-catalogue'); await close()
  open(); await heading('Where should'); await choose('Rent a GPU'); await heading('Optional spending budget'); m.push(KEY.enter); await until('Qwen3.8-27B'); await choose('Qwen3.8-27B'); await heading('Choose a GPU shape'); await choose('RTX PRO 6000'); await heading('Confirm the hourly price'); await capture('05-kept-rental-confirm')
  check('rental confirm gives per-step short estimate and monthly disk charge', m.screen().includes('weights kept ~0') && m.screen().includes('load ~3 min') && m.screen().includes('$5.60/month'))
  await choose('Confirm $2.49/hr'); assert.ok(await waitFor(() => readHostRecord('fixture-pod-2')?.jobState === 'ready', 15000), 'kept model reaches ready')
  check('kept rental reattaches same disk and skips weight fetch', rp.state.createBodies[1].mounts.network[0].volumeId === kept.id && ssh.state.weightFetches === 1)
  check('warm worker uses samples, records the method and shows it on the pod row', ssh.state.sampledChecks === 1 && readHostRecord('fixture-pod-2')?.weightsCheck === 'weights kept · sampled check passed' && volumes.readKeptVolume(kept.id)?.verifiedSums?.check === 'sampled')
  check('engine runs from verified kept path', ssh.commands.some((r: any) => r.args.at(-1)?.includes('nohup setsid') && r.args.at(-1).includes(keptWeightsPath(qwen))))
  await heading('Pod controls'); await choose('Terminate'); await until('Confirm terminate'); await choose('Confirm terminate'); await heading('Keep the weights disk'); await capture('06-terminate-weights')
  check('terminate does not delete pod or disk before keep-or-delete answer', rp.state.deletes === 1 && rp.state.volumeDeletes === 0)
  await choose('Keep the weights disk'); await until('Pod terminated'); check('keep terminates the pod while retaining the billed disk', rp.state.pods.size === 0 && rp.state.volumes.has(kept.id)); await close()
  open(); await heading('Where should'); check('first-screen paid count includes a volume with no pod', m.screen().includes('Pods I’m paying for · 1')); await choose('Pods I’m paying for'); await until(kept.id); await choose(kept.id); await heading('Delete weights disk?')
  check('Delete warns that the next rental downloads again before removal', m.screen().includes('next rental downloads') && rp.state.volumeDeletes === 0)
  await choose('Cancel'); await close(); check('cancelled Delete leaves the disk intact', rp.state.volumes.has(kept.id))
  open(); await heading('Where should'); await choose('Pods I’m paying for'); await until(kept.id); await choose(kept.id); await heading('Delete weights disk?'); await choose('Confirm Delete'); await until('Weights disk deleted'); await close()
  check('confirmed Delete removes and verifies the live disk', !rp.state.volumes.has(kept.id) && rp.state.volumeDeletes === 1 && volumes.readKeptVolume(kept.id)?.state === 'gone')
  const nemotron = table.find(row => row.id.startsWith('nemotron'))!
  let nextConfirm: any
  await fastLoadDoor(api, async q => {
    if (q.step === 'fast-load') return fastLoadState(nemotron) === 'not kept' ? fastLoadRecipes().find(row => row.model === nemotron.model)!.id : null
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
  await runHostJob(failed.id, failed.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 60, keepAlive: false })
  ssh.state.refuse = false
  check('prepare-only failure before SSH terminates its temporary billed pod', !rp.state.pods.has(failPod.id) && !readHostRecord(failPod.id) && volumes.readKeptVolume(failVolume.id)?.state === 'failed')
  const watch = queueHostWatch({ id: 'watch-kept', name: qwen.label, recipe: qwen.id, price: 5, maxPrice: 5, startedAt: new Date().toISOString(), status: 'WATCHING', apiBaseUrl: rp.baseUrl, sessionId: 'fast-load-proof' })
  await runHostJob(watch.id, watch.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 3000, keepAlive: false })
  const watched = hostRecords().find(row => row.watchedFrom === watch.id)!
  check('stock-watch rental carries the opted-in volume through setup', watched?.volumeId === failVolume.id && watched.jobState === 'ready' && rp.state.createBodies.at(-1).mounts.network[0].volumeId === failVolume.id)
  let deleteAsked = false
  const bothDeleted = await road(async q => {
    if (q.step === 'where') return 'pod:' + watched.id
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
    if (q.step === 'where') return 'pod:' + sharedPod.id
    if (q.step === 'pod-controls') return 'terminate'
    if (q.step === 'pod-confirm') return 'terminate'
    if (q.step === 'terminate-weights') { liveMountAsked = true; return 'delete' }
    throw new Error('Unexpected shared-volume step ' + q.step)
  }, () => {}, signal)
  check('lost local pod record still asks about the owned disk using live mounts', liveMountAsked)
  check('disk delete refusal reports pod gone and surviving billed disk, never pod still running', !failedDelete.ok && failedDelete.words.includes('Pod terminated') && failedDelete.words.includes('may still bill') && !rp.state.pods.has(sharedPod.id) && rp.state.volumes.has(shared.id))
  const cleanupFailure = queueHostSetup({ id: otherPod.id, name: otherPod.name, recipe: qwen.id, price: failOffer.price, startedAt: otherPod.createdAt, status: otherPod.status, apiBaseUrl: rp.baseUrl, sshKey: sshKey.path, volumeId: shared.id, prepareWeightsOnly: true })
  ssh.state.refuse = true; rp.state.failDelete = true
  await runHostJob(cleanupFailure.id, cleanupFailure.generation!, { runner: ssh.runner, pauseMs: 5, timeoutMs: 60, keepAlive: false })
  check('failed cleanup keeps the billed pod id and names it in durable error words', readHostRecord(otherPod.id)?.error?.includes(otherPod.id + ' may still bill') && rp.state.pods.has(otherPod.id))
  ssh.state.refuse = false; rp.state.failDelete = false
  await api.terminate(otherPod.id); removeHostRecord(otherPod.id); await volumes.deleteKeptVolume(api, shared.id)
  const beforeStub = { disks: rp.state.volumeCreates, pods: rp.state.creates, commands: ssh.commands.length }
  let stubOpened = false
  await fastLoadDoor(api, async q => {
    if (q.step === 'fast-load') return stubOpened ? null : fastLoadRecipes().find(row => row.model === qwen.model)!.id
    if (q.step === 'fast-load-how') { stubOpened = true; return 'ssh' }
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
    let confirmedFull = false
    await fastLoadDoor(api, async q => {
      if (q.step === 'fast-load') return confirmedFull ? null : fastLoadRecipes().find(row => row.model === qwen.model)!.id
      if (q.step === 'fast-load-kept') return 'verify'
      if (q.step === 'fast-load-verify-confirm') { check('Verify fully asks a separate temporary-pod price before creating it', q.willRun.includes('$2.49/hr') && rp.state.creates === podsBefore); confirmedFull = true; return 'verify' }
      throw new Error('Unexpected full verification step ' + q.step)
    }, () => {}, signal, options)
    await Promise.all(jobs)
    check('explicit full verification performs full check and terminates its temporary pod', ssh.state.fullChecks === fullBefore + 1 && volumes.readKeptVolume(winner.value.id)?.verifiedSums?.check === 'full' && rp.state.pods.size === 0)
    await volumes.deleteKeptVolume(api, winner.value.id)
  }
  const tiny = join(f.home, 'tiny-weights'); mkdirSync(tiny)
  const bytes = Buffer.from('verified weights')
  writeFileSync(join(tiny, 'model.gguf'), bytes)
  const manifest = { model: 'fixture/tiny', include: '', revision: 'fixture', files: [{ path: 'model.gguf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
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
  const engineWords = volumes.fastLoadEstimate(gguf, { ...kept, state: 'kept' })
  check('GGUF estimate admits the retained build instead of promising image-only startup', engineWords.includes('builds the engine ~10 min') && engineWords.includes('weights kept ~0') && engineWords.includes('load ~3 min'))
  rp.state.failVolumeRead = true
  let sawUnavailable = false
  let reachedSsh = false
  await road(async q => { if (q.step === 'where') { sawUnavailable = Boolean(q.rows?.some(row => row.label.includes('volumes unread'))); return 'ssh' } if (q.step === 'ssh-host') reachedSsh = true; return null }, () => {}, signal)
  check('volume-list failure admits the unknown count without blocking the SSH road', sawUnavailable && reachedSsh)
  rp.state.failVolumeRead = false
  check('proof refused all non-loopback traffic and attempted none', external.length === 0)
  check('only opted-in models have records and no preparation pod remains', volumes.keptVolumes().every(row => [qwen.model, nemotron.model, gguf.model].includes(row.model)) && rp.state.pods.size === 0)
  console.log('FAST LOAD DRIVE GREEN — ' + checks + ' checks; catalogue, opt-in, prepare-now, kept rental, disk deletion, reconciliation, corruption, watch and failure cleanup; zero billable calls')
} finally { mounted?.unmount(); await Promise.all(jobs); ssh?.close(); await (await import('../../src/utils/settings/changeDetector.ts')).settingsChangeDetector.dispose(); globalThis.fetch = originalFetch; await rp.close(); f.close() }

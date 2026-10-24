import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = join(process.env.MERCURY_CONFIG_DIR, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
if (process.platform === 'win32') process.env.USERPROFILE = home
let checks = 0
let dump = (): string => ''
const check = (name: string, truth: unknown) => { assert.ok(truth, name + '\n' + dump()); checks++; console.log('PASS ' + name) }
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const REVISION = 'c19ca5ca4eaeb79d29fdf08aea8327da95b1116a'
const MODEL = 'dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8'
const SHARD_BYTES = 510296921671
const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../../assets/host/recipes.json'), 'utf8')) as { version: number; publishedAt: string; recipes: any[] }
const base = shipped.recipes.find(row => row.id === 'deepseek41-b200')
assert.ok(base && base.gpu === 'B200' && base.count === 4, 'the shipped DeepSeek 4× B200 row is the shape the owner’s private rows copy')
const privateRow = (id: string, gpu: string, vramGb: number) => ({ ...base, id, label: 'DeepSeek-V4.1-Flash UNCENSORED (dealignai)', model: MODEL, gpu, vramGb, diskGb: 650, weightsGb: 510.3, source: 'https://huggingface.co/' + MODEL, verification: 'private row · MIT · a fine-tune served with the base model’s documented recipe; not measured', verified: { by: 'documented', on: '2026-10-22', note: 'the base model’s cookbook recipe applied to the fine-tune; not booted by Mercury', source: 'https://huggingface.co/' + MODEL }, weightManifest: undefined })
const smallFiles: Record<string, Buffer> = {
  'config.json': Buffer.from(JSON.stringify({ architectures: ['DeepseekV41ForCausalLM'], model_type: 'deepseek_v41' })),
  'model.safetensors.index.json': Buffer.from(JSON.stringify({ weight_map: Object.fromEntries(Array.from({ length: 48 }, (_, i) => ['layer.' + i, 'model-' + String(i + 1).padStart(5, '0') + '-of-00048.safetensors'])) })),
  'tokenizer.json': randomBytes(6_367_257),
  'tokenizer_config.json': randomBytes(801),
  'README.md': randomBytes(14_750),
}
const lfsSmall: Record<string, Buffer> = { 'inference/examples/images/carrots.jpeg': randomBytes(212_495) }
const shardSizes = Array.from({ length: 48 }, (_, i) => i < 47 ? 10_000_000_000 : SHARD_BYTES - 47 * 10_000_000_000)
const sparse = (path: string, size: number) => { mkdirSync(join(path, '..'), { recursive: true }); const fd = openSync(path, 'w'); ftruncateSync(fd, size); closeSync(fd) }
function ownerFolder(path: string) {
  rmSync(path, { recursive: true, force: true })
  const sums: string[] = []
  const receipts: string[] = []
  shardSizes.forEach((size, i) => { const name = 'model-' + String(i + 1).padStart(5, '0') + '-of-00048.safetensors'; sums.push(sha256('shard ' + i) + '  ' + name); sparse(join(path, name), size); receipts.push(name) })
  for (const [name, data] of Object.entries(lfsSmall)) { mkdirSync(join(path, name, '..'), { recursive: true }); writeFileSync(join(path, name), data); sums.unshift(sha256(data) + '  ' + name); receipts.push(name) }
  for (const [name, data] of Object.entries(smallFiles)) { mkdirSync(join(path, name, '..'), { recursive: true }); writeFileSync(join(path, name), data); receipts.push(name) }
  writeFileSync(join(path, 'SHA256SUMS'), sums.join('\n') + '\n')
  writeFileSync(join(path, 'SHA256SUMS.verified'), sums.map(line => line.split('  ')[1] + ': OK').join('\n') + '\n')
  for (const name of receipts) { const meta = join(path, '.cache/huggingface/download', name + '.metadata'); mkdirSync(join(meta, '..'), { recursive: true }); writeFileSync(meta, REVISION + '\n' + sha256(name) + '\n1792690204.47\n') }
}
const { hostDirectory } = await import('../../src/services/host/store.ts')
const bank = await import('../../src/services/host/bank.ts')
const volumes = await import('../../src/services/host/volumes.ts')
const vastVolumes = await import('../../src/services/host/vastVolumes.ts')
const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
const { KEY, mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')
const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
const { fakeSshRunner, runpodFixture } = await import('./runpodFixture.mjs')
const { vastFixture } = await import('./vastFixture.mjs')
const f = await llmhostFixture()
f.state.dialect = 'sglang'; f.state.window = 131072
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
const vast = await vastFixture()
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.runpod.io') return nativeFetch(new Request(rp.baseUrl.replace('/v2', '') + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('This proof only permits loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
let mounted: Awaited<ReturnType<typeof mountOffscreen>> | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
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
  assert.ok(hostDirectory().startsWith(f.home), 'the host directory follows the fixture home')
  mkdirSync(hostDirectory(), { recursive: true })
  writeFileSync(join(hostDirectory(), 'private-recipes.json'), JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes: [...shipped.recipes, privateRow('deepseek41-uncensored-b200', 'B200', 180), privateRow('deepseek41-uncensored-b300', 'B300', 288), privateRow('deepseek41-uncensored-gb300', 'GB300', 288)] }))
  const live = currentHostRecipes().find(row => row.id === 'deepseek41-uncensored-b200')!
  check('the owner’s private row loads with no manifest, 510.3 GB and the 4× B200 shape', Boolean(live) && live.weightManifest === undefined && live.weightsGb === 510.3)
  const driveBank = join(f.home, 'mercury-model-bank')
  assert.deepEqual(bank.bankCandidates(), [driveBank, join(f.home, 'models')], 'bank discovery stays inside the fixture home')
  ownerFolder(bank.bankModelFolder(driveBank, live))
  const notices = (): string[] => { const dir = join(f.home, 'host', 'notices'); try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).words as string) } catch { return [] } }
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const jobs: Promise<void>[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, vendorApiBaseUrls: { vast: vast.baseUrl }, runner: ssh.runner, pauseMs: 10, readyTimeoutMs: 2000, sessionId: 'vast-volumes-proof', startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 10, timeoutMs: 4000, keepAlive: false })) } })
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  const mount = async (columns: number) => { mounted?.unmount(); mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: 44 }, React.createElement(SettingsPopupSlot)))), columns, 44) }
  await mount(120)
  const screen = () => mounted!.screen()
  const flat = () => screen().replace(/[│\s]+/g, ' ')
  dump = screen
  const until = async (needle: string) => assert.ok(await waitFor(() => flat().includes(needle), 20000), 'screen reaches ' + needle + '\n' + screen())
  const heading = async (needle: string) => assert.ok(await waitFor(() => mounted!.lines().slice(0, 4).join(' ').includes(needle), 20000), 'question reaches ' + needle + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const select = async (needle: string) => {
    let key = KEY.down
    for (let n = 0; n < 80; n++) {
      const before = selected()
      if (before.includes(needle)) return
      mounted!.push(key)
      if (!await waitFor(() => selected() !== before, 1500)) { assert.ok(key === KEY.down, 'selection reaches ' + needle + '\n' + screen()); key = KEY.up }
    }
    throw new Error('Choice not found: ' + needle)
  }
  const choose = async (needle: string) => { await select(needle); mounted!.push(KEY.enter) }
  const press = async (needle: string, key: string) => { await select(needle); mounted!.push(key) }
  const close = async () => { mounted!.push(KEY.esc); assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000)) }
  const noKeys = (name: string) => check(name + ' renders without errors or keys', !screen().includes('RENDER ERROR') && !screen().includes(vast.key))
  const openModel = async () => { open(); await heading('Which model?'); await choose('DeepSeek-V4.1-Flash UNCENSORED'); await heading('DeepSeek-V4.1-Flash UNCENSORED'); await until('WEIGHTS') }
  await openModel()
  await choose('Connect Vast.ai'); await heading('Vast.ai API key'); mounted!.push(vast.key); await until('********'); mounted!.push(KEY.enter)
  await until('Rent · Vast.ai 4× B200')
  check('with Vast.ai connected the rental row names the GPU shape, price and machine without download narration, and nothing was created', flat().includes('Rent · Vast.ai 4× B200 · $9.31/hr · datacenter · machine 9103') && !flat().includes('downloads the weights first') && vast.state.creates === 0 && vast.state.volumeCreates === 0)
  noKeys('the model screen with Vast.ai connected')
  await press('Bank · banked on', 'm'); await heading('Which Vast.ai machine keeps the weights?')
  check('with Vast.ai the only connected vendor, m goes straight to the Vast.ai machine choice', !screen().includes('Runpod network volume'))
  check('the machine list is read from Vast’s volume offers: the machine with 4× B200 stock first with its hosting tag and rental price, the volume priced per GB-month for the manifest’s size (556 GB), and the words say a volume lives on one machine', flat().includes('556 GB volume') && /machine 9103 · datacenter · NL · 4× B200 in stock at \$9\.31\/hr · volume \$0\.20\/GB-month → \$111\.20\/month for 556 GB/.test(flat()) && flat().includes('machine 9102 · community host · US · no 4× B200 stock right now · volume $0.10/GB-month → $55.60/month for 556 GB') && flat().includes('only a rental on that machine boots from it; other machines download') && mounted!.lines().findIndex(line => line.includes('machine 9103')) < mounted!.lines().findIndex(line => line.includes('machine 9102')) && vast.state.volumeCreates === 0)
  noKeys('the machine screen')
  await choose('machine 9103'); await heading('When should the weights be prepared?')
  check('the When screen says the fill instance is the cheapest on that machine with room, any GPU shape, terminated and verified afterwards', flat().includes('Prepare now rents the cheapest instance on that machine with room (any GPU shape; it only downloads), fills and verifies the volume, then terminates that instance and verifies it is gone'))
  await choose('Prepare now'); await heading('Confirm Vast.ai volume')
  check('the confirm names the machine, the 556 GB volume, its per GB-month billing with or without an instance, and the fill instance: a temporary 1× RTX PRO 6000 at $1.35/hr on that machine, not the 4× B200; nothing created yet', flat().includes('556 GB on machine 9103 (datacenter)') && flat().includes('$111.20/month for its 556 GB ($0.20/GB-month, the machine’s rate), with or without an instance') && flat().includes('Vast.ai bills the volume per GB-month at that machine’s rate from creation, with or without an instance, until you delete it') && /a temporary 1× RTX PRO 6000 instance at \$1\.35\/hr on that machine \(the cheapest there with room; filling a volume needs no particular GPU\)/.test(flat()) && !flat().includes('B200 instance') && /Confirm \$111\.20\/month \+ temporary instance 1× RTX PRO 6000 \$1\.35\/hr/.test(flat()) && vast.state.volumeCreates === 0 && vast.state.creates === 0)
  noKeys('the confirm screen')
  await choose('Confirm $111.20/month'); await until('preparing on machine 9103')
  assert.ok(await waitFor(() => volumes.keptVolumes().some(volume => volume.kind === 'vast' && volume.state === 'kept'), 20000), 'the fill instance verifies the weights on the volume\n' + screen() + '\nVOLUMES ' + JSON.stringify(volumes.keptVolumes()) + '\nRECORDS ' + JSON.stringify(hostRecords()) + '\nNOTICES ' + JSON.stringify(notices()) + '\nSSH ' + JSON.stringify(ssh.commands.map(command => String(command.args.at(-1)).slice(0, 80))))
  await Promise.all(jobs.splice(0))
  const kept = volumes.keptVolumes().find(volume => volume.kind === 'vast')!
  const fillBody = vast.state.createBodies[0]
  check('one volume was created on machine 9103 (PUT /api/v0/volumes/ with the offer id, 556 GB and Mercury’s name); the fill instance was the 1× RTX PRO 6000 ask on that machine with volume_info mounting the volume at /workspace/mercury-weights; it was terminated and read back absent', vast.state.volumeCreates === 1 && vast.state.creates === 1 && fillBody.ask === 106 && fillBody.volume_info.create_new === false && fillBody.volume_info.volume_id === Number(kept.id) && fillBody.volume_info.mount_path === '/workspace/mercury-weights' && fillBody.disk === 30 && vast.state.deletes === 1 && vast.state.pods.size === 0 && vast.requests.some(row => row.path === '/api/v0/volumes/' && row.method === 'PUT' && row.body.id === 701 && row.body.size === 556 && /^mercury_weights_[0-9a-f]{12}$/.test(row.body.name)))
  check('the volume record carries the machine, the size, the rate and the monthly amount, the bank-built manifest and a full check on the volume; the download ran once on the instance', kept.state === 'kept' && kept.machineId === 9103 && kept.size === 556 && kept.storageCost === 0.2 && kept.price === 111.2 && kept.recipeRow?.weightManifest?.revision === REVISION && kept.verifiedSums?.check === 'full' && kept.verifiedSums.bytes === SHARD_BYTES + Object.values(smallFiles).reduce((n, data) => n + data.length, 0) + Object.values(lfsSmall).reduce((n, data) => n + data.length, 0) && ssh.state.weightFetches === 1 && ssh.state.fullChecks === 1)
  check('the notice names the Vast.ai machine, the terminated temporary instance and the volume’s billing', notices().some(words => words.includes('weights kept on Vast.ai machine 9103 (volume ' + kept.id + ')') && words.includes('temporary instance 7001 terminated (Vast.ai no longer lists it)') && words.includes('$111.20/month for its 556 GB')))
  await close(); await openModel(); await until('Bank · banked on ' + join('~', 'mercury-model-bank') + ' · Vast.ai machine 9103')
  check('after preparation the Bank row names the volume machine and bill, the weights line names the local folder and the rental row keeps its price', flat().includes('Bank · banked on ' + join('~', 'mercury-model-bank') + ' · Vast.ai machine 9103 · $111.20/month for its 556 GB ($0.20/GB-month, the machine’s rate), with or without an instance') && flat().includes('WEIGHTS · 510 GB · banked on ~/mercury-model-bank') && flat().includes('Rent · Vast.ai 4× B200 · $9.31/hr · datacenter · machine 9103'))
  noKeys('the model screen after the preparation')
  await close()
  rmSync(driveBank, { recursive: true, force: true })
  await openModel(); await until('WEIGHTS · 510 GB · not banked')
  await choose('Rent · Vast.ai 4× B200'); await heading('Confirm the hourly price')
  check('the rental confirmation names the kept volume, machine, boot estimate and monthly bill beside the hourly price before creation', flat().includes('Weights: Vast.ai volume ' + kept.id + ' · machine 9103 · ~' + vastVolumes.vastBootMinutes(live, kept) + ' min') && flat().includes('volume ' + kept.id + ' · $111.20/month for its 556 GB') && flat().includes('bills without an instance') && flat().includes('Confirm $9.31/hr + volume $111.20/month · create this instance') && vast.state.creates === 1)
  await choose('Confirm $9.3')
  assert.ok(await waitFor(() => hostRecords().some(record => record.jobKind === 'setup' && !record.prepareWeightsOnly && record.jobState === 'ready'), 30000), 'the rental reaches ready\n' + screen())
  await Promise.all(jobs.splice(0))
  const rental = hostRecords().find(record => record.jobKind === 'setup' && !record.prepareWeightsOnly)!
  const rentBody = vast.state.createBodies[1]
  const engineScript = (ssh.commands.map(command => String(command.args.at(-1))).find(remote => remote.includes('/engine.sh') && remote.includes('printf %s')) ?? '').replaceAll("'\\''", "'")
  check('the rental is the 4× B200 ask on machine 9103 with volume_info attaching the kept volume; the instance passed a sampled check against the pinned manifest and skipped the download', rentBody.ask === 103 && rentBody.volume_info.volume_id === Number(kept.id) && rentBody.volume_info.mount_path === '/workspace/mercury-weights' && rental.volumeId === kept.id && ssh.state.weightFetches === 1 && ssh.state.sampledChecks === 1 && (readHostRecord(rental.id)?.weightsCheck ?? '').includes('sampled check passed') && ssh.commands.some(command => String(command.args.at(-1)).includes('weights kept · verified · download skipped')))
  check('the built launch command keeps all engine cache exports and promises reuse without claiming graph capture is skipped', engineScript.includes("SGLANG_CACHE_DIR='/workspace/mercury-weights/engine-cache/sglang'") && engineScript.includes("SGLANG_DG_CACHE_DIR='/workspace/mercury-weights/engine-cache/sglang/deep_gemm'") && engineScript.includes("DG_JIT_CACHE_DIR='/workspace/mercury-weights/engine-cache/deep_gemm'") && engineScript.includes("FLASHINFER_WORKSPACE_BASE='/workspace/mercury-weights/engine-cache'") && engineScript.includes("TORCHINDUCTOR_CACHE_DIR='/workspace/mercury-weights/engine-cache/inductor'") && engineScript.includes("TRITON_CACHE_DIR='/workspace/mercury-weights/engine-cache/triton'") && engineScript.includes("VLLM_CACHE_ROOT='/workspace/mercury-weights/engine-cache/vllm'") && engineScript.includes("mkdir -p '/workspace/mercury-weights/engine-cache'") && engineScript.includes('--model-path') && engineScript.includes('/workspace/mercury-weights/') && engineScript.includes('compiled kernels can be reused on later boots; graph capture still runs') && !engineScript.includes('skips the kernel tuning'))
  await close()
  await mount(80)
  open(); await heading('Which model?'); await choose('More options'); await heading('Where should the model run?'); await until('I’m paying for'); await choose('I’m paying for'); await heading('I’m paying for'); await until('Vast.ai volume ' + kept.id)
  check('at 80 columns Machines I’m paying for lists the Vast.ai volume with its machine, hosting tag, bill, stock and delete and watch keys', flat().includes('Vast.ai volume ' + kept.id + ' · Vast.ai machine 9103 · datacenter · $111.20/month for its 556 GB ($0.20/GB-month, the machine’s rate), with or without an instance · weights') && flat().includes('4× B200 in stock on that machine at $9.3') && flat().includes('d delete') && flat().includes('w watch stock'))
  noKeys('the paid-machines screen at 80 columns')
  await press('Vast.ai volume ' + kept.id, 'w'); await heading('Confirm the hourly price')
  check('w on a Vast.ai volume names its machine, storage bill and current ceiling before another rental', flat().includes('Watch for stock and rent at this price or less') && flat().includes('Watch only Vast.ai machine 9103') && flat().includes('other machines are not rented') && flat().includes('$111.20/month') && !flat().includes('no stock now') && vast.state.creates === 2)
  await close()
  open(); await heading('Which model?'); await choose('More options'); await heading('Where should the model run?'); await choose('I’m paying for'); await heading('I’m paying for'); await until('Vast.ai volume ' + kept.id)
  await press('Vast.ai volume ' + kept.id, 'd'); await heading('Delete Vast.ai volume?')
  check('d opens the delete confirm with the machine, the billing and Vast’s rule that a used volume cannot be deleted', flat().includes(kept.id + ' · Vast.ai machine 9103 · $111.20/month for its 556 GB') && flat().includes('Vast.ai refuses to delete a volume while an instance still uses it; terminate that instance first'))
  await choose('Confirm Delete Vast.ai volume'); await until('returned HTTP 400')
  check('with the rental still using the volume Vast refuses; Mercury says the deletion is unconfirmed and the volume still bills, and nothing was deleted', flat().includes('did not confirm the deletion of volume ' + kept.id) && flat().includes('still uses it; terminate that instance first') && flat().includes('It may still bill $111.20/month') && vast.state.volumes.size === 1 && volumes.readKeptVolume(kept.id)?.state === 'kept')
  await close()
  open(); await heading('Which model?'); await choose('More options'); await heading('Where should the model run?'); await until(rental.id); await choose(rental.id); await heading('controls'); await choose('Terminate ·'); await heading('Terminate'); await choose('Confirm terminate'); await heading('Keep the weights disk or delete it?')
  check('terminating the rental asks whether to keep the volume and names its monthly amount', flat().includes('$111.20/month'))
  await choose('Delete the weights disk too'); await until('terminated')
  await Promise.all(jobs.splice(0))
  check('terminate + delete removes the instance and then the volume, both verified absent from Vast’s lists', vast.state.pods.size === 0 && vast.state.volumes.size === 0 && vast.state.volumeDeletes === 2 && volumes.readKeptVolume(kept.id)?.state === 'gone')
  await close()
  ownerFolder(bank.bankModelFolder(driveBank, live))
  await openModel(); await choose('Connect Runpod'); await heading('Runpod API key'); mounted!.push(rp.key); await until('********'); mounted!.push(KEY.enter)
  await until('Bank · banked on'); await press('Bank · banked on', 'm'); await heading('How?')
  check('with Runpod connected too, m offers the Vast.ai volume beside the Runpod volumes, said in Vast’s own terms: one machine, per GB-month', screen().includes('Runpod network volume') && screen().includes('Runpod global volume') && flat().includes('Vast.ai volume · keep on one Vast.ai machine · per GB-month at the machine’s rate · not kept') && rp.state.volumeCreates === 0 && rp.state.creates === 0)
  await close()
  check('no request left the loopback fixtures and no screen carried the key', escaped.length === 0)
  console.log('VAST VOLUMES DRIVE GREEN — ' + checks + ' checks; the owner’s road end to end on the fixtures through the real popups at 120 and 80 columns: his private row → m → Vast.ai volume → machine 9103 → Prepare now → 1× RTX PRO 6000 fill instance at $1.35/hr → verified → kept → a 4× B200 rental on that machine attaches the volume, skips the download and points the engine caches at it → Machines I’m paying for lists the volume with d delete; zero billable calls')
} finally { mounted?.unmount(); ssh?.close(); await vast.close(); await rp.close(); f.close(); globalThis.fetch = nativeFetch }

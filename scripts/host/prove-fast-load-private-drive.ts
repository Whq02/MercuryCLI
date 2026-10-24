import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = join(process.env.MERCURY_CONFIG_DIR, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const gitBlob = (data: Buffer): string => createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex')
const REVISION = 'c19ca5ca4eaeb79d29fdf08aea8327da95b1116a'
const MODEL = 'dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8'
const SHARD_BYTES = 510296921671
const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../../assets/host/recipes.json'), 'utf8')) as { version: number; publishedAt: string; recipes: any[] }
const base = shipped.recipes.find(row => row.id === 'deepseek41-b200')
assert.ok(base && base.gpu === 'B200' && base.count === 4 && base.cuda === '13.0', 'the shipped DeepSeek 4× B200 row is the shape the owner’s private rows copy')
const privateRow = (id: string, gpu: string, vramGb: number, extra: Record<string, unknown> = {}) => ({ ...base, id, label: 'DeepSeek-V4.1-Flash UNCENSORED (dealignai)', model: MODEL, gpu, vramGb, diskGb: 650, weightsGb: 510.3, source: 'https://huggingface.co/' + MODEL, verification: 'private row · MIT · a fine-tune served with the base model’s documented recipe; not measured', verified: { by: 'documented', on: '2026-10-22', note: 'the base model’s cookbook recipe applied to the fine-tune; not booted by Mercury', source: 'https://huggingface.co/' + MODEL }, weightManifest: undefined, ...extra })
const tinyRow = { ...base, id: 'tiny-private-b200', label: 'Tiny private', model: 'fixture/tiny-private', diskGb: 20, weightsGb: 0, source: 'https://huggingface.co/fixture/tiny-private', verification: 'private row', verified: { by: 'documented', on: '2026-10-22', source: 'https://huggingface.co/fixture/tiny-private' }, weightManifest: undefined, efforts: undefined }
const { hostDirectory } = await import('../../src/services/host/store.ts')
mkdirSync(hostDirectory(), { recursive: true })
const privateFile = join(hostDirectory(), 'private-recipes.json')
const writePrivate = (rows: unknown[]) => writeFileSync(privateFile, JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes: rows }))
const smallFiles: Record<string, Buffer> = {
  'config.json': Buffer.from(JSON.stringify({ architectures: ['DeepseekV41ForCausalLM'], model_type: 'deepseek_v41' })),
  'model.safetensors.index.json': Buffer.from(JSON.stringify({ weight_map: Object.fromEntries(Array.from({ length: 48 }, (_, i) => ['layer.' + i, 'model-' + String(i + 1).padStart(5, '0') + '-of-00048.safetensors'])) })),
  'tokenizer.json': randomBytes(6_367_257),
  'tokenizer_config.json': randomBytes(801),
  'README.md': randomBytes(14_750),
  'inference/examples/images/corn.jpeg': randomBytes(56_122),
}
const lfsSmall: Record<string, Buffer> = { 'inference/examples/images/carrots.jpeg': randomBytes(212_495) }
const shardSizes = Array.from({ length: 48 }, (_, i) => i < 47 ? 10_000_000_000 : SHARD_BYTES - 47 * 10_000_000_000)
assert.equal(shardSizes.reduce((n, s) => n + s, 0), SHARD_BYTES)
const sparse = (path: string, size: number) => { mkdirSync(join(path, '..'), { recursive: true }); const fd = openSync(path, 'w'); ftruncateSync(fd, size); closeSync(fd) }
const tinyWeights = Buffer.from(JSON.stringify({ weight_map: { a: 'model-00001-of-00001.safetensors' } }))
const tinyShard = randomBytes(4096)
tinyRow.weightsGb = +((tinyShard.length + tinyWeights.length + 2) / 1e9).toFixed(9)
function ownerFolder(path: string, options: { receipts?: boolean; sums?: boolean; dropShard?: number; sizesJson?: boolean } = {}) {
  rmSync(path, { recursive: true, force: true })
  const sums: string[] = []
  const receipts: string[] = []
  shardSizes.forEach((size, i) => {
    const name = 'model-' + String(i + 1).padStart(5, '0') + '-of-00048.safetensors'
    const digest = sha256('shard ' + i)
    sums.push(digest + '  ' + name)
    if (options.dropShard !== i + 1) sparse(join(path, name), size)
    receipts.push(name)
  })
  for (const [name, data] of Object.entries(lfsSmall)) { mkdirSync(join(path, name, '..'), { recursive: true }); writeFileSync(join(path, name), data); sums.unshift(sha256(data) + '  ' + name); receipts.push(name) }
  for (const [name, data] of Object.entries(smallFiles)) { mkdirSync(join(path, name, '..'), { recursive: true }); writeFileSync(join(path, name), data); receipts.push(name) }
  if (options.sums !== false) {
    writeFileSync(join(path, 'SHA256SUMS'), sums.join('\n') + '\n')
    writeFileSync(join(path, 'SHA256SUMS.expected'), sums.join('\n') + '\n')
    writeFileSync(join(path, 'SHA256SUMS.verified'), sums.map(line => line.split('  ')[1] + ': OK').join('\n') + '\n')
  }
  if (options.sizesJson) writeFileSync(join(path, 'SIZES.json'), JSON.stringify(shardSizes.map((size, i) => ['model-' + String(i + 1).padStart(5, '0') + '-of-00048.safetensors', size])))
  if (options.receipts !== false) for (const name of receipts) { const meta = join(path, '.cache/huggingface/download', name + '.metadata'); mkdirSync(join(meta, '..'), { recursive: true }); writeFileSync(meta, REVISION + '\n' + sha256(name) + '\n1792690204.47\n') }
}
const smallBytes = Object.values(smallFiles).reduce((n, data) => n + data.length, 0) + Object.values(lfsSmall).reduce((n, data) => n + data.length, 0)

const keptWeights = await import('../../src/services/host/keptWeights.ts')
const bank = await import('../../src/services/host/bank.ts')
const volumes = await import('../../src/services/host/volumes.ts')
const bankManifestModule = await import('../../src/services/host/bankManifest.ts').catch(() => undefined)
const bytesMatchRecipe = (bytes: number, weightsGb: number): boolean => bankManifestModule?.bytesMatchRecipe(bytes, weightsGb) ?? false
const bankManifest = (recipe: any, path: string) => bankManifestModule?.bankManifest(recipe, path) ?? { reason: 'no bank manifest road' }
const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
writePrivate([privateRow('deepseek41-uncensored-b200', 'B200', 180), privateRow('deepseek41-uncensored-b300', 'B300', 288), privateRow('deepseek41-uncensored-gb300', 'GB300', 288), tinyRow])
const recipes = currentHostRecipes()
const owner = recipes.find(row => row.id === 'deepseek41-uncensored-b200')!
const tiny = recipes.find(row => row.id === 'tiny-private-b200')!
check('the private rows load from host/private-recipes.json with no manifest, no revision, 510.3 GB and the 4× B200 shape', Boolean(owner) && owner.weightManifest === undefined && owner.weightsGb === 510.3 && owner.count === 4 && owner.gpu === 'B200' && recipes.filter(row => row.model === MODEL).length === 3)
check('the rounding rule: a manifest total rounds to the row’s weightsGb as written, exact for the shipped nine-decimal rows', bytesMatchRecipe(510296921671, 510.3) && bytesMatchRecipe(510311037316, 510.3) && !bytesMatchRecipe(510360000000, 510.3) && !bytesMatchRecipe(510240000000, 510.3) && bytesMatchRecipe(510311045295, 510.311045295) && !bytesMatchRecipe(510311045296, 510.311045295) && bytesMatchRecipe(4096, 4096 / 1e9) && !bytesMatchRecipe(4097, 4096 / 1e9))
assert.ok(bank.bankCandidates().every(path => path.startsWith(home + '/')) && bank.bankFolder() === undefined, 'the proof looks for a bank only inside its scratch home')
check('with no bank folder on this computer the private row has no manifest and the row says so', keptWeights.pinnedWeightManifest(owner) === undefined && keptWeights.weightManifestWords(owner) === 'no bank folder on this computer · b banks the weights' && !bank.bankState(owner).banked)
const bankFolder = join(home, 'mercury-model-bank')
const canonical = bank.bankModelFolder(bankFolder, owner)
ownerFolder(canonical)
const manifest = keptWeights.pinnedWeightManifest(owner)
check('the owner’s folder shape (SHA256SUMS over the 49 LFS files, config and tokenizer files unsealed, Hub download receipts) builds a manifest: sha256 from SHA256SUMS, git blob sha1 for the rest, every file on the disk the engine boots from', Boolean(manifest) && manifest!.files.length === 48 + 1 + Object.keys(smallFiles).length && manifest!.files.filter(file => file.sha256).length === 49 && manifest!.files.filter(file => file.git).length === Object.keys(smallFiles).length && manifest!.files.find(file => file.path === 'config.json')?.git === gitBlob(smallFiles['config.json']!) && manifest!.files.find(file => file.path === 'model-00001-of-00048.safetensors')?.sha256 === sha256('shard 0'))
check('the manifest carries the model, the empty include, the receipts’ revision and the folder’s bytes, which round to the row’s 510.3 GB', manifest!.model === MODEL && manifest!.include === '' && manifest!.revision === REVISION && manifest!.files.reduce((n, file) => n + file.size, 0) === SHARD_BYTES + smallBytes && bytesMatchRecipe(SHARD_BYTES + smallBytes, 510.3))
check('the manifest is the same object for the three private rows of the model and comes from the bank', keptWeights.resolvedWeightManifest(owner)?.source === 'bank' && keptWeights.pinnedWeightManifest(recipes.find(row => row.id === 'deepseek41-uncensored-gb300')!) === manifest)
const state = bank.bankState(owner)
check('the Bank names the banked folder while the sealed files remain eligible to mirror', state.banked && state.sealed && state.pinned && state.missing === 0 && state.files === manifest!.files.length && state.path === canonical && bank.bankRowWords(owner, state) === 'Bank · banked on ~/mercury-model-bank')
check('the model’s weight files for a bank job are the manifest’s, read as sealed by the bank, so a verification is reported against the download, not a pinned manifest', bank.bankFiles(owner, canonical).pinned && bank.bankFiles(owner, canonical).sealedByBank && bank.bankDownloadPlan(owner).revision === REVISION && bank.bankDownloadPlan(owner).include.length === manifest!.files.length)
const repoNamed = join(bankFolder, MODEL.split('/')[1]!)
renameSync(canonical, repoNamed)
check('the same folder under its bare <repo> name is found by the bank and builds the same manifest', bank.bankModelPath(bankFolder, owner) === repoNamed && bank.bankState(owner).banked && bank.bankState(owner).path === repoNamed && keptWeights.pinnedWeightManifest(owner)?.revision === REVISION)
renameSync(repoNamed, canonical)
ownerFolder(canonical, { sums: false })
check('a folder with no SHA256SUMS stays ineligible and the Bank row offers to bank its weights', keptWeights.pinnedWeightManifest(owner) === undefined && keptWeights.weightManifestWords(owner) === 'no SHA256SUMS in ' + canonical + ' · b banks the weights and seals one' && !bank.bankState(owner).banked && bank.bankRowWords(owner) === 'Bank · b to bank · 510 GB')
ownerFolder(canonical, { receipts: false })
check('a receipt-less folder keeps the missing revision in its detail and the Bank row names the folder', keptWeights.pinnedWeightManifest(owner) === undefined && keptWeights.weightManifestWords(owner) === 'no Hugging Face revision is recorded for the bank · b bank again records one' && bank.bankRowWords(owner) === 'Bank · banked on ~/mercury-model-bank')
writePrivate([privateRow('deepseek41-uncensored-b200', 'B200', 180, { source: 'https://huggingface.co/' + MODEL + '/tree/' + 'f'.repeat(40) }), tinyRow])
check('a recipe whose source names a revision lends it to a receipt-less bank', keptWeights.pinnedWeightManifest(currentHostRecipes().find(row => row.id === 'deepseek41-uncensored-b200')!)?.revision === 'f'.repeat(40))
writePrivate([privateRow('deepseek41-uncensored-b200', 'B200', 180, { weightsGb: 400 }), tinyRow])
check('a bank whose bytes do not match the row is refused with both numbers', keptWeights.weightManifestWords(currentHostRecipes().find(row => row.id === 'deepseek41-uncensored-b200')!) === 'the bank holds 510.30 GB of files but the recipe says 400 GB')
writePrivate([privateRow('deepseek41-uncensored-b200', 'B200', 180), privateRow('deepseek41-uncensored-b300', 'B300', 288), privateRow('deepseek41-uncensored-gb300', 'GB300', 288), tinyRow])
ownerFolder(canonical, { dropShard: 7, sizesJson: true })
const partial = keptWeights.pinnedWeightManifest(owner)
check('a shard missing from the folder takes its size from SIZES.json, so the manifest still builds while the Bank shows the folder incomplete', Boolean(partial) && partial!.files.find(file => file.path === 'model-00007-of-00048.safetensors')?.size === shardSizes[6] && !bank.bankState(owner).banked && bank.bankState(owner).missing === 1 && bank.bankState(owner).files === partial!.files.length)
ownerFolder(canonical, { dropShard: 7 })
check('a shard missing without SIZES.json names the file and asks to resume', keptWeights.weightManifestWords(owner) === 'model-00007-of-00048.safetensors is named in SHA256SUMS but is missing from the bank · b resumes the download')
ownerFolder(canonical)
const pinnedManifest = keptWeights.pinnedWeightManifest(owner)!
volumes.writeKeptVolume({ id: 'fixture-volume-kept', name: 'mercury-weights-kept', model: MODEL, include: '', recipeRow: { ...owner, weightManifest: pinnedManifest }, kind: 'network', dataCenter: 'EU-NL-1', size: 650, price: 45.5, createdAt: new Date().toISOString(), state: 'kept' })
rmSync(bankFolder, { recursive: true, force: true })
check('once a weights disk carries the pinned row, the manifest resolves from the disk with the bank drive unplugged, so a rental verifies against the same hashes', keptWeights.resolvedWeightManifest(owner)?.source === 'volume' && keptWeights.pinnedWeightManifest(owner)?.revision === REVISION && keptWeights.pinnedWeightManifest(recipes.find(row => row.id === 'deepseek41-uncensored-b300')!)?.files.length === pinnedManifest.files.length && JSON.stringify(keptWeights.weightManifest(owner)) === JSON.stringify(pinnedManifest))
volumes.writeKeptVolume({ ...volumes.readKeptVolume('fixture-volume-kept')!, state: 'gone' })
check('a gone disk no longer lends its manifest', keptWeights.pinnedWeightManifest(owner) === undefined)
const tinyFolder = bank.bankModelFolder(bankFolder, tiny)
mkdirSync(tinyFolder, { recursive: true })
writeFileSync(join(tinyFolder, 'model-00001-of-00001.safetensors'), tinyShard)
writeFileSync(join(tinyFolder, 'model.safetensors.index.json'), tinyWeights)
writeFileSync(join(tinyFolder, 'config.json'), '{}')
writeFileSync(join(tinyFolder, 'SHA256SUMS'), sha256(tinyShard) + '  model-00001-of-00001.safetensors\n')
mkdirSync(join(tinyFolder, '.cache/huggingface/trees'), { recursive: true })
writeFileSync(join(tinyFolder, '.cache/huggingface/trees', 'e'.repeat(40) + '.json'), '{}')
check('a tiny private bank sealed over its one LFS file verifies every file: the shard against SHA256SUMS, the unsealed files against their git sha1, reported as a check against the download', keptWeights.pinnedWeightManifest(tiny)?.revision === 'e'.repeat(40) && (await bank.verifyBank(tiny, bankFolder, new AbortController().signal)).check === 'download' && bank.bankState(tiny).check === 'download' && bank.bankState(tiny).verifiedAt !== undefined)
const flipped = Buffer.from(tinyShard); flipped[9] = flipped[9]! ^ 0xff
writeFileSync(join(tinyFolder, 'model-00001-of-00001.safetensors'), flipped)
check('a flipped byte in a sealed file fails the verification against SHA256SUMS and names the file', await bank.verifyBank(tiny, bankFolder, new AbortController().signal).then(() => false, (error: Error) => error.message === 'model-00001-of-00001.safetensors · hash differs from the pinned manifest'))
writeFileSync(join(tinyFolder, 'model-00001-of-00001.safetensors'), tinyShard)
check('bankManifest reads a folder on its own, so the Bank’s folder scan can weigh a candidate folder without the registry', bankManifest(tiny, tinyFolder).manifest?.files.length === 3 && bankManifest(tiny, join(home, 'nowhere')).reason === 'not banked · b banks the weights')
console.log('FAST-LOAD PRIVATE PART 1 GREEN — ' + checks + ' checks; the manifest road from the owner’s bank folder shape')

const { KEY, mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')
const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
const { runpodFixture, fakeSshRunner, liveCatalogue } = await import('./runpodFixture.mjs')
const f = await llmhostFixture()
f.state.dialect = 'sglang'; f.state.window = 131072
process.env.HOME = f.home
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
  const liveRows = currentHostRecipes()
  check('the drive’s private file is the owner’s shape: every shipped row plus his three private rows', liveRows.length === shipped.recipes.length + 3 && liveRows.some(row => row.id === 'qwen38-27b-rtx-pro-6000'))
  const live = liveRows.find(row => row.id === 'deepseek41-uncensored-b200')!
  const driveBank = join(f.home, 'mercury-model-bank')
  const driveFolder = bank.bankModelFolder(driveBank, live)
  ownerFolder(driveFolder)
  const notices = (): string[] => { const dir = join(f.home, 'host', 'notices'); try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).words as string) } catch { return [] } }
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const jobs: Promise<void>[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, pauseMs: 10, readyTimeoutMs: 2000, sessionId: 'fast-load-private-proof', startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 10, timeoutMs: 4000, keepAlive: false })) } })
  const open = () => popup.openSettingsPopup(llmHostPopupRequest(road))
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 120, height: 44 }, React.createElement(SettingsPopupSlot)))), 120, 44)
  const screen = () => mounted!.screen()
  const flat = () => screen().replace(/[│\s]+/g, ' ')
  const until = async (needle: string) => assert.ok(await waitFor(() => screen().includes(needle), 20000), 'screen reaches ' + needle + '\n' + screen())
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
  const row = (title: string) => mounted!.lines().find(line => line.includes(title)) ?? ''
  const noKeys = (name: string) => check(name + ' renders without errors or keys', !screen().includes('RENDER ERROR') && !screen().includes(rp.key))
  const openModel = async () => { open(); await heading('Which model?'); await choose('DeepSeek-V4.1-Flash UNCENSORED'); await heading('DeepSeek-V4.1-Flash UNCENSORED'); await until('WEIGHTS') }
  await openModel()
  check('the private model shows the banked folder and weight size with m mirror in the action keys', flat().includes('Bank · banked on ~/mercury-model-bank') && flat().includes('m mirror') && flat().includes('WEIGHTS · 510 GB · banked on ~/mercury-model-bank') && !flat().includes('mirroring unavailable'))
  noKeys('the private model screen')
  await choose('Connect Runpod'); await heading('Runpod API key'); mounted!.push(rp.key); await until('********'); mounted!.push(KEY.enter)
  await until('No stock · watch')
  check('with no B200 in stock the model screen offers no rental and names the watch; nothing was created', !flat().includes('Rent · ') && rp.state.creates === 0 && rp.state.volumeCreates === 0)
  await press('Bank · banked on', 'm'); await heading('How?')
  check('m opens the mirror road for the private row with the volume kinds', screen().includes('network volume') && screen().includes('global volume'))
  await choose('network volume'); await heading('Where should'); await until('EU-NL-1'); await choose('EU-NL-1'); await heading('When should')
  check('the When screen says the fill pod is the cheapest in stock with room, any GPU shape', flat().includes('Prepare now rents the cheapest pod in stock with room for the weights (any GPU shape; it only downloads)'))
  await choose('Prepare now'); await heading('Confirm weights disk')
  check('the confirm names the 650 GB disk, $45.50/month, and the fill pod: a temporary 1× RTX PRO 6000 pod at $2.49/hr, the cheapest in stock, not the 4× B200 shape; nothing created yet', flat().includes('650 GB disk · EU-NL-1') && flat().includes('$45.50/month') && flat().includes('a temporary 1× RTX PRO 6000 pod at $2.49/hr (the cheapest in stock in EU-NL-1 with room for the weights; filling a disk needs no particular GPU)') && !flat().includes('B200 pod') && flat().includes('Confirm $45.50/month + temporary pod 1× RTX PRO 6000 $2.49/hr') && rp.state.volumeCreates === 0 && rp.state.creates === 0)
  await choose('Confirm $'); await until('preparing')
  assert.ok(await waitFor(() => volumes.keptVolumes().some(volume => volume.state === 'kept'), 20000), 'the fill pod verifies the weights on the volume\n' + screen())
  await Promise.all(jobs.splice(0))
  const kept = volumes.keptVolumes().find(volume => volume.model === MODEL)!
  const fillBody = rp.state.createBodies[0]
  check('the fill pod was a single RTX PRO 6000 in EU-NL-1 with the new disk mounted at /workspace, created once, then terminated and read back absent', rp.state.volumeCreates === 1 && rp.state.creates === 1 && fillBody.gpu.id === 'NVIDIA RTX PRO 6000 Blackwell Server Edition' && fillBody.gpu.count === 1 && fillBody.dataCenterIds[0] === 'EU-NL-1' && fillBody.mounts.network[0].volumeId === kept.id && !fillBody.mounts.persistent && rp.state.deletes === 1 && rp.state.pods.size === 0)
  const liveManifest = keptWeights.pinnedWeightManifest(live)!
  check('the disk’s row pins the bank-built manifest, and the pod verified exactly those files and bytes against it', kept.state === 'kept' && kept.dataCenter === 'EU-NL-1' && kept.size === 650 && kept.recipeRow?.weightManifest?.revision === REVISION && kept.recipeRow.weightManifest.files.length === liveManifest.files.length && kept.verifiedSums?.files === liveManifest.files.length && kept.verifiedSums.bytes === liveManifest.files.reduce((n, file) => n + file.size, 0) && kept.verifiedSums.check === 'full' && ssh.state.weightFetches === 1 && ssh.state.fullChecks === 1)
  check('the fill pod’s own record carried the fill shape and the pinned manifest, not the 4× B200 shape', notices().some(words => words.includes('weights kept on ' + kept.id) && words.includes('temporary pod fixture-pod-1 terminated')) && rp.requests.some((request: any) => request.method === 'POST' && request.path === '/v2/pods' && request.body.gpu.count === 1))
  await close(); await openModel(); await until(kept.id + ' · kept')
  check('after the mirror the Bank row names the kept disk while the weights line names the local folder', flat().includes('Bank · banked on ~/mercury-model-bank · ' + kept.id + ' · kept') && flat().includes('WEIGHTS · 510 GB · banked on ~/mercury-model-bank'))
  noKeys('the model screen after the mirror')
  await close()
  open(); await heading('Which model?'); await choose('More options'); await heading('Where should the model run?'); await choose('Bank · your weights'); await heading('Bank'); await select('DeepSeek-V4.1-Flash UNCENSORE'); await until('✓ EU-NL-1')
  check('the Bank screen shows the private row banked with its volume, boot estimate and monthly total', row('DeepSeek-V4.1-Flash UNCENSORE').includes('✓ ~') && /✓ EU-NL-1 · boots ~\d+ min/.test(row('DeepSeek-V4.1-Flash UNCENSORE')) && flat().includes('volumes: 1 · 510 GB · $45.50/month'))
  await close()
  rmSync(driveBank, { recursive: true, force: true })
  rp.state.customGpus = liveCatalogue.gpus.map((gpu: any) => gpu.id === 'NVIDIA B200' ? { ...gpu, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', name: 'EU-NL-1', availability: 'HIGH' }] } : gpu)
  await openModel(); await until('Rent · Runpod 4× B200')
  check('with the bank drive unplugged and B200 back in stock, the rental row names its price and the Bank row offers to bank again', row('Rent · Runpod 4× B200').includes('$31.96/hr') && flat().includes('WEIGHTS · 510 GB · not banked') && flat().includes('Bank · b to bank · 510 GB · ' + kept.id + ' · kept') && keptWeights.resolvedWeightManifest(live)?.source === 'volume')
  await choose('Rent · Runpod 4× B200'); await heading('Confirm the hourly price')
  check('the rental confirmation names the GPU shape, hourly price and kept disk with its boot estimate', flat().includes('4× B200') && flat().includes('$31.96/hr') && flat().includes('Weights: weights disk ' + kept.id + ' · EU-NL-1 · ~' + bank.bootMinutes(live, kept) + ' min') && flat().includes('$45.50/month') && rp.state.creates === 1)
  await choose('Confirm $31.96/hr')
  assert.ok(await waitFor(() => hostRecords().some(record => record.jobKind === 'setup' && !record.prepareWeightsOnly && record.jobState === 'ready'), 30000), 'the rental reaches ready\n' + screen())
  await Promise.all(jobs.splice(0))
  const rental = hostRecords().find(record => record.jobKind === 'setup' && !record.prepareWeightsOnly)!
  const rentBody = rp.state.createBodies[1]
  check('the rental is a 4× B200 pod in EU-NL-1 with the kept disk attached; the pod passed a sampled check against the pinned manifest and skipped the download', rentBody.gpu.id === 'NVIDIA B200' && rentBody.gpu.count === 4 && rentBody.dataCenterIds[0] === 'EU-NL-1' && rentBody.mounts.network[0].volumeId === kept.id && rental.volumeId === kept.id && rental.recipeRow?.weightManifest?.revision === REVISION && ssh.state.weightFetches === 1 && ssh.state.sampledChecks === 1 && (readHostRecord(rental.id)?.weightsCheck ?? '').includes('sampled check passed') && ssh.commands.some(command => command.command === 'ssh' && String(command.args.at(-1)).includes('weights kept · verified · download skipped')))
  check('no request left the loopback fixtures', escaped.length === 0)
  console.log('FAST-LOAD PRIVATE DRIVE GREEN — ' + checks + ' checks; the owner’s road end to end on the fixtures: private row with no manifest → m → network volume → EU-NL-1 → Prepare now → 1× RTX PRO 6000 fill pod at $2.49/hr → kept → a 4× B200 rental attaches the disk and skips the download; zero billable calls')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); f.close(); globalThis.fetch = nativeFetch }

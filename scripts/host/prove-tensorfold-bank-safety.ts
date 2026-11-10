import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
const { runpodFixture, fakeSshRunner, liveCatalogue } = await import('./runpodFixture.mjs')
const f = await llmhostFixture()
const rp = await runpodFixture()
process.env.HOME = f.home
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.href); throw new Error('loopback only') }
  return nativeFetch(input, init)
}, nativeFetch)
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const { mirrorToVolume } = await import('../../src/services/host/fastLoad.ts')
  const { bankModelFolder, rememberBankFolder, sealBank, bankState } = await import('../../src/services/host/bank.ts')
  const { pinnedWeightManifest } = await import('../../src/services/host/keptWeights.ts')
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { keptVolumes } = await import('../../src/services/host/volumes.ts')
  writeStoredRunpodApiKey(rp.key)
  const shipped = currentHostRecipes().filter((row: any) => row.engine === 'tensorfold')
  console.log('SHIPPED', shipped.length, 'WITHOUT_MANIFEST', shipped.filter((row: any) => !pinnedWeightManifest(row)).length)
  const files = {
    'config.json': Buffer.from('{"model_type":"qwen3_5"}'),
    'model.safetensors.index.json': Buffer.from('{"weight_map":{"weight":"model.safetensors"}}'),
    'model.safetensors': Buffer.from('fixture weights'),
    'tokenizer.json': Buffer.from('{"fixture":true}'),
  }
  const bytes = Object.values(files).reduce((n, data) => n + data.length, 0)
  const recipe = { ...shipped.find(row => row.id === 'tensorfold-qwen35-2b-rtx-3090')!, id: 'tensorfold-bank-fixture', weightsGb: bytes / 1e9 }
  rp.state.customGpus = liveCatalogue.gpus.filter((row: any) => row.id === 'NVIDIA GeForce RTX 3090').map((row: any) => ({ ...row, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }))
  const folder = rememberBankFolder(join(f.home, 'bank'))
  const path = bankModelFolder(folder, recipe)
  mkdirSync(join(path, '.cache/huggingface/download'), { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(path, name), data)
    writeFileSync(join(path, '.cache/huggingface/download', name + '.metadata'), 'a'.repeat(40) + '\n' + createHash('sha256').update(data).digest('hex') + '\n')
  }
  await sealBank(recipe, folder, new AbortController().signal)
  const manifest = pinnedWeightManifest(recipe)
  console.log('BANKED', bankState(recipe).banked, 'MANIFEST', Boolean(manifest), 'FILES', manifest?.files.length)
  assert.ok(bankState(recipe).banked && manifest)
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const options = { runner: ssh.runner, sessionId: 'tensorfold-bank-fixture', apiBaseUrl: rp.baseUrl, startJob: () => {} }
  const steps: string[] = []
  const words: string[] = []
  await mirrorToVolume(new RunpodClient(rp.key, rp.baseUrl), recipe, async (q: any) => {
    steps.push(q.step)
    if (q.step === 'fast-load-how') return 'network'
    if (q.step === 'fast-load-where') return 'EU-NL-1'
    if (q.step === 'fast-load-when') return 'next'
    if (q.step === 'fast-load-confirm') return 'confirm'
    throw new Error('Unexpected step ' + q.step)
  }, (event: any) => words.push(event.words), new AbortController().signal, options)
  console.log(JSON.stringify({ steps, words, volumeCreates: rp.state.volumeCreates, podCreates: rp.state.creates, volumes: keptVolumes().map((row: any) => ({ id: row.id, state: row.state, engine: row.recipeRow?.engine })), escaped }))
  assert.equal(rp.state.volumeCreates, 0, 'a TensorFold bank cannot sell a kept disk that pod setup refuses')
  assert.equal(rp.requests.length, 0, 'the refused mirror makes no vendor request')
  assert.deepEqual(words, ['TensorFold pulls weights from Hugging Face · kept weights disks are not supported. No volume or pod was created.'], 'the refusal names the unsupported source without promising a mirror')
  const { bankAction, bankDoor } = await import('../../src/services/host/fastLoad.ts')
  const { writeKeptVolume, readKeptVolume } = await import('../../src/services/host/volumes.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  let connections = 0
  const bankOptions = { ...options, api: () => { connections++; return new RunpodClient(rp.key, rp.baseUrl) }, connect: async () => { connections++; return true } }
  await bankAction(recipe, 'mirror', folder, async () => { throw new Error('The unsupported mirror asks no question') }, () => {}, new AbortController().signal, bankOptions)
  assert.equal(connections, 0, 'the Bank mirror key does not connect a vendor')
  assert.equal(rp.requests.length, 0, 'the Bank mirror key makes no vendor request')
  let listed = false
  await bankDoor(async (q: any) => { if (q.step === 'door-bank') listed = q.rows.some((row: any) => row.value === recipe.id && row.label.endsWith('— not supported')); return null }, () => {}, new AbortController().signal, { ...bankOptions, refreshVolumes: async () => {} })
  assert.ok(listed, 'the banked TensorFold row discloses unsupported kept disks')
  const volume = { id: 'old-tensorfold-volume', name: 'old-tensorfold-volume', kind: 'network' as const, model: recipe.model, include: '', dataCenter: 'EU-NL-1', size: 80, price: 5.6, state: 'kept' as const, createdAt: new Date().toISOString(), recipeRow: recipe }
  writeKeptVolume(volume)
  rp.state.volumes.set(volume.id, { id: volume.id, name: volume.name, kind: 'network', size: 80, dataCenter: 'EU-NL-1', type: 'STANDARD' })
  const { chooseWeightsSource } = await import('../../src/services/host/weightsSource.ts')
  const { volumeFitsOffer } = await import('../../src/services/host/fastLoad.ts')
  const { bootsFromVolume } = await import('../../src/services/host/bank.ts')
  for (const choice of ['bank', 'private-repo', 'volume'] as const) {
    const before = rp.requests.length
    let asks = 0
    const refused: string[] = []
    const selected = await chooseWeightsSource({ recipe, vendor: 'runpod', managed: false, volume, token: 'fixture-token' }, undefined, async q => { assert.equal(q.step, 'weights-source'); return asks++ === 0 ? choice : 'back' }, event => refused.push(event.words), new AbortController().signal)
    assert.ok(selected === undefined && rp.requests.length === before && refused.length === 1 && refused[0]!.includes('TensorFold pulls weights from Hugging Face'), choice + ' is refused before any vendor request')
  }
  assert.ok(volumeFitsOffer({ recipe, gpuId: 'fixture', price: 1, dataCenter: 'OTHER-DC' }) && !bootsFromVolume(recipe, volume.dataCenter), 'an unusable old disk neither hides other data centres nor promises a fast boot')
  const client = new RunpodClient(rp.key, rp.baseUrl)
  const { rentalVolume } = await import('../../src/services/host/volumes.ts')
  const beforeVolumeRead = rp.requests.length
  assert.equal(await rentalVolume(client, recipe), undefined, 'the stock-watch rental reader refuses the old TensorFold disk')
  assert.equal(rp.requests.length, beforeVolumeRead, 'the unsupported Runpod disk triggers no rental volume request')
  const offer = (await client.offers(new AbortController().signal)).find(row => row.recipe.engine === 'tensorfold' && row.recipe.model === recipe.model && row.dataCenter === volume.dataCenter)!
  assert.ok(offer, 'the old disk has a matching TensorFold rental in its data centre')
  const queued: import('../../src/services/host/store.ts').HostRecord[] = []
  const rental = createHostRoad({ ...options, startJob: record => { queued.push(record) } })
  let sourceRow = ''
  await rental(async q => {
    if (q.step === 'door-models') return 'other'
    if (q.step === 'where') return 'rent'
    if (q.step === 'rental-vendor') return 'runpod'
    if (q.step === 'budget') return ''
    if (q.step === 'models') return offer.recipe.label.split(' · ')[0]!
    if (q.step === 'offers') return '0'
    if (q.step === 'rent-confirm') { sourceRow = q.rows!.find(row => row.value === 'weights-source')!.label; return 'rent' }
    return null
  }, () => {}, new AbortController().signal)
  const bought = queued[0]
  const createBody = rp.state.createBodies.at(-1)
  console.log('LEGACY_DISK_RENTAL', JSON.stringify({ sourceRow, volumeId: bought?.volumeId, source: bought?.weightsSource, mounts: createBody?.mounts }))
  assert.ok(bought && bought.weightsSource?.kind === 'huggingface' && !bought.volumeId && !createBody?.mounts?.network && sourceRow.includes('Hugging Face'), 'a new TensorFold rental ignores the old disk and confirms Hugging Face before creation')
  await client.terminate(bought.id)
  const { removeHostRecord } = await import('../../src/services/host/store.ts')
  removeHostRecord(bought.id)
  const { vastFixture } = await import('./vastFixture.mjs')
  const { VastClient } = await import('../../src/services/host/vendors/vast.ts')
  const { vastRentalVolume } = await import('../../src/services/host/vastVolumes.ts')
  const vast = await vastFixture()
  try {
    const old = { ...volume, id: '20118480', kind: 'vast' as const, machineId: 9102 }
    writeKeptVolume(old)
    vast.state.volumes.set(20118480, { id: 20118480, label: old.name, status: 'active', machine_id: 9102, disk_space: 80, storage_cost: 0.1, start_date: 1792490400 })
    const api = new VastClient(vast.key, vast.baseUrl)
    const shape = { ...offer, recipe, machineId: 9102 }
    assert.equal(await vastRentalVolume(api, recipe, shape), undefined, 'a TensorFold rental never attaches an older Vast volume')
    assert.equal(vast.requests.length, 0, 'an unsupported Vast disk does not trigger a rental volume read')
    assert.equal(api.keptMachine(recipe), undefined, 'an old TensorFold disk does not constrain the stock watch to its machine')
    const supported = { ...recipe, engine: 'vllm' as const }
    assert.equal((await vastRentalVolume(api, supported, { ...shape, recipe: supported }))?.id, old.id, 'a supported engine still attaches its same-machine Vast disk')
    const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
    saveVendorKey('vast', vast.key)
    vast.state.customOffers = [{ id: 102, gpu_name: 'RTX 3090', gpu_ram: 24 * 1024, num_gpus: 1, dph_total: 0.5, machine_id: 9102, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000 }]
    let shapeWords = ''
    let detailWords = ''
    const vastRoad = createHostRoad({ ...options, vendorApiBaseUrls: { vast: vast.baseUrl } })
    await vastRoad(async q => {
      if (q.step === 'door-models') return 'other'
      if (q.step === 'where') return 'rent'
      if (q.step === 'rental-vendor') return 'vast'
      if (q.step === 'budget') return ''
      if (q.step === 'models') return recipe.label.split(' · ')[0]!
      if (q.step === 'offers') { shapeWords = q.rows!.filter(row => row.label.includes('machine 9102')).map(row => row.label).join('\n'); return '0' }
      if (q.step === 'rent-confirm') { detailWords = [...(q.lines ?? []), q.found].join('\n'); return 'cancel' }
      return null
    }, () => {}, new AbortController().signal)
    assert.ok(shapeWords.includes('machine 9102') && !shapeWords.includes('boots from your volume') && detailWords.includes('RTX 3090') && !detailWords.includes('not this one'), 'a Vast TensorFold shape and confirmation make no unusable-disk boot or wrong-machine claim')
    saveVendorKey('vast', null)
  } finally { await vast.close() }
  const road = createHostRoad({ ...options })
  let paid = false
  const removed = await road(async (q: any) => {
    if (q.step === 'door-models') return 'pods'
    if (q.step === 'paid-pods') { paid = q.rows.some((row: any) => row.value === 'volume:' + volume.id && row.label.includes('$5.60/month')); return 'volume:' + volume.id }
    if (q.step === 'volume-delete') return 'delete'
    return null
  }, () => {}, new AbortController().signal)
  assert.ok(paid && removed.ok && !rp.state.volumes.has(volume.id) && readKeptVolume(volume.id)?.state === 'gone', 'an older billed TensorFold volume stays listed and is deleted through Machines I’m paying for')
  assert.ok(bankState(recipe).banked, 'deleting the old volume leaves the local bank intact')
  assert.deepEqual(escaped, [], 'no request left the loopback fixtures')
  console.log('TENSORFOLD BANK SAFETY GREEN — 23 checks; vendor requests 0 on refused source and mirror roads')
} finally { ssh?.close(); await rp.close(); f.close(); globalThis.fetch = nativeFetch }

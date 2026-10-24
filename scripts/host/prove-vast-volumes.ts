import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = join(process.env.MERCURY_CONFIG_DIR, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const { VastClient, VAST_VOLUME_MOUNT, VAST_VOLUME_NOTICE } = await import('../../src/services/host/vendors/vast.ts')
const { HostCreateError, HostVendorShapeError } = await import('../../src/services/host/vendors/http.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { vastFixture } = await import('./vastFixture.mjs')
const volumes = await import('../../src/services/host/volumes.ts')
const vastVolumes = await import('../../src/services/host/vastVolumes.ts')
const { engineCacheExports } = await import('../../src/services/host/ssh.ts')
const b200 = HOST_RECIPES.find(row => row.id === 'deepseek41-b200')!
assert.ok(b200 && b200.count === 4 && b200.gpu === 'B200', 'the shipped 4× B200 row is the shape the owner’s private rows copy')
const fixture = await vastFixture()
const signal = () => AbortSignal.timeout(10000)
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureFixtureFixtureFixtureFixtureFixtureFixture mercury'
try {
  const client = new VastClient(fixture.key, fixture.baseUrl, { readyTimeoutMs: 300, pollMs: 5 })
  const offers = await client.volumeOffers(556, undefined, signal())
  const search = fixture.state.volumeSearches.at(-1)
  check('volume offers come from POST /api/v0/volumes/search/ with the documented filter grammar (verified, external=false, disk_space ≥ the size, allocated_storage for pricing) and are read by machine, size and $/GB-month', fixture.requests.some(row => row.path === '/api/v0/volumes/search/' && row.method === 'POST') && search.verified.eq === true && search.external.eq === false && search.disk_space.gte === 556 && search.allocated_storage === 556 && offers.length === 3 && offers[0]!.machineId === 9102 && offers[0]!.storageCost === 0.1 && offers[0]!.hostingType === 'community host' && offers[1]!.machineId === 9103 && offers[1]!.storageCost === 0.2 && offers[1]!.hostingType === 'datacenter' && offers[1]!.diskGb === 2000 && offers[1]!.geolocation === 'NL')
  const onMachine = await client.volumeOffers(556, 9103, signal())
  check('a machine filter sends machine_id:{eq} and keeps only that machine', fixture.state.volumeSearches.at(-1).machine_id.eq === 9103 && onMachine.length === 1 && onMachine[0]!.machineId === 9103)
  check('a size no machine sells leaves the list empty instead of a smaller volume', (await client.volumeOffers(3000, undefined, signal())).length === 0)
  const shapes = await client.recipeOffers([b200], signal())
  check('every rental offer carries the machine id Vast lists it on', shapes.length === 1 && shapes[0]!.machineId === 9103 && shapes[0]!.hostingType === 'datacenter')
  await assert.rejects(client.createVolume(onMachine[0]!, 556, 'mercury-weights-bad'), /letters, digits and underscores/)
  await assert.rejects(client.createVolume(onMachine[0]!, 2500, 'mercury_weights_big'), /sells at most 2000 GB/)
  check('a bad name or an oversize volume is refused before any request', fixture.state.volumeCreates === 0)
  const created = await client.createVolume(onMachine[0]!, 556, 'mercury_weights_abc123', signal())
  const put = fixture.requests.find(row => row.path === '/api/v0/volumes/' && row.method === 'PUT')
  check('create is PUT /api/v0/volumes/ with {id: the volume offer, size: integer GB, name}; the answer names the volume (V.<id>) and Mercury finds it in the list by the name it gave', put && put.body.id === 701 && put.body.size === 556 && put.body.name === 'mercury_weights_abc123' && created.id === 20118481 && created.name === 'mercury_weights_abc123' && created.machineId === 9103 && created.diskGb === 556 && created.status === 'active' && fixture.state.volumeCreates === 1)
  const list = fixture.requests.filter(row => row.path === '/api/v0/volumes' && row.method === 'GET').at(-1)
  check('the list is GET /api/v0/volumes?owner=me&type=local_volume, the CLI’s exact query', list && list.query.owner === 'me' && list.query.type === 'local_volume')
  for (const shape of ['array', 'data', 'volumes'] as const) {
    fixture.state.volumeListShape = shape
    const rows = await client.volumes(signal())
    check('the volume list reads the ' + shape + ' shape', rows.length === 1 && rows[0]!.id === 20118481 && rows[0]!.hourly !== undefined && Math.abs(rows[0]!.hourly * 720 - 111.2) < 0.01 && rows[0]!.instances.length === 0)
  }
  fixture.state.volumeListShape = 'bad'
  await assert.rejects(client.volumes(signal()), (error: unknown) => error instanceof HostVendorShapeError && /shape Mercury does not read \(an object with volumes\)/.test(String(error)))
  check('an unreadable volume list names its shape instead of a bare unreadable response', true)
  fixture.state.volumeListShape = 'volumes'
  fixture.state.volumeCreateStatus = 400
  await assert.rejects(client.createVolume(onMachine[0]!, 556, 'mercury_weights_refused', signal()), (error: unknown) => error instanceof HostCreateError && error.outcome === 'refused')
  fixture.state.volumeCreateStatus = 0
  fixture.state.ambiguousVolumeCreate = 'disconnect'
  await assert.rejects(client.createVolume(onMachine[0]!, 556, 'mercury_weights_cut', signal()), (error: unknown) => error instanceof HostCreateError && error.outcome === 'ambiguous')
  fixture.state.ambiguousVolumeCreate = 'unlisted'
  await assert.rejects(client.createVolume(onMachine[0]!, 556, 'mercury_weights_ghost', signal()), (error: unknown) => error instanceof HostCreateError && error.outcome === 'ambiguous' && /does not list it yet; it may bill/.test(String(error)))
  fixture.state.ambiguousVolumeCreate = false
  check('a refused create says refused; a dropped connection or an accepted-but-unlisted volume is honestly ambiguous (may bill, check Storage), never a second create', fixture.state.volumeCreates === 4 && [...fixture.state.volumes.keys()].length === 2)
  const cut = [...fixture.state.volumes.values()].find(row => row.label === 'mercury_weights_cut')!
  await client.deleteVolume(cut.id)
  const del = fixture.requests.filter(row => row.path === '/api/v0/volumes/' && row.method === 'DELETE').at(-1)
  check('delete sends the id both ways Vast documents (?id= as the CLI, {id} in the body as the API reference) and is verified absent by re-listing', del && del.query.id === String(cut.id) && del.body.id === cut.id && !fixture.state.volumes.has(cut.id) && fixture.requests.filter(row => row.path === '/api/v0/volumes' && row.method === 'GET').length > 0)
  await client.deleteVolume(cut.id)
  check('deleting an already absent volume is a 404 read as gone, verified by the list', fixture.state.volumeDeletes === 2)
  fixture.state.holdVolumeDelete = true
  await assert.rejects(client.deleteVolume(created.id), /still lists volume 20118481; the deletion is not verified and it may still bill/)
  fixture.state.holdVolumeDelete = false
  check('a volume Vast keeps listing after the delete is reported unverified and billing, never deleted', fixture.state.volumes.has(created.id))
  const fill = await client.machineOffers(b200, 9103, signal())
  check('the fill instance search asks for that machine only, any GPU count, a 30 GB container disk, cheapest first: a 1× RTX PRO 6000 at $1.35/hr, not the 4× B200 at $9.25/hr', fill.length === 2 && fill[0]!.recipe.count === 1 && fill[0]!.gpuId === 'NVIDIA RTX PRO 6000 Blackwell' && fill[0]!.price < 1.4 && fill[0]!.recipe.diskGb === 30 && fill[0]!.machineId === 9103 && fill[1]!.recipe.count === 4 && fixture.requests.filter(row => row.path === '/api/v0/bundles/').at(-1)!.body.machine_id.eq === 9103 && fixture.requests.filter(row => row.path === '/api/v0/bundles/').at(-1)!.body.num_gpus === undefined)
  await assert.rejects(client.create(shapes[0]!, key, 'mercury-wrong', { id: String(created.id), kind: 'vast', machineId: 9999 }), /lives on Vast.ai machine 9999/)
  await assert.rejects(client.create(shapes[0]!, key, 'mercury-wrong', { id: 'net-1', kind: 'network', dataCenter: 'EU-NL-1' }), /Runpod weights disk cannot be attached/)
  check('an offer on another machine, or a Runpod disk, is refused before any request', fixture.state.creates === 0)
  const pod = await client.create(fill[0]!, key, 'mercury-fill-1', { id: String(created.id), kind: 'vast', machineId: 9103 })
  const body = fixture.state.createBodies[0]
  check('attach-at-create sends the documented volume_info {create_new:false, volume_id, mount_path} and mounts the volume at /workspace/mercury-weights', pod.id === '7001' && body.ask === 106 && body.volume_info.create_new === false && body.volume_info.volume_id === created.id && body.volume_info.mount_path === VAST_VOLUME_MOUNT && VAST_VOLUME_MOUNT === '/workspace/mercury-weights' && fixture.state.pods.get(7001).volume_id === created.id)
  check('the volume list now names the instance using it', (await client.volumes(signal()))[0]!.instances.join(',') === '7001')
  await assert.rejects(client.deleteVolume(created.id, undefined), /returned HTTP 400/)
  check('Vast refuses to delete a volume an instance still uses; Mercury reports the refusal and the volume still exists', fixture.state.volumes.has(created.id))
  await client.terminate('7001')
  check('terminating the instance frees the volume for deletion', fixture.state.pods.size === 0 && (await client.volumes(signal()))[0]!.instances.length === 0)
  fixture.state.customOffers = [
    { id: 301, gpu_name: 'B200', gpu_ram: 192 * 1024, num_gpus: 4, dph_total: 9.9, machine_id: 9103, datacenter: true, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000 },
    { id: 302, gpu_name: 'B200', gpu_ram: 192 * 1024, num_gpus: 4, dph_total: 9.25, machine_id: 9999, datacenter: true, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000 },
  ]
  check('with no kept volume the stock watch takes the cheapest machine', (await client.watchOffer(b200, 20, signal()))!.machineId === 9999)
  const record = await vastVolumes.createVastKeptVolume(client, b200, onMachine[0]!, 556, signal())
  check('the kept-volume record carries the machine, the size, the $/GB-month rate and the monthly amount, and its state words say so', record.kind === 'vast' && record.id === '20118485' && record.machineId === 9103 && record.size === 556 && record.storageCost === 0.2 && record.price === 111.2 && record.state === 'preparing' && record.mountPath === VAST_VOLUME_MOUNT && vastVolumes.vastVolumeState(b200).startsWith('preparing on Vast.ai machine 9103 · $111.20/month for its 556 GB ($0.20/GB-month, the machine’s rate), with or without an instance'))
  volumes.writeKeptVolume({ ...record, state: 'kept', verifiedSums: { sha256: 'a'.repeat(64), files: 77, bytes: 510296921671, at: new Date().toISOString() } })
  check('the kept words are the row’s promise: weights kept on the machine, size and billing, a rental there boots in minutes, other machines download', /^weights kept on Vast.ai machine 9103 \(556 GB, \$111\.20\/month for its 556 GB \(\$0\.20\/GB-month, the machine’s rate\), with or without an instance\) · a rental on that machine boots in ~\d+ min · other machines download$/.test(vastVolumes.vastVolumeState(b200)))
  check('with a kept volume on machine 9103 the stock watch prefers that machine even at a higher price', (await client.watchOffer(b200, 20, signal()))!.machineId === 9103)
  const machineOffers = fixture.state.customOffers
  fixture.state.customOffers = machineOffers.filter(row => row.machine_id !== 9103)
  check('a kept-volume stock watch never rents another machine when its own machine has no stock', await client.watchOffer(b200, 20, signal()) === undefined)
  fixture.state.customOffers = machineOffers
  const same = (await client.recipeOffers([b200], signal())).find(row => row.machineId === 9103)!
  const other = (await client.recipeOffers([b200], signal())).find(row => row.machineId === 9999)!
  check('a rental on the volume’s machine attaches it; a rental elsewhere does not', (await vastVolumes.vastRentalVolume(client, b200, same, signal()))?.id === '20118485' && (await vastVolumes.vastRentalVolume(client, b200, other, signal())) === undefined && vastVolumes.vastBootsFromVolume(b200, 9103) && !vastVolumes.vastBootsFromVolume(b200, 9999))
  check('Runpod’s own readers never touch a Vast.ai record', !volumes.runpodKeptVolumes().some(row => row.id === '20118485') && volumes.keptVolumes().some(row => row.id === '20118485' && row.kind === 'vast'))
  fixture.state.volumes.clear()
  await vastVolumes.reconcileVastVolumes(client, signal())
  check('a volume Vast no longer lists is marked gone and the row says not kept', volumes.readKeptVolume('20118485')?.state === 'gone' && vastVolumes.vastVolumeState(b200).startsWith('not kept on Vast.ai'))
  const cache = engineCacheExports('/workspace/mercury-weights/engine-cache')
  check('the launch command points every engine cache at the volume: SGLang’s cache dir and its DeepGEMM cache, DeepGEMM’s own JIT cache, FlashInfer, Torch inductor, Triton, CUDA and vLLM', ['SGLANG_CACHE_DIR=\'/workspace/mercury-weights/engine-cache/sglang\'', 'SGLANG_DG_CACHE_DIR=\'/workspace/mercury-weights/engine-cache/sglang/deep_gemm\'', 'DG_JIT_CACHE_DIR=\'/workspace/mercury-weights/engine-cache/deep_gemm\'', 'FLASHINFER_WORKSPACE_BASE=\'/workspace/mercury-weights/engine-cache\'', 'TORCHINDUCTOR_CACHE_DIR=\'/workspace/mercury-weights/engine-cache/inductor\'', 'TRITON_CACHE_DIR=\'/workspace/mercury-weights/engine-cache/triton\'', 'CUDA_CACHE_PATH=\'/workspace/mercury-weights/engine-cache/nv\'', 'VLLM_CACHE_ROOT=\'/workspace/mercury-weights/engine-cache/vllm\''].every(line => cache.includes('export ' + line)) && cache.startsWith("mkdir -p '/workspace/mercury-weights/engine-cache'\n"))
  check('the volume notice tells the user what Vast sells: one machine, per GB-month with or without an instance, no resize or move', /one physical machine/.test(VAST_VOLUME_NOTICE) && /per GB-month/.test(VAST_VOLUME_NOTICE) && /cannot be resized or moved/.test(VAST_VOLUME_NOTICE))
  check('no request carried the key in a path or left the fixture', fixture.requests.every(row => row.authorization === 'Bearer ' + fixture.key && !row.path.includes(fixture.key)))
  console.log('VAST VOLUMES GREEN — ' + checks + ' checks; search, create, list, delete (verified absent), attach-at-create and the machine-bound records on the fixture; zero billable calls')
} finally { await fixture.close() }

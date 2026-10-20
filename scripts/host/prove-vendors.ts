import assert from 'node:assert/strict'
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { VastClient, VAST_STORAGE_NOTICE, VAST_GPU_NAMES } from '../../src/services/host/vendors/vast.ts'
import { LambdaClient, LAMBDA_STORAGE_NOTICE, LAMBDA_USER_DATA, lambdaGpu } from '../../src/services/host/vendors/lambda.ts'
import { HostCreateError } from '../../src/services/host/vendors/http.ts'
import { runpodVendor, type HostVendor } from '../../src/services/host/vendors/vendor.ts'
import { RunpodClient } from '../../src/services/host/runpod.ts'
import { HOST_RECIPES, recipeFits } from '../../src/services/host/recipes.ts'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import { runpodFixture } from './runpodFixture.mjs'

const home = process.env.MERCURY_CONFIG_DIR
assert.ok(home && !resolve(home).startsWith(join(homedir(), '.mercury')), 'a scratch config home outside the real config is required')
mkdirSync(home, { recursive: true })
let checks = 0
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('PASS ' + name) }
const signal = () => new AbortController().signal
const key = 'ssh-ed25519 Zml4dHVyZS1wdWJsaWM= mercury-fixture'
const originalFetch = globalThis.fetch
const fetches: { url: string; init?: RequestInit }[] = []
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'proof traffic stays on loopback')
  fetches.push({ url: String(url), init })
  return originalFetch(input, init)
}) as typeof fetch
const recipeFile = join(home, 'vendor-recipes.json')
const previousRecipes = process.env.MERCURY_HOST_RECIPES_FILE
const fixtureRecipe = { ...HOST_RECIPES.find(row => row.id === 'glm53-flash-b200-community')!, vramGb: 180 }
const override = () => {
  writeFileSync(recipeFile, JSON.stringify({ version: 1, publishedAt: '2026-10-20', recipes: [fixtureRecipe] }))
  process.env.MERCURY_HOST_RECIPES_FILE = recipeFile
}
const resetRecipes = () => { if (previousRecipes === undefined) delete process.env.MERCURY_HOST_RECIPES_FILE; else process.env.MERCURY_HOST_RECIPES_FILE = previousRecipes }
const expectFailure = async (work: () => Promise<unknown>, pattern: RegExp): Promise<Error> => {
  try { await work() } catch (error) { assert.ok(error instanceof Error); assert.match(error.message, pattern); return error }
  throw new Error('Expected failure: ' + pattern)
}
try {
  const secrets = await import('../../src/services/providers/providerSecrets.ts')
  secrets.writeStoredRunpodApiKey('fixture-runpod-preserved')
  secrets.writeStoredVastApiKey(' fixture-vast ')
  secrets.writeStoredLambdaApiKey(' fixture-lambda ')
  check('both key slots trim, coexist and preserve the Runpod key', secrets.readStoredVastApiKey() === 'fixture-vast' && secrets.readStoredLambdaApiKey() === 'fixture-lambda' && secrets.readStoredRunpodApiKey() === 'fixture-runpod-preserved')
  check('vendor keys use the private auth-scoped store', secrets.providerSecretsPathForDisplay().startsWith(home) && (statSync(secrets.providerSecretsPathForDisplay()).mode & 0o777) === 0o600)
  secrets.writeStoredVastApiKey(null); secrets.writeStoredLambdaApiKey(' ')
  check('keys clear independently without losing another vendor', secrets.readStoredVastApiKey() === undefined && secrets.readStoredLambdaApiKey() === undefined && secrets.readStoredRunpodApiKey() === 'fixture-runpod-preserved')
  check('no vendor secrets select a model family', !existsSync(join(home, '.sign-ins.json')))

  const vast = await vastFixture()
  const lambda = await lambdaFixture()
  const runpod = await runpodFixture()
  try {
    const v = new VastClient(vast.key, vast.baseUrl)
    const l = new LambdaClient(lambda.key, lambda.baseUrl)
    const vendors: HostVendor[] = [runpodVendor(new RunpodClient(runpod.key, runpod.baseUrl)), v, l]
    check('Runpod, Vast.ai and Lambda implement one typed contract', vendors.map(row => row.vendor).join(',') === 'runpod,vast,lambda' && vendors.every(row => row.label && row.keyHelp.startsWith('Create') && Array.isArray(row.shapes())))
    check('Runpod wrapper retains bound instance methods', (await vendors[0]!.pods()).length === 0)
    check('capabilities and words describe root-disk deletion and no Lambda stop', v.capabilities.stop && !l.capabilities.stop && !v.capabilities.dataCenters && l.capabilities.dataCenters && v.capabilities.persistentDisk === 'root' && l.capabilities.persistentDisk === 'root' && /terminate deletes/.test(VAST_STORAGE_NOTICE) && /not termination/.test(LAMBDA_STORAGE_NOTICE))
    for (const Client of [VastClient, LambdaClient]) for (const base of ['https://example.com/api/v1', 'http://localhost/api/v1', 'https://cloud.lambda.ai/api/v1?key=bad', 'https://user:pass@cloud.lambda.ai/api/v1']) assert.throws(() => new Client('fixture', base))
    check('vendor credentials cannot be sent to arbitrary origins or URL credentials', true)

    const offers = await v.offers(signal())
    await expectFailure(() => v.create(offers[0]!, 'not-a-public-key', 'bad-key'), /OpenSSH public key/)
    check('Vast validates SSH key before any rent request', vast.state.creates === 0)
    const b200 = offers.find(row => row.recipe.id === 'glm53-flash-b200-community')!
    check('Vast uses total dph_total including allocated disk, not price times count', b200 && b200.price === 9.28 && b200.recipe.count === 4)
    check('Vast GPU map preserves per-GPU memory and Blackwell identity', offers.some(row => row.recipe.id === 'qwen38-27b-h200') && offers.some(row => row.gpuId === 'NVIDIA RTX PRO 6000 Blackwell') && VAST_GPU_NAMES['B300'] === 'NVIDIA B300' && offers.every(row => recipeFits(row.recipe, row.gpuId, row.recipe.vramGb, row.recipe.count)))
    check('Vast searches verified rentable reliable direct-SSH on-demand capacity and CUDA/disk floors', vast.requests.filter(row => row.path.endsWith('/bundles/')).every(row => row.body.verified.eq === true && row.body.reliability.gte === 0.99 && row.body.direct_port_count.gte === 1 && row.body.cuda_max_good.gte === 13 && row.body.type === 'ondemand' && row.body.allocated_storage === row.body.disk_space.gte && row.body.num_gpus.eq > 0))
    const p = await v.create(b200, key, 'mercury-vast')
    const create = vast.requests.find(row => row.path.startsWith('/api/v0/asks/'))!
    check('Vast rents exact offer once with recipe image/disk and public-key bootstrap', create.path === '/api/v0/asks/103/' && create.body.image === b200.recipe.image && create.body.disk === b200.recipe.diskGb && create.body.runtype === 'ssh_direct' && create.body.cancel_unavail === true && create.body.env.PUBLIC_KEY === key && create.body.onstart.includes('apt-get install -y openssh-server tmux curl') && create.body.onstart.includes('"$PUBLIC_KEY"') && !('price' in create.body) && vast.state.creates === 1)
    check('Vast returns usable root SSH and current pod price', p.id === '7001' && p.status === 'RUNNING' && p.ssh?.direct?.host === '127.0.0.1' && p.ssh.direct.port === 2222 && p.ssh.direct.username === 'root' && p.cost === 9.315)
    check('Vast requests and reads real log endpoint without forwarding credentials to log storage', (await v.logs(p.id)).includes('[redacted]') && vast.requests.filter(row => row.path.startsWith('/fixture-logs/')).every(row => !row.authorization))
    vast.state.logUrl = 'https://example.com/log'
    check('Vast log URL is constrained rather than an arbitrary fetch', /unavailable/.test(await v.logs(p.id)))
    const stopped = await v.stop(p.id)
    check('Vast stop maps observed stopped state and retains instance disk', stopped.status === 'EXITED' && vast.state.stops === 1 && vast.state.pods.has(Number(p.id)))
    await v.terminate(p.id)
    check('Vast termination is verified with a list read', vast.state.deletes === 1 && !vast.state.pods.size && vast.requests.at(-1)!.path === '/api/v0/instances/')
    check('Vast watch chooses a fitting recipe at the exact price ceiling', (await v.watchOffer(b200.recipe, b200.price))?.recipe.id === b200.recipe.id && await v.watchOffer(b200.recipe, b200.price - 0.0001) === undefined)
    vast.state.noStock = true
    check('Vast no-stock clears stale shapes', (await v.offers(signal())).length === 0 && v.shapes().length === 0)
    vast.state.noStock = false
    const safe = { id: 101, gpu_name: 'H200', gpu_ram: 141 * 1024, num_gpus: 1, dph_total: 2, verification: 'verified', reliability2: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000 }
    for (const patch of [{ verification: 'unverified' }, { reliability2: 0.98 }, { direct_port_count: 0 }, { gpu_ram: 140 * 1024 }, { cuda_max_good: 12.9 }, { disk_space: 10 }, { rentable: false }, { rented: true }, { gpu_name: 'RTX 6000 Ada' }]) {
      vast.state.customOffers = [{ ...safe, ...patch }]
      check('Vast locally rejects unsafe or non-fitting row ' + Object.keys(patch)[0], !(await v.offers(signal())).length)
    }
    await expectFailure(() => v.create({ ...b200 }, key, 'cloned'), /unchanged offer/)
    check('unbound copied offers cannot select a different paid resource', vast.state.creates === 1)

    check('Lambda 180 GB B200 does not falsely satisfy shipped 183/192 GB recipes', (await l.offers(signal())).length === 0)
    override()
    const regional = await l.offers(signal())
    const first = regional[0]!
    check('Lambda maps documented type-list shape to one fitting offer per stocked region', regional.length === 2 && regional.every(row => row.price === 11.96 && recipeFits(row.recipe, row.gpuId, 180, 4)) && regional.map(row => row.dataCenter).join(',') === 'us-east-1,us-west-1')
    check('Lambda reads per-GPU VRAM from description, not system RAM or a guessed GPU capacity', lambdaGpu('H100 (80 GB SXM5)')?.memory === 80 && lambdaGpu('B200') === undefined)
    const launched = await l.create(first, key, 'mercury-lambda')
    const launch = lambda.requests.find(row => row.path.endsWith('/launch'))!
    check('Lambda registers exactly one named key and launches with region/type/key/cloud-init', lambda.state.keyCreates === 1 && launch.body.instance_type_name === 'gpu_4x_b200' && launch.body.region_name === first.dataCenter && launch.body.ssh_key_names.join(',') === 'mercury-host' && launch.body.user_data === LAMBDA_USER_DATA && !launch.body.file_system_names && !launch.body.image)
    const cloudInit = JSON.parse(LAMBDA_USER_DATA.split('\n').slice(1).join('\n'))
    check('Lambda cloud-init prepares writable root workspace and VM container execution', cloudInit.packages.includes('tmux') && cloudInit.packages.includes('curl') && cloudInit.runcmd.some((cmd: string[]) => cmd.join(' ') === 'chown ubuntu:ubuntu /workspace') && cloudInit.runcmd.some((cmd: string[]) => cmd.join(' ') === 'usermod -aG docker ubuntu'))
    check('Lambda polls booting to active then maps ubuntu SSH and total instance cost', launched.status === 'RUNNING' && launched.ssh?.direct?.username === 'ubuntu' && launched.ssh.direct.port === 22 && launched.ssh.direct.host === '127.0.0.1' && launched.cost === 11.96 && lambda.requests.filter(row => row.path === '/api/v1/instances/' + launched.id).length >= 2)
    const beforeStop = lambda.requests.length
    await expectFailure(() => l.stop(launched.id), /Lambda has no stop.*terminate.*deletes/)
    check('Lambda stop refuses without making any request', lambda.requests.length === beforeStop)
    const second = await l.create(first, key.replace('mercury-fixture', 'another-comment'), 'second')
    check('Lambda key registration is idempotent by name and key material', lambda.state.keyCreates === 1 && lambda.state.creates === 2)
    const launches = lambda.requests.filter(row => row.path.endsWith('/launch'))
    check('Lambda launch bucket spaces actual launch arrivals by twelve seconds', launches[1]!.at - launches[0]!.at >= 11980)
    await l.terminate(launched.id); await l.terminate(second.id)
    check('Lambda termination is verified by subsequent instance-list reads', lambda.state.deletes === 2 && !lambda.state.pods.size && lambda.requests.at(-1)!.path === '/api/v1/instances')
    const concurrent = new LambdaClient(lambda.key, lambda.baseUrl)
    await Promise.all([l.pods(), concurrent.pods(), l.get('missing').catch(() => {})])
    check('Lambda one-token request bucket also serializes concurrent clients for the same key', lambda.requests.slice(1).every((row, index) => row.at - lambda.requests[index]!.at >= 980) && /one launch per 12 seconds/.test(l.rateLimitPolicy()))
    lambda.state.noStock = true
    check('Lambda no-stock preserves fitting shapes without sellable regions', !(await l.offers(signal())).length && l.shapes().length === 1 && l.shapes()[0]!.availability === 'NONE')
    lambda.state.noStock = false
    const originalTypes = lambda.state.types
    for (const patch of [{ gpu_description: 'B200 (179 GB SXM6)' }, { specs: { ...originalTypes[0]!.specs, storage_gib: 10 } }, { specs: { ...originalTypes[0]!.specs, gpus: 8 } }, { architecture: 'aarch64' }, { gpu_description: 'B200' }]) {
      lambda.state.types = [{ ...originalTypes[0]!, ...patch }]
      check('Lambda rejects non-fitting or unverified hardware ' + JSON.stringify(patch), !(await l.offers(signal())).length)
    }
    lambda.state.types = originalTypes
    check('Lambda watch respects the whole-instance price ceiling', (await l.watchOffer(fixtureRecipe, 11.96))?.price === 11.96 && await l.watchOffer(fixtureRecipe, 11.95) === undefined)
    lambda.state.keys[0]!.public_key = 'ssh-ed25519 ZGlmZmVyZW50'
    const beforeConflict = lambda.state.creates
    await expectFailure(() => l.create(first, key, 'conflicting-key'), /different public key.*no launch was sent/)
    check('a conflicting mercury-host key never launches an inaccessible VM', lambda.state.creates === beforeConflict)
    const rateStart = lambda.requests.length
    lambda.state.rateLimited = true; lambda.state.retryAfter = '2'
    const rateError = await expectFailure(() => l.pods(), /HTTP 429/)
    lambda.state.rateLimited = false
    await l.pods()
    check('Lambda Retry-After delays the next request and strips the key', lambda.requests[rateStart + 1]!.at - lambda.requests[rateStart]!.at >= 1980 && !rateError.message.includes(lambda.key))
  } finally { await Promise.all([vast.close(), lambda.close(), runpod.close()]); resetRecipes() }

  override()
  const backoff = await vastFixture()
  try {
    backoff.state.rateLimited = 'once'
    const client = new VastClient(backoff.key, backoff.baseUrl)
    check('Vast search backs off a documented refusal without renting', (await client.offers(signal())).length > 0 && backoff.requests[1]!.at - backoff.requests[0]!.at >= 4980 && backoff.state.creates === 0)
  } finally { await backoff.close() }
  await Promise.all(['concurrent', 'uncertain', 'wrong-key'].map(async mode => {
    const fixture = await lambdaFixture()
    try {
      const first = new LambdaClient(fixture.key, fixture.baseUrl)
      const second = new LambdaClient(fixture.key, fixture.baseUrl)
      const a = (await first.offers(signal()))[0]!
      const b = (await second.offers(signal()))[0]!
      fixture.state.ambiguousKey = mode === 'uncertain'
      fixture.state.mismatchKey = mode === 'wrong-key'
      if (mode === 'wrong-key') {
        await expectFailure(() => first.create(a, key, 'wrong-key'), /did not confirm/)
        check('Lambda unconfirmed SSH-key response sends no launch', fixture.state.creates === 0)
      } else {
        const pods = mode === 'concurrent' ? await Promise.all([first.create(a, key, 'first'), second.create(b, key, 'second')]) : [await first.create(a, key, 'uncertain')]
        check('Lambda ' + mode + ' key registration is verified without duplicate POST', fixture.state.keyCreates === 1 && fixture.state.keys.length === 1 && pods.every(pod => pod.ssh?.direct))
      }
    } finally { await fixture.close() }
  }))
  for (const kind of ['vast', 'lambda'] as const) {
    await Promise.all(['disconnect', 'timeout', 'malformed', 'unreadable', 'server', 'stockLoss', 'rateLimited', 'unexpected-status', 'readback', 'still-listed'].map(async mode => {
      const fixture = kind === 'vast' ? await vastFixture() : await lambdaFixture()
      const Client = kind === 'vast' ? VastClient : LambdaClient
      const client = new Client(fixture.key, fixture.baseUrl, { requestTimeoutMs: 1500, readyTimeoutMs: 1500, pollMs: 20 })
      try {
        const offer = (await client.offers(signal()))[0]!
        assert.ok(offer)
        if (kind === 'lambda') fixture.state.keys = [{ id: 'key-1', name: 'mercury-host', public_key: key }]
        if (['disconnect', 'timeout', 'malformed', 'unreadable', 'server'].includes(mode)) fixture.state.ambiguousCreate = mode === 'server' ? true : mode
        if (mode === 'stockLoss') fixture.state.stockLoss = true
        if (mode === 'unexpected-status') fixture.state.createStatus = 409
        if (mode === 'readback') fixture.state.badRead = true
        if (mode === 'still-listed' && kind === 'lambda') fixture.state.bootReads = 0
        if (mode === 'rateLimited') fixture.state.createStatus = 429
        if (mode === 'still-listed') {
          const pod = await client.create(offer, key, 'held-termination')
          fixture.state.holdTerminate = true
          await expectFailure(() => client.terminate(pod.id), /./)
          check(kind + ' never declares termination while list still contains the instance', fixture.state.pods.size === 1 && fixture.state.deletes === 1)
          return
        }
        const refused = mode === 'stockLoss' || mode === 'rateLimited'
        const error = await expectFailure(() => client.create(offer, key, 'money-law'), refused ? /refused it; nothing was rented/ : /instance may exist.*no second create.*Check the instance list/)
        check(kind + ' ' + mode + ' classifies outcome without replay or key exposure', error instanceof HostCreateError && error.outcome === (refused ? 'refused' : 'ambiguous') && fixture.state.creates === 1 && !error.message.includes(fixture.key))
        if (mode === 'readback') check(kind + ' readback failure retains accepted instance ID', error instanceof HostCreateError && Boolean(error.instanceId))
        if (!refused && mode !== 'unexpected-status') check(kind + ' ambiguous response leaves the actual rental discoverable', fixture.state.pods.size === 1 && (await client.pods()).length === 1)
        check(kind + ' create uses a fresh non-keepalive connection', fixture.requests.filter(row => row.path.includes('/asks/') || row.path.endsWith('/launch')).every(row => row.connection === 'close') && fetches.filter(row => row.url.startsWith(fixture.baseUrl) && (row.url.includes('/asks/') || row.url.endsWith('/launch'))).every(row => row.init?.keepalive === false))
      } finally { await fixture.close() }
    }))
  }
  check('all vendor proof requests stayed on loopback', fetches.length > 0)
  console.log('HOST VENDORS GREEN — ' + checks + ' checks; loopback APIs, no account resources or billable requests')
} finally {
  globalThis.fetch = originalFetch
  resetRecipes()
  rmSync(recipeFile, { force: true })
}

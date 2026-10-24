import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const hf = await hfEndpointsFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === 'https://api.endpoints.huggingface.cloud' || url.origin === 'https://huggingface.co') return nativeFetch(new Request(hf.origin + url.pathname + url.search, request))
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.origin); throw new Error('HF proof permits loopback fixtures only') }
  return nativeFetch(input, init)
}, nativeFetch)
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const { HOST_VENDORS, vendorKey, vendorClient } = await import('../../src/services/host/vendors/client.ts')
  check('Hugging Face is the fourth rental provider', HOST_VENDORS.includes('huggingface'))
  const { writeStoredHuggingfaceApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  writeStoredHuggingfaceApiKey(hf.key)
  check('the existing Hugging Face sign-in supplies the rental key', vendorKey('huggingface') === hf.key)
  const { HuggingfaceClient } = await import('../../src/services/host/vendors/huggingface.ts')
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { hostJobReadOnly } = await import('../../src/services/host/retry.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { configuredCompatEndpoints, resolveCompatApiKey } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const signal = new AbortController().signal
  const api = new HuggingfaceClient(hf.key, hf.baseUrl, { pollMs: 5, readyTimeoutMs: 40 })
  const offers = await api.offers(signal)
  const offer = offers.find(row => row.recipe.id === 'qwen38-27b-h200')!
  check('offers use live region, exact GPU count and complete hourly price', offer?.price === 5 && offer.dataCenter === 'gcp/us-south1')
  check('live 8x H200 price is forty dollars, not per-GPU', offers.some(row => row.recipe.count === 8 && row.recipe.gpu === 'H200' && row.price === 40))
  check('510 GB B200 recipe is not fabricated on HF hardware', !offers.some(row => row.recipe.id.startsWith('deepseek41-')))
  check('local-file and multi-node recipes are not offered', offers.every(row => !row.recipe.files && (row.recipe.nodes ?? 1) === 1))
  check('HF is managed and adds no note line to the machine screen', api.capabilities.managed && api.offersNote() === '')
  const selectedRecipe = { ...offers.find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!.recipe, flags: ['--fixture-selected-row'], image: 'fixture/selected-image' }
  const watched = await api.watchOffer(selectedRecipe, 3, signal)
  check('stock watch retains the saved same-id recipe instead of current catalogue defaults', watched?.recipe.flags.includes('--fixture-selected-row') && watched.recipe.image === selectedRecipe.image)
  await assert.rejects(api.create({ ...offer }, '', 'forged-offer'), /unchanged/)
  hf.state.computes[0].quota.maxAccelerators = 0
  const limited = new HuggingfaceClient(hf.key, hf.baseUrl)
  check('quota-free shapes are not rentable but remain visible in shapes', !(await limited.offers(signal)).some(row => row.recipe.id === offer.recipe.id) && limited.shapes().some(row => row.recipe.id === offer.recipe.id))
  hf.state.computes[0].quota.maxAccelerators = 64
  const pod = await api.create(offer, '', 'hf-ready-proof')
  const sent = hf.requests.find(row => row.method === 'POST' && row.path === '/v2/endpoint/fixture-owner')!.body
  check('create retains repo, private auth, single replica and engine image', sent.type === 'private' && sent.model.repository === offer.recipe.model && sent.model.image.sGLang.url === offer.recipe.image && sent.compute.scaling.minReplica === 1 && sent.compute.scaling.maxReplica === 1 && sent.compute.scaling.scaleToZeroTimeout === null)
  check('engine flags and parallelism survive without SSH keys', offer.recipe.flags.every(flag => sent.model.args.includes(flag)) && sent.model.image.sGLang.tensorParallelSize === 1 && !JSON.stringify(sent).includes('ssh'))
  check('pending create is not READY', pod.status === 'PROVISIONING')
  const runner = { async run() { throw new Error('Managed endpoint must never use SSH or a shell') }, tunnel() { throw new Error('Managed endpoint must never tunnel') } }
  const record = queueHostSetup({ id: pod.id, name: pod.name, vendor: 'huggingface', recipe: offer.recipe.id, recipeRow: offer.recipe, price: offer.price, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: hf.baseUrl, sessionId: 'hf-ready' })
  await runHostJob(record.id, record.generation!, { runner, pauseMs: 5, timeoutMs: 5000, keepAlive: false })
  const ready = readHostRecord(record.id)!
  check('managed worker polls to READY without SSH or tunnel', ready.jobState === 'ready' && !ready.target && !ready.sshKey && !ready.localPort)
  const endpoint = configuredCompatEndpoints().find(row => row.name === ready.provider)
  check('READY registers served URL and the existing HF token as compat key', endpoint?.baseUrl === hf.origin + '/v1' && resolveCompatApiKey(process.env, ready.provider)?.key === hf.key)
  check('READY checked a model reply over HF Bearer auth', hf.requests.some(row => row.path === '/v1/chat/completions' && row.authorized))
  check('logs use structured HF route and redact secrets', (await api.logs(pod.id)).includes('Downloading model [redacted]'))
  check('pause is read back and costs zero compute', (await api.stop(pod.id)).status === 'EXITED' && (await api.get(pod.id)).cost === 0)
  check('resume returns to provisioning', (await api.resume(pod.id)).status === 'PROVISIONING')
  await api.terminate(pod.id)
  check('terminate verifies complete listing absence', hf.state.deletes === 1 && !(await api.pods()).some(row => row.id === pod.id))
  removeHostRecord(pod.id)
  for (let i = 0; i < 3; i++) await api.create(offer, '', 'hf-page-' + i)
  check('endpoint listing walks every cursor', (await api.pods()).length === 3 && hf.requests.some(row => row.query.includes('cursor=')))
  hf.state.badCursor = true
  await assert.rejects(api.pods(), /incomplete/)
  check('a truncated list cannot prove termination', true)
  hf.state.badCursor = false
  for (const row of await api.pods()) await api.terminate(row.id)
  hf.state.neverReady = true
  const stuck = await api.create(offer, '', 'hf-never-ready')
  const deletesBeforeSetup = hf.state.deletes
  const queued = queueHostSetup({ id: stuck.id, name: stuck.name, vendor: 'huggingface', recipe: offer.recipe.id, recipeRow: offer.recipe, price: offer.price, startedAt: stuck.createdAt, status: stuck.status, apiBaseUrl: hf.baseUrl, sessionId: 'hf-never-ready' })
  await runHostJob(queued.id, queued.generation!, { runner, pauseMs: 5, timeoutMs: 120, keepAlive: false })
  const guarded = readHostRecord(queued.id)!
  check('never-running endpoint pauses without deletion', guarded.jobState === 'paused' && guarded.status !== 'TERMINATED' && hf.state.deletes === deletesBeforeSetup && hf.state.pods.has('hf-never-ready'))
  check('paused endpoint keeps its billing and recovery choices', guarded.error?.includes('/hr still billing') && guarded.error.includes('Resume or Terminate in /llmhost'))
  const notices = readdirSync(join(f.home, 'host/notices')).map(name => JSON.parse(readFileSync(join(f.home, 'host/notices', name), 'utf8'))).filter(row => row.sessionId === 'hf-never-ready')
  check('never-ready guard publishes exactly one final notice', notices.length === 1 && !JSON.stringify(notices).includes(hf.key))
  hf.state.neverReady = false
  await api.terminate(stuck.id)
  removeHostRecord(stuck.id)
  const marks: string[] = []
  hf.state.failNext = { route: 'GET /v2/endpoint/fixture-owner', status: 429, times: 1, retryAfter: 0.03 }
  const read = hostJobReadOnly({ label: api.label, pauseMs: 1, timeoutMs: 1000, signal, mark: words => marks.push(words) })
  const at = Date.now()
  await read('pod listing', abort => api.pods(abort))
  check('read retry honors Retry-After and recovers', Date.now() - at >= 30 && marks.some(row => row.includes('429')) && marks.some(row => row.includes('recovered')))
  hf.state.ambiguousCreate = true
  const before = hf.state.creates
  await assert.rejects(api.create(offer, '', 'hf-ambiguous'), /may exist/)
  check('uncertain create is never retried', hf.state.creates === before + 1)
  hf.state.ambiguousCreate = false
  await assert.rejects(api.create(offer, '', 'hf-second'), /earlier unanswered/)
  check('account reconciliation prevents a second paid create', hf.state.creates === before + 1)
  const ambiguous = (await api.pods()).find(row => row.name === 'hf-ambiguous')!
  hf.state.holdDelete = true
  await assert.rejects(api.terminate(ambiguous.id), /not verified/)
  check('delete acknowledgement alone never means terminated', hf.state.pods.has('hf-ambiguous'))
  hf.state.holdDelete = false
  await api.terminate(ambiguous.id)
  const poisoned = await api.create(offer, '', 'hf-hostile-url')
  hf.state.endpointUrl = 'https://attacker.example/v1'
  hf.state.bootReads = 0
  await assert.rejects(api.managedEndpoint(poisoned.id), /HF endpoint URL/)
  check('returned foreign URL cannot receive the HF token', escaped.length === 0)
  await api.terminate(poisoned.id)
  for (const [recipeId, engine] of [['mistral-large3-h200', 'vLLM'], ['nemotron35-super-gguf-rtx-pro-6000', 'llamacpp']] as const) {
    const chosen = offers.find(row => row.recipe.id === recipeId)!
    const created = await api.create(chosen, '', 'hf-engine-' + engine.toLowerCase())
    const payload = hf.requests.filter(row => row.method === 'POST' && row.path === '/v2/endpoint/fixture-owner').at(-1)!.body
    check(engine + ' uses the recipe image and retains its engine arguments', payload.model.image[engine].url === chosen.recipe.image && chosen.recipe.flags.every(flag => payload.model.args.includes(flag)))
    check(engine + ' preserves parallelism or the exact GGUF/projector paths', engine === 'vLLM' ? payload.model.image.vLLM.tensorParallelSize === 8 && payload.model.image.vLLM.dataParallelSize === 1 : payload.model.image.llamacpp.modelPath === chosen.recipe.weightFile && payload.model.image.llamacpp.mmprojModelPath === chosen.recipe.mmproj)
    await api.terminate(created.id)
  }
  check('vendor factory returns managed HF client', vendorClient('huggingface', { apiBaseUrl: hf.baseUrl }).capabilities.managed)
  check('all HF requests stay on loopback', escaped.length === 0)
  console.log('HF ENDPOINTS GREEN — ' + checks + ' checks; no real token or endpoint')
} finally { await hf.close(); f.close(); globalThis.fetch = nativeFetch }

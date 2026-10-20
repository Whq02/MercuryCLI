import assert from 'node:assert/strict'
import { heavyWeights } from '../../src/services/host/costs.ts'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trillionKimiFixture, proveKimiReplay } from './trillionKimiFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import type { HostRecord } from '../../src/services/host/store.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const f = await trillionKimiFixture()
const rp = await runpodFixture()
const realFetch = globalThis.fetch
const fetches: { path: string; method?: string; keepalive?: boolean }[] = []
globalThis.fetch = Object.assign(async (input: any, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(url.hostname, '127.0.0.1', 'proof must never contact an external host: ' + url.origin)
  fetches.push({ path: url.pathname, method: init?.method, keepalive: init?.keepalive })
  return realFetch(input, init)
}, { preconnect: realFetch.preconnect }) as typeof fetch
const { hostRunner, closeHostTunnel, startHostEngine } = await import('../../src/services/host/ssh.ts')
const ssh = fakeSshRunner(f.baseUrl, hostRunner)
const ids = new Set<string>()
try {
  if (!process.argv.includes('--kimi-only')) {
    const { HOST_RECIPES, recipeFits } = await import('../../src/services/host/recipes.ts')
    const { exportHostRecipesJson, currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
    const { RunpodClient, RunpodHttpError, cents, clusterCreateRefusal } = await import('../../src/services/host/runpod.ts')
    const { createHostRoad } = await import('../../src/services/host/index.ts')
    const { HostClusterEnded, createHostResource, hostClusterRecord, listHostResources, getHostResource, hostShape, startHostCluster, terminateHostResource } = await import('../../src/services/host/cluster.ts')
    const { hostPriceLines, hostStorageWords } = await import('../../src/services/host/costs.ts')
    const { runHostJob } = await import('../../src/services/host/worker.ts')
    const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
    const { hostDirectory, readHostRecord, removeHostRecord, patchHostRecord } = await import('../../src/services/host/store.ts')
    const { queueHostSetup, queueHostWatch } = await import('../../src/services/host/jobs.ts')
    const bootstrapFixture = await runpodFixture()
    try {
      const bootstrapApi = new RunpodClient(bootstrapFixture.key, bootstrapFixture.baseUrl)
      const vllm = HOST_RECIPES.find(row => row.id === 'mistral-large3-b200')!
      await bootstrapApi.create({ recipe: vllm, gpuId: 'NVIDIA B200', price: 63.92 }, 'ssh-ed25519 Zml4dHVyZQ==', 'entrypoint-proof')
      const encoded = JSON.parse(bootstrapFixture.state.createBodies[0].args)
      check('vLLM overrides its image entrypoint instead of appending bash to vllm serve', encoded.entrypoint.join(' ') === 'bash -lc' && encoded.cmd.length === 1 && encoded.cmd[0].includes('service ssh start'))
      const sglang = HOST_RECIPES.find(row => row.id === 'glm53-b200')!
      await bootstrapApi.create({ recipe: sglang, gpuId: 'NVIDIA B200', price: 63.92 }, 'ssh-ed25519 Zml4dHVyZQ==', 'sglang-bootstrap-proof')
      check('SGLang retains its existing bare bootstrap byte shape', bootstrapFixture.state.createBodies[1].args.startsWith('bash -lc '))
    } finally { await bootstrapFixture.close() }
    const recipe = HOST_RECIPES.find(row => row.id === 'kimi-k3-b200')!
    check('a two-node recipe must not fit a single eight-GPU pod', !recipeFits(recipe, 'NVIDIA B200', 180, 8))
    check('the same recipe fits the fixture two-node cluster shape', recipeFits(recipe, 'NVIDIA B200', 180, 8, 2))
    check('fewer GPUs per node cannot be hidden by the total GPU count', !recipeFits(recipe, 'NVIDIA B200', 180, 4, 4))
    const gpu = (name: string, memory: number, price: number) => ({ id: 'NVIDIA ' + name, name, memory, secure: true, price: { secure: price }, maxCount: { secure: 8 }, availability: 'HIGH', dataCenters: [{ id: 'FIXTURE-DC', availability: 'HIGH' }] })
    rp.state.customGpus = [gpu('B300', 288, 18.99)]
    rp.state.clusterGpus = [gpu('B200', 180, 7.99)]
    writeStoredRunpodApiKey(rp.key)
    const api = new RunpodClient(rp.key, rp.baseUrl)
    const offers = await api.offers(new AbortController().signal)
    const offer = offers.find(row => row.recipe.id === recipe.id)!
    check('cluster catalogue offers use all sixteen GPUs in the hourly total', offer.price === 127.84)
    check('stock comes from CLUSTER availability with the total count', rp.requests.some((row: any) => row.path === '/v2/catalog/gpus' && row.search.includes('product=CLUSTER') && row.search.includes('count=16')))
    rp.state.failClusterCatalogue = true
    const podOnly = await api.offers(new AbortController().signal)
    const clusterReadWords = api.clusterReadError() ?? ''
    const refusedEvents: any[] = []
    await createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, startJob: () => {}, sessionId: 'trillion-proof' })(async q => q.step === 'door-models' ? 'other' : q.step === 'where' ? 'rent' : q.step === 'rental-vendor' ? 'runpod' : q.step === 'budget' ? '' : null, event => refusedEvents.push(event), new AbortController().signal)
    rp.state.failClusterCatalogue = false
    check('a refused cluster catalogue read keeps the single-machine offers, offers no cluster, and says why', podOnly.some(row => (row.recipe.nodes ?? 1) === 1) && !podOnly.some(row => (row.recipe.nodes ?? 1) > 1) && clusterReadWords.includes('cluster catalogue refused this count') && refusedEvents.some(event => String(event.words).startsWith('Cluster stock could not be read, so multi-node shapes are not offered this time')))
    const frames: any[] = []
    let queued: HostRecord | undefined
    const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, startJob: row => { queued = row; ids.add(row.id) }, sessionId: 'trillion-proof' })
    const result = await road(async question => {
      frames.push(question)
      if (question.step === 'door-models') return 'other'; if (question.step === 'where') return 'rent'
      if (question.step === 'rental-vendor') return 'runpod'
      if (question.step === 'budget') return ''
      if (question.step === 'models') return 'Kimi K3'
      if (question.step === 'offers') return question.rows!.find(row => row.label.includes('2 nodes × 8× B200'))!.value
      if (question.step === 'rent-confirm') { check('no billable call before explicit price confirmation', rp.state.clusterCreates === 0); return 'rent' }
      if (question.step === 'pod-controls') return 'close'
      throw new Error('Unexpected question ' + question.step)
    }, () => {}, new AbortController().signal)
    check('price-confirmed road records a cluster family', result.ok && queued?.cluster?.compute.podCount === 2 && queued.nodes?.length === 2)
    const id = queued!.id
    assert.equal(rp.state.clusterCreates, 1)
    assert.equal(rp.state.creates, 0)
    assert.deepEqual(rp.state.clusterCreateBodies[0].compute, { gpuTypeId: 'NVIDIA B200', gpuCountPerPod: 8, podCount: 2 })
    check('one create uses the clusters API, never a pod endpoint', true)
    check('cluster create disables connection reuse', fetches.find(row => row.path === '/v2/clusters' && row.method === 'POST')?.keepalive === false)
    const shapeRow = frames.find(row => row.step === 'offers').rows.find((row: any) => row.label.includes('2 nodes × 8× B200')).label
    const modelRow = frames.find(row => row.step === 'models').rows.find((row: any) => row.value === 'Kimi K3').label
    const confirm = frames.find(row => row.step === 'rent-confirm')
    for (const [name, text] of [['shape row', shapeRow], ['model row', modelRow]]) {
      check(name + ' discloses node count, total compute price, weight size, download time and that a cluster has no Stop, in one line', ['2 nodes × 8× B200', '$127.84/hr', '1.56 TB', '30–60 min', '2 × 2 TB disk', 'no Stop'].every(word => text.includes(word)) && !text.includes('stopped pod') && !text.includes('\n'))
    }
    const confirmation = confirm.found + ' ' + confirm.willRun + ' ' + (confirm.lines ?? []).join(' ')
    check('confirmation discloses node count, total compute price, weight size, download assumption and cluster billing', ['2 nodes × 8× B200', '$127.84/hr', '1.56 TB', '30–60 min', '0.5–1 GB/s', '2 × 2 TB disk', 'also served per token by Kimi', 'https://platform.kimi.ai', 'a cluster has no Stop', 'bills until Terminate', 'above this catalogue rate (runpod.io/pricing)'].every(word => confirmation.includes(word)) && !confirmation.includes('stopped pod'))
    check('the cluster confirmation lines say every node downloads the whole checkpoint and a cluster has no Stop', JSON.stringify(confirm.lines) === JSON.stringify(['2 × 2 TB disk (extra) · weights 1.56 TB', 'each node downloads all 1.56 TB: ~30–60 min at a sustained 0.5–1 GB/s', 'Billing starts now; a cluster has no Stop — it bills until Terminate.', 'Loading is additional; cluster networking bills extra.', 'Cluster GPUs can bill above this catalogue rate (runpod.io/pricing).', 'also served per token by Kimi (https://platform.kimi.ai)', 'a $127.84/hr machine is cheaper only when kept busy']))
    check('Qwen names its model-card per-token alternative without a pinned API price', hostStorageWords(HOST_RECIPES.find(row => row.id === 'qwen38-24t-fp8-b200')!, 127.84).includes('also served per token by Qwen Cloud (https://www.qwencloud.com)'))
    const singleWords = hostStorageWords(HOST_RECIPES.find(row => row.id === 'kimi-k3-b300')!, 8.99 * 8)
    check('single-machine price line computes the requested 8× B300 example and keeps the stopped-pod disk warning', singleWords.includes('$71.92/hr') && singleWords.includes('a stopped pod still bills its disk') && !singleWords.includes('no Stop'))
    check('single-machine confirmation lines keep their form', JSON.stringify(hostPriceLines(HOST_RECIPES.find(row => row.id === 'deepseek-v4-pro-0813-b300')!, 71.92)) === JSON.stringify(['1.1 TB disk (extra) · weights 892.76 GB', 'download alone ~20–30 min; assumes sustained 0.5–1 GB/s', 'Loading is additional; a stopped pod still bills its disk.', 'Billing starts now, including while weights download.', 'also served per token by DeepSeek (https://www.deepseek.com/)', 'a $71.92/hr machine is cheaper only when kept busy']))
    const frameOut = process.argv.indexOf('--frames')
    if (frameOut >= 0) writeFileSync(process.argv[frameOut + 1]!, JSON.stringify(frames, null, 2) + '\n')
    const { trillionFrames } = await import('./trillionFrames.ts')
    await trillionFrames(confirm, check, process.argv.includes('--frame-dir') ? process.argv[process.argv.indexOf('--frame-dir') + 1] : undefined)
    ssh.state.holdHealth = true
    const release = setTimeout(() => { ssh.state.holdHealth = false }, 400)
    try { await runHostJob(id, queued!.generation!, { runner: ssh.runner, pauseMs: 10, timeoutMs: 15000, keepAlive: false }) } finally { clearTimeout(release); ssh.state.holdHealth = false }
    const ready = readHostRecord(id)!
    check('setup dispatch reaches ready through the cluster head', ready.jobState === 'ready')
    check('cluster setup tails the head engine log, so its steps and download progress advance while the head loads', ssh.commands.some((row: any) => row.command === 'ssh' && row.args.includes('22000') && String(row.args.at(-1)).startsWith('dd if=/workspace/mercury-host/kimi-k3-b200/engine.log')) && (ready.steps ?? []).some(row => row.step === 'downloading weights'))
    check('while the head loads, each worker is checked for a stopped engine', ssh.commands.some((row: any) => row.command === 'ssh' && row.args.includes('22001') && String(row.args.at(-1)).includes('MERCURY_ENGINE_GONE')))
    const scripts = ssh.commands.filter((row: any) => row.command === 'ssh' && row.args.at(-1).includes('engine.sh')).map((row: any) => row.args.at(-1).replaceAll("'\\''", "'"))
    check('both SGLang nodes receive the cookbook topology and private head', [0, 1].every(rank => scripts.some((script: string) => script.includes("'--nnodes' '2' '--node-rank' '" + rank + "' '--dist-init-addr' '10.65.0.2:20000'") && script.includes("'--pp-size' '2'") && script.includes("'--tp-size' '8'") && script.includes("'--reasoning-parser' 'kimi_k3'"))))
    check('each node downloads complete weights to the same local model path', scripts.length === 2 && scripts.every((script: string) => script.includes('hf download') && script.includes('/weights')))
    check('the public API is not exposed and the tunnel targets the head', rp.state.clusterCreateBodies[0].ports.join() === '22/tcp' && ssh.commands.some((row: any) => row.command === 'tunnel' && row.args.includes('22000')))
    const families = await listHostResources(api)
    check('paid list shows one family with summed compute, not member pods', families.length === 1 && families[0]!.id === id && families[0]!.cost === 127.84 && families[0]!.nodes?.length === 2)
    const paidFrames: any[] = []
    await road(async q => { paidFrames.push(q); return q.step === 'door-models' ? 'other' : q.step === 'where' ? 'pods' : q.step === 'paid-pods' ? id : 'close' }, () => {}, new AbortController().signal)
    check('paid family row names all nodes and has no unsupported Stop action', paidFrames.find(q => q.step === 'paid-pods').rows[0].label.includes('2 nodes × 8× B200') && !paidFrames.find(q => q.step === 'pod-controls').rows.some((row: any) => row.value === 'stop'))
    rp.state.holdClusterDelete = true
    await assert.rejects(() => terminateHostResource(api, families[0]!), /not yet verified/)
    check('a delete response alone never proves cluster termination', rp.state.clusters.has(id))
    rp.state.holdClusterDelete = false
    const terminated = await road(async q => q.step === 'door-models' ? 'other' : q.step === 'where' ? 'pods' : q.step === 'paid-pods' ? id : q.step === 'pod-controls' || q.step === 'pod-confirm' ? 'terminate' : null, () => {}, new AbortController().signal)
    check('confirmed termination routes to cluster delete and verifies absence', terminated.ok && !readHostRecord(id) && !rp.state.clusters.has(id) && rp.state.deletes === 0)
    for (const outcome of ['lost', 'http503', 'http402']) {
      rp.state.clusterCreateOutcomes.push(outcome)
      const before = rp.state.clusterCreates
      const ambiguous = await road(async q => q.step === 'door-models' ? 'other' : q.step === 'where' ? 'rent' : q.step === 'rental-vendor' ? 'runpod' : q.step === 'budget' ? '' : q.step === 'models' ? 'Kimi K3' : q.step === 'offers' ? q.rows!.find(row => row.label.includes('2 nodes × 8× B200'))!.value : q.step === 'rent-confirm' ? 'rent' : null, () => {}, new AbortController().signal)
      check(outcome + ' is ambiguous, never retried or called a non-create', !ambiguous.ok && ambiguous.words.includes('may exist') && !ambiguous.words.includes('no cluster was created') && rp.state.clusterCreates === before + 1)
      const created = (await listHostResources(api)).at(-1)!
      await terminateHostResource(api, created)
    }
    check('only documented cluster refusal statuses settle a non-create', clusterCreateRefusal(new RunpodHttpError('fixture', 400, '')) !== undefined && clusterCreateRefusal(new RunpodHttpError('fixture', 402, '')) === undefined)
    const notices = (): string[] => { const dir = join(hostDirectory(), 'notices'); return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).map(name => String(JSON.parse(readFileSync(join(dir, name), 'utf8')).words)) : [] }
    rp.state.clusterRatePremium = 1.2
    const watched = queueHostWatch({ id: 'watch-trillion', name: recipe.label, recipe: recipe.id, price: offer.price, maxPrice: offer.price, startedAt: new Date().toISOString(), status: 'WATCHING', apiBaseUrl: rp.baseUrl, sshKey: queued!.sshKey, sessionId: 'trillion-proof' })
    ids.add(watched.id)
    await runHostJob(watched.id, watched.generation!, { runner: ssh.runner, pauseMs: 10, timeoutMs: 15000, keepAlive: false })
    rp.state.clusterRatePremium = 1
    const watchedFamily = (await listHostResources(api))[0]!
    ids.add(watchedFamily.id)
    check('stock watch creates and sets up the complete cluster family', readHostRecord(watchedFamily.id)?.watchedFrom === watched.id && readHostRecord(watchedFamily.id)?.jobState === 'ready')
    check('a cluster billed above the confirmed catalogue figure records the billed rate and says so', cents(readHostRecord(watchedFamily.id)!.price) === 15341 && notices().some(words => words.includes('Runpod bills this cluster at $153.41/hr, above the $127.84/hr catalogue figure that was confirmed')))
    const oldNode = rp.state.clusterNodes.get(watchedFamily.id)[1]
    oldNode.cudaVersion = '12.9'
    await assert.rejects(() => startHostCluster(api, readHostRecord(watchedFamily.id)!, recipe, ssh.runner, new AbortController().signal, 1, 1000, () => {}), (error: Error) => error instanceof HostClusterEnded && /reporting CUDA 12\.9, below the recipe’s 13\.0\. Mercury terminated it through the clusters API and Runpod no longer lists it · about \$\d+\.\d\d billed over \d+ min at \$153\.41\/hr/.test(error.message))
    check('a cluster placed below the recipe CUDA floor is terminated and verified gone, with the cost named', !rp.state.clusters.has(watchedFamily.id))
    removeHostRecord(watchedFamily.id)
    const vllmRecipe = { ...recipe, engine: 'vllm' as const, flags: ['--tensor-parallel-size', '8', '--pipeline-parallel-size', '2'] }
    await startHostEngine(ready.target!, vllmRecipe, ssh.runner, new AbortController().signal, false, true, undefined, undefined, { nodes: 2, rank: 1, head: '10.65.0.2', address: '10.65.0.3' })
    const vllmCommand = ssh.commands.at(-1).args.at(-1).replaceAll("'\\''", "'")
    check('vLLM worker uses its documented multiprocessing launch, private master and headless mode', ["'vllm' 'serve'", "'--nnodes' '2'", "'--node-rank' '1'", "'--master-addr' '10.65.0.2'", "'--headless'"].every(word => vllmCommand.includes(word)))
    const setupOf = async (name: string, startedAt?: string) => {
      const pod = await createHostResource(api, offer, 'ssh-ed25519 Zml4dHVyZQ==', name)
      const row = queueHostSetup({ ...hostClusterRecord(pod), id: pod.id, name: pod.name, recipe: recipe.id, price: offer.price, startedAt: startedAt ?? pod.createdAt, status: pod.status, sessionId: 'trillion-proof', sshKey: queued!.sshKey, apiBaseUrl: rp.baseUrl })
      ids.add(row.id)
      return row
    }
    const lost = await setupOf('lost-node-proof')
    rp.state.clusterNodes.get(lost.id)[1].status = 'ERROR'
    await assert.rejects(() => startHostCluster(api, lost, recipe, ssh.runner, new AbortController().signal, 1, 1000, () => {}), /lost node \S+ \(ERROR\) before setup began\. Mercury terminated it through the clusters API/)
    check('a cluster that loses a node before setup is terminated and verified gone', !rp.state.clusters.has(lost.id))
    removeHostRecord(lost.id)
    const dying = await setupOf('worker-death-proof')
    ssh.state.holdHealth = true
    ssh.state.goneEngines.add(22001)
    const dyingStarted = Date.now()
    try { await assert.rejects(() => startHostCluster(api, dying, recipe, ssh.runner, new AbortController().signal, 10, 15000, () => {}), /\(rank 1\) stopped its engine, so the head cannot finish loading\. fixture worker engine exited: CUDA out of memory/) } finally { ssh.state.holdHealth = false; ssh.state.goneEngines.clear() }
    check('a worker whose engine stops while the head loads ends the wait at once, naming that node, and keeps the downloaded cluster for the owner', Date.now() - dyingStarted < 10_000 && rp.state.clusters.has(dying.id))
    await terminateHostResource(api, (await listHostResources(api)).find(row => row.id === dying.id)!); removeHostRecord(dying.id)
    const stalled = await setupOf('ssh-bound-proof', new Date(Date.now() - 30 * 60_000).toISOString())
    ssh.state.refuse = true
    try { await runHostJob(stalled.id, stalled.generation!, { runner: ssh.runner, pauseMs: 10, timeoutMs: 1500, keepAlive: false }) } finally { ssh.state.refuse = false }
    check('a cluster whose nodes never answer SSH within the placement bound is terminated, verified gone, its record cleared, and the notice names the bound and the cost', !rp.state.clusters.has(stalled.id) && !readHostRecord(stalled.id) && notices().some(words => words.includes('did not bring all 2 nodes up with SSH within 1 min. Mercury terminated it through the clusters API and Runpod no longer lists it · about $6') && words.includes('at $127.84/hr, storage extra')))
    check('shipped JSON exactly matches the source exporter', readFileSync(new URL('../../assets/host/recipes.json', import.meta.url), 'utf8') === exportHostRecipesJson())
    const sourcesRead = new Set(['https://docs.sglang.io/cookbook/autoregressive/Moonshotai/Kimi-K3', 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8', 'https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V4', 'https://docs.sglang.io/cookbook/autoregressive/Xiaomi/MiMo-V2.6', 'https://docs.sglang.io/cookbook/autoregressive/GLM/GLM-5.3', 'https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512'])
    const added = currentHostRecipes().filter(heavyWeights)
    check('all big-tier rows carry documented HTTPS provenance, the context their source states and sufficient disk', added.length === 23 && added.every(row => row.verified.by === 'documented' && sourcesRead.has(row.verified.source) && row.contextPerSlot && row.weightsGb! < row.diskGb))
    const badges: Record<string, string> = { 'kimi-k3-b300': 'verified', 'kimi-k3-b200': 'in-progress', 'kimi-k3-h200': 'in-progress', 'kimi-k3-gb300': 'in-progress', 'qwen38-24t-fp8-h200': 'verified', 'qwen38-24t-fp8-b200': 'verified', 'qwen38-24t-fp8-b300': 'verified', 'qwen38-24t-nvfp4-b300': 'verified', 'deepseek-v4-pro-0813-b200': 'in-progress', 'deepseek-v4-pro-0813-b300': 'in-progress', 'deepseek-v4-pro-0813-gb300': 'verified', 'mimo26-pro-b300': 'verified', 'mimo26-pro-h200': 'in-progress', 'glm53-h200': 'verified', 'glm53-b200': 'verified', 'glm53-b300': 'verified', 'glm53-gb300': 'verified', 'glm53-bf16-h200': 'in-progress', 'glm53-bf16-b200': 'in-progress', 'glm53-bf16-b300': 'verified', 'glm53-bf16-gb300': 'in-progress' }
    const cookbookRows = added.filter(row => row.source.startsWith('https://docs.sglang.io/cookbook/'))
    check('every cookbook big-tier row carries its cookbook cell badge in verified.note and leads its verification with it', cookbookRows.length === Object.keys(badges).length && cookbookRows.every(row => badges[row.id] === row.verified.note && row.verification.startsWith(row.verified.note + ' · ')))
    const kimiH200 = HOST_RECIPES.find(row => row.id === 'kimi-k3-h200')!
    check('the Kimi K3 H200 cluster row is the cookbook’s own in-progress cell: two nodes, TP16/EP16 on Marlin and FlashMLA, its three environment variables, badged in-progress', kimiH200.nodes === 2 && kimiH200.count === 8 && kimiH200.verified.note === 'in-progress' && JSON.stringify(kimiH200.environment) === JSON.stringify({ NCCL_MNNVL_ENABLE: '1', NCCL_CUMEM_ENABLE: '1', SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK: '0' }) && ['--tp-size', '16', '--ep-size', '16', '--moe-runner-backend', 'marlin', '--decode-attention-backend', 'flashmla', '--enable-symm-mem'].every(flag => kimiH200.flags.includes(flag)))
    check('unpublished Mistral 4 and unresolved Prime are never offered as weights', !HOST_RECIPES.some(row => /large.?4|prime|intellect/i.test(row.id + row.model)))
  }
  await proveKimiReplay(f, check)
  console.log('TRILLION TIER GREEN — ' + checks + ' checks; loopback only, no paid resource')
} finally {
  for (const id of ids) closeHostTunnel(id)
  ssh.close()
  await rp.close()
  f.close()
  globalThis.fetch = realFetch
}

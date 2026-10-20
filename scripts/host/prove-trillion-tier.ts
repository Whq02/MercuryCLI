import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
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
    const { RunpodClient, RunpodHttpError, clusterCreateRefusal } = await import('../../src/services/host/runpod.ts')
    const { createHostRoad } = await import('../../src/services/host/index.ts')
    const { listHostResources, getHostResource, hostShape, startHostCluster, terminateHostResource } = await import('../../src/services/host/cluster.ts')
    const { hostStorageWords } = await import('../../src/services/host/costs.ts')
    const { runHostJob } = await import('../../src/services/host/worker.ts')
    const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
    const { readHostRecord, removeHostRecord, patchHostRecord } = await import('../../src/services/host/store.ts')
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
    const frames: any[] = []
    let queued: HostRecord | undefined
    const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, startJob: row => { queued = row; ids.add(row.id) }, sessionId: 'trillion-proof' })
    const result = await road(async question => {
      frames.push(question)
      if (question.step === 'where') return 'rent'
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
    for (const [name, text] of [['shape row', shapeRow], ['model row', modelRow], ['confirmation', confirm.found + ' ' + confirm.willRun]]) {
      check(name + ' discloses node count, total compute price, weight size and download assumption', ['2 nodes × 8× B200', '$127.84/hr', '1.56 TB', '30–60 min', '0.5–1 GB/s', '2 × 2 TB disk', 'also served per token by Kimi', 'https://platform.kimi.ai', 'stopped pod still bills its disk'].every(word => text.includes(word)))
    }
    check('single-machine price line computes the requested 8× B300 example', hostStorageWords(HOST_RECIPES.find(row => row.id === 'kimi-k3-b300')!, 8.99 * 8).includes('$71.92/hr'))
    const frameOut = process.argv.indexOf('--frames')
    if (frameOut >= 0) writeFileSync(process.argv[frameOut + 1]!, JSON.stringify(frames, null, 2) + '\n')
    const { trillionFrames } = await import('./trillionFrames.ts')
    await trillionFrames(confirm, check, process.argv.includes('--frame-dir') ? process.argv[process.argv.indexOf('--frame-dir') + 1] : undefined)
    await runHostJob(id, queued!.generation!, { runner: ssh.runner, pauseMs: 10, timeoutMs: 15000, keepAlive: false })
    const ready = readHostRecord(id)!
    check('setup dispatch reaches ready through the cluster head', ready.jobState === 'ready')
    const scripts = ssh.commands.filter((row: any) => row.command === 'ssh' && row.args.at(-1).includes('engine.sh')).map((row: any) => row.args.at(-1).replaceAll("'\\''", "'"))
    check('both SGLang nodes receive the cookbook topology and private head', [0, 1].every(rank => scripts.some((script: string) => script.includes("'--nnodes' '2' '--node-rank' '" + rank + "' '--dist-init-addr' '10.65.0.2:20000'") && script.includes("'--pp-size' '2'") && script.includes("'--tp-size' '8'") && script.includes("'--reasoning-parser' 'kimi_k3'"))))
    check('each node downloads complete weights to the same local model path', scripts.length === 2 && scripts.every((script: string) => script.includes('hf download') && script.includes('/weights')))
    check('the public API is not exposed and the tunnel targets the head', rp.state.clusterCreateBodies[0].ports.join() === '22/tcp' && ssh.commands.some((row: any) => row.command === 'tunnel' && row.args.includes('22000')))
    const families = await listHostResources(api)
    check('paid list shows one family with summed compute, not member pods', families.length === 1 && families[0]!.id === id && families[0]!.cost === 127.84 && families[0]!.nodes?.length === 2)
    const paidFrames: any[] = []
    await road(async q => { paidFrames.push(q); return q.step === 'where' ? 'pods' : q.step === 'paid-pods' ? id : 'close' }, () => {}, new AbortController().signal)
    check('paid family row names all nodes and has no unsupported Stop action', paidFrames.find(q => q.step === 'paid-pods').rows[0].label.includes('2 nodes × 8× B200') && !paidFrames.find(q => q.step === 'pod-controls').rows.some((row: any) => row.value === 'stop'))
    rp.state.holdClusterDelete = true
    await assert.rejects(() => terminateHostResource(api, families[0]!), /not yet verified/)
    check('a delete response alone never proves cluster termination', rp.state.clusters.has(id))
    rp.state.holdClusterDelete = false
    const terminated = await road(async q => q.step === 'where' ? 'pods' : q.step === 'paid-pods' ? id : q.step === 'pod-controls' || q.step === 'pod-confirm' ? 'terminate' : null, () => {}, new AbortController().signal)
    check('confirmed termination routes to cluster delete and verifies absence', terminated.ok && !readHostRecord(id) && !rp.state.clusters.has(id) && rp.state.deletes === 0)
    for (const outcome of ['lost', 'http503', 'http402']) {
      rp.state.clusterCreateOutcomes.push(outcome)
      const before = rp.state.clusterCreates
      const ambiguous = await road(async q => q.step === 'where' ? 'rent' : q.step === 'budget' ? '' : q.step === 'models' ? 'Kimi K3' : q.step === 'offers' ? q.rows!.find(row => row.label.includes('2 nodes × 8× B200'))!.value : q.step === 'rent-confirm' ? 'rent' : null, () => {}, new AbortController().signal)
      check(outcome + ' is ambiguous, never retried or called a non-create', !ambiguous.ok && ambiguous.words.includes('may exist') && !ambiguous.words.includes('no cluster was created') && rp.state.clusterCreates === before + 1)
      const created = (await listHostResources(api)).at(-1)!
      await terminateHostResource(api, created)
    }
    check('only documented cluster refusal statuses settle a non-create', clusterCreateRefusal(new RunpodHttpError('fixture', 400, '')) !== undefined && clusterCreateRefusal(new RunpodHttpError('fixture', 402, '')) === undefined)
    const watched = queueHostWatch({ id: 'watch-trillion', name: recipe.label, recipe: recipe.id, price: offer.price, maxPrice: offer.price, startedAt: new Date().toISOString(), status: 'WATCHING', apiBaseUrl: rp.baseUrl, sshKey: queued!.sshKey })
    ids.add(watched.id)
    await runHostJob(watched.id, watched.generation!, { runner: ssh.runner, pauseMs: 10, timeoutMs: 15000, keepAlive: false })
    const watchedFamily = (await listHostResources(api))[0]!
    ids.add(watchedFamily.id)
    check('stock watch creates and sets up the complete cluster family', readHostRecord(watchedFamily.id)?.watchedFrom === watched.id && readHostRecord(watchedFamily.id)?.jobState === 'ready')
    const oldNode = rp.state.clusterNodes.get(watchedFamily.id)[1]
    oldNode.cudaVersion = '12.9'
    await assert.rejects(() => startHostCluster(api, readHostRecord(watchedFamily.id)!, recipe, ssh.runner, new AbortController().signal, 1, 1000, () => {}), /does not report CUDA/)
    check('cluster placement validates actual CUDA because cluster create has no CUDA floor field', true)
    oldNode.cudaVersion = '13.0'
    const vllmRecipe = { ...recipe, engine: 'vllm' as const, flags: ['--tensor-parallel-size', '8', '--pipeline-parallel-size', '2'] }
    await startHostEngine(ready.target!, vllmRecipe, ssh.runner, new AbortController().signal, false, true, undefined, { nodes: 2, rank: 1, head: '10.65.0.2', address: '10.65.0.3' })
    const vllmCommand = ssh.commands.at(-1).args.at(-1).replaceAll("'\\''", "'")
    check('vLLM worker uses its documented multiprocessing launch, private master and headless mode', ["'vllm' 'serve'", "'--nnodes' '2'", "'--node-rank' '1'", "'--master-addr' '10.65.0.2'", "'--headless'"].every(word => vllmCommand.includes(word)))
    await terminateHostResource(api, watchedFamily); removeHostRecord(watchedFamily.id)
    check('shipped JSON exactly matches the source exporter', readFileSync(new URL('../../assets/host/recipes.json', import.meta.url), 'utf8') === exportHostRecipesJson())
    const sourcesRead = new Set(['https://docs.sglang.io/cookbook/autoregressive/Moonshotai/Kimi-K3', 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8', 'https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V4', 'https://docs.sglang.io/cookbook/autoregressive/Xiaomi/MiMo-V2.6', 'https://docs.sglang.io/cookbook/autoregressive/GLM/GLM-5.3', 'https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512'])
    const added = currentHostRecipes().filter(row => row.weightsGb !== undefined)
    check('all big-tier rows carry documented HTTPS provenance, context and sufficient disk', added.length === 23 && added.every(row => row.verified.by === 'documented' && sourcesRead.has(row.verified.source) && row.contextPerSlot && row.weightsGb! < row.diskGb))
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

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runpodFixture } from './runpodFixture.mjs'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.TMPDIR ?? '/private/tmp', 'tensorfold-pod-road-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { TENSORFOLD_HOST_VERSION, tensorFoldKeyWriteCommand, tensorFoldReadyCommand } = await import('../../src/services/host/tensorfoldRelease.ts')
const pod = await import('../../src/services/host/tensorfoldPod.ts')
const { hostDirectory, hostRecords, readHostRecord, removeHostRecord, writeHostRecord } = await import('../../src/services/host/store.ts')
const { listBoxes, readBox } = await import('../../src/services/host/boxes.ts')
const { tensorFoldHosts, tensorFoldHostKey } = await import('../../src/services/providers/local/tensorfoldHosts.ts')
const { vendorClient } = await import('../../src/services/host/vendors/client.ts')
const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')

let checks = 0
const check = (name: string, truth: unknown): void => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const bash = (command: string): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
  const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', reject); child.on('exit', status => resolve({ status, stdout, stderr }))
})
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'tensorfold-road-'))
const recipe = HOST_RECIPES.find(row => row.id === 'tensorfold-qwen38-27b-rtx-5090')!
const rp = await runpodFixture()
try {
  const key = pod.tensorFoldPodKey('fixture-pod-1')
  const keyPath = join(hostDirectory(), 'tensorfold', 'fixture-pod-1.key')
  check('Mercury generates the pod key once and holds it at mode 0600 under its host directory', /^[A-Za-z0-9_-]{32}$/.test(key) && pod.tensorFoldPodKey('fixture-pod-1') === key && (statSync(keyPath).mode & 0o777) === 0o600 && readFileSync(keyPath, 'utf8') === key + '\n')
  const remoteDir = join(scratch, 'remote', recipe.id)
  const write = spawnSync('bash', ['-c', tensorFoldKeyWriteCommand(remoteDir, key)], { encoding: 'utf8' })
  check('the key reaches the pod as a one-line mercury[inference] key file at 0600', write.status === 0 && readFileSync(join(remoteDir, 'api-key'), 'utf8') === 'mercury[inference]: ' + key + '\n' && (statSync(join(remoteDir, 'api-key')).mode & 0o777) === 0o600)

  const hits: { path: string; authorization?: string }[] = []
  let health: 'ok' | 'draining' = 'ok'
  const engine = createServer((request, response) => {
    hits.push({ path: request.url ?? '', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) })
    if (request.url === '/health') { response.writeHead(health === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ status: health })); return }
    if (request.headers.authorization !== 'Bearer ' + key) { response.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'missing or invalid API key' } })); return }
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-27b', object: 'model', created: 1, owned_by: 'tensorfold', context_length: 131072, max_model_len: 131072, reasoning: { default_enabled: true, default_effort: 'medium', supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'none'] } }] })); return }
    response.writeHead(404); response.end()
  })
  await new Promise<void>(resolve => engine.listen(0, '127.0.0.1', () => resolve()))
  const port = (engine.address() as { port: number }).port
  const readiness = tensorFoldReadyCommand(remoteDir)
  const onFixture = readiness.replaceAll('127.0.0.1:8080', '127.0.0.1:' + port)
  const ready = await bash(onFixture)
  check('the readiness pair passes on the fixture engine: /health without a key, /v1/models with the key file’s key, and the listing shows owned_by tensorfold', ready.status === 0 && ready.stdout.includes('"owned_by":"tensorfold"') && hits.length === 2 && hits[0]!.path === '/health' && hits[0]!.authorization === undefined && hits[1]!.path === '/v1/models' && hits[1]!.authorization === 'Bearer ' + key)
  health = 'draining'
  const draining = await bash(onFixture)
  check('a draining or parked engine (503 on /health) is not ready and /v1/models is not asked', draining.status !== 0 && hits.length === 3)
  health = 'ok'
  const wrongKey = await bash(onFixture.replace("cut -d ' ' -f 2", 'echo not-the-key; cut -d " " -f 9'))
  check('a wrong key is not ready: the model listing answers 401', wrongKey.status !== 0 && hits.at(-1)!.path === '/v1/models' && hits.at(-1)!.authorization !== 'Bearer ' + key)
  engine.close()

  const remembered: object[] = []
  const written: object[] = []
  const target = { host: '127.0.0.1', port: 22222, user: 'root', key: join(scratch, 'id_ed25519') }
  const registration = await pod.registerTensorFoldPod({ id: 'fixture-pod-1', vendor: 'runpod', recipe, baseUrl: 'http://127.0.0.1:' + port + '/v1', key, served: 'qwen3.8-27b', target, gpu: { name: 'NVIDIA GeForce RTX 5090', memoryGb: 32 } }, async host => { remembered.push(host) }, box => { written.push(box) })
  const host = remembered[0] as Record<string, unknown>
  check('the pod is remembered through rememberTensorFoldHost with origin pod, the key, the chip, the served name, the window and the engine version', remembered.length === 1 && registration.remembered && host.name === 'pod-fixture-pod-1' && host.origin === 'pod' && host.key === key && host.keyRef === 'pod-fixture-pod-1' && host.baseUrl === 'http://127.0.0.1:' + port && host.chip === 'RTX 5090' && host.serving === 'qwen3.8-27b' && host.window === 131072 && host.version === TENSORFOLD_HOST_VERSION)
  const box = written[0] as { name: string; kind: string; os: string; engines: { kind: string; version: string; port: number; path: string }[]; gpus: { name: string; memory: number }[]; target?: object }
  check('the pod is registered as a host box with engine tensorfold on port 8080, its GPU and its SSH target', written.length === 1 && box.name === 'pod-fixture-pod-1' && box.kind === 'ssh' && box.os === 'linux' && box.engines.length === 1 && box.engines[0]!.kind === 'tensorfold' && box.engines[0]!.version === TENSORFOLD_HOST_VERSION && box.engines[0]!.port === 8080 && box.engines[0]!.path.endsWith('/bin/tensorfold-native') && box.gpus[0]!.name === 'NVIDIA GeForce RTX 5090' && box.gpus[0]!.memory === 32 && JSON.stringify(box.target) === JSON.stringify(target))
  const atSeam = await pod.registerTensorFoldPod({ id: 'fixture-pod-2', vendor: 'runpod', recipe, baseUrl: 'http://127.0.0.1:' + port + '/v1', key, served: 'qwen3.8-27b', target })
  check('through the real hosts store (tf-engine-106) the pod is remembered with origin pod and its key, and the box is written beside it', atSeam.remembered === true && tensorFoldHosts().some(row => row.name === 'pod-fixture-pod-2' && row.origin === 'pod' && row.serving === 'qwen3.8-27b') && tensorFoldHostKey('http://127.0.0.1:' + port) === key && readBox('pod-fixture-pod-2')?.engines[0]?.kind === 'tensorfold' && pod.isTensorFoldPodBox(readBox('pod-fixture-pod-2')!) && pod.tensorFoldPodBoxes().some(row => row.name === 'pod-fixture-pod-2'))
  await pod.unregisterTensorFoldPod('fixture-pod-2')
  check('unregistering forgets the host, removes the pod box and forgets the key', !tensorFoldHosts().some(row => row.name === 'pod-fixture-pod-2') && !readBox('pod-fixture-pod-2') && !listBoxes().some(row => row.name === 'pod-fixture-pod-2') && !existsSync(join(hostDirectory(), 'tensorfold', 'fixture-pod-2.key')))

  const startedAt = new Date(Date.now() - 90 * 60_000).toISOString()
  writeHostRecord({ vendor: 'runpod', id: 'fixture-pod-1', name: 'mercury-fixture', recipe: recipe.id, recipeRow: recipe, price: 1.19, startedAt, status: 'RUNNING', jobKind: 'setup', jobState: 'ready', step: 'ready', provider: 'pod-fixture-pod-1', localPort: port, target, apiBaseUrl: rp.baseUrl })
  const facts = pod.tensorFoldPodFacts(readHostRecord('fixture-pod-1')!, recipe, Date.now())!
  check('the pod facts carry the host name, the machine, the GPU, the served name, the window, the price, the elapsed time and the spend for lane 1’s HOST row', facts.hostName === 'pod-fixture-pod-1' && facts.machine === 'Runpod pod fixture-pod-1' && facts.gpu === 'RTX 5090' && facts.title === 'Qwen3.8 27B' && facts.served === 'qwen3.8-27b' && facts.window === 131072 && facts.price === 1.19 && facts.elapsedMs >= 90 * 60_000 - 1000 && Math.abs(facts.spendUSD - 1.19 * 1.5) < 0.01 && facts.state === 'serving' && facts.bills && facts.baseUrl === 'http://127.0.0.1:' + port)
  check('tensorFoldPods lists the pod by host name and skips non-TensorFold records', pod.tensorFoldPodByHost('pod-fixture-pod-1', HOST_RECIPES)?.id === 'fixture-pod-1' && pod.tensorFoldPods(HOST_RECIPES).length === 1 && pod.tensorFoldPodFacts({ ...readHostRecord('fixture-pod-1')!, recipe: 'qwen38-27b-h200', recipeRow: undefined }, HOST_RECIPES.find(row => row.id === 'qwen38-27b-h200')) === undefined)

  const row = pod.tensorFoldRentRow([{ recipe, price: 1.19 }], HOST_RECIPES)!
  const lines = pod.tensorFoldRentCardLines(row)
  check('t23’s card words, with the supported RTX 5090 where the frame modelled an H100: pod · serves · through', lines[0] === 'pod       RTX 5090 32 GB · $1.19/h on Runpod · billing starts when it boots' && lines[1] === 'serves    Qwen3.8 27B at 128k with TensorFold 1.2.2 for CUDA' && lines[2] === 'through   /llmhost rents it, installs TensorFold, pulls, serves, then this session switches · s stops the pod and its billing' && lines.slice(0, 2).every(line => line.length <= 92) && pod.TENSORFOLD_HOST_WORDS.rentRow === 'rent a GPU pod — Runpod, through /llmhost')
  const noStock = pod.tensorFoldRentRow([], HOST_RECIPES)!
  check('without stock the rent row names the RTX 5090 class and sends the price question to /llmhost', noStock.gpu === 'RTX 5090' && noStock.price === undefined && pod.tensorFoldRentCardLines(noStock)[0] === 'pod       RTX 5090 32 GB on Runpod · the price shows in /llmhost · billing starts when it boots')
  check('an unqualified card never leads the rent row even when it is the cheapest in stock', pod.tensorFoldRentRow([{ recipe: HOST_RECIPES.find(own => own.id === 'tensorfold-qwen38-27b-rtx-4090')!, price: 0.5 }, { recipe, price: 1.19 }], HOST_RECIPES)!.gpu === 'RTX 5090')
  check('the card words name why a class is refused or unqualified', pod.tensorFoldCardWords('NVIDIA H100 80GB HBM3') === 'H100 is not offered · the 1.2.2 archive holds no sm_90 machine code and no PTX' && pod.tensorFoldCardWords('NVIDIA GeForce RTX 4090') === 'RTX 4090 · ships · unqualified by TensorFold · sm_89 kernels ship; unqualified by TensorFold' && pod.tensorFoldCardWords('NVIDIA GeForce RTX 5090')!.startsWith('RTX 5090 · supported · ') && pod.tensorFoldCardWords('AMD Instinct MI300X OAM') === undefined)

  writeStoredRunpodApiKey(rp.key)
  const created = await (await fetch(rp.baseUrl + '/pods', { method: 'POST', headers: { Authorization: 'Bearer ' + rp.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'mercury-fixture', image: recipe.image, args: 'bash -lc "sleep infinity"', disk: 30, cloud: 'SECURE', gpu: { id: 'NVIDIA GeForce RTX 5090', count: 1, minCudaVersion: '13.0' }, mounts: { persistent: { size: 80, path: '/workspace' } }, ports: ['22/tcp', '8080/http'], env: { PUBLIC_KEY: 'ssh-ed25519 AAAAfixture', HF_HOME: '/workspace/huggingface' } }) })).json() as { id: string }
  removeHostRecord('fixture-pod-1')
  writeHostRecord({ vendor: 'runpod', id: created.id, name: 'mercury-fixture', recipe: recipe.id, recipeRow: recipe, price: 1.19, startedAt, status: 'RUNNING', jobKind: 'setup', jobState: 'ready', step: 'ready', provider: 'pod-' + created.id, localPort: port, target, apiBaseUrl: rp.baseUrl })
  const forgotten: string[] = []
  const client = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
  const stopped = await pod.stopTensorFoldPod(created.id, { client, pauseMs: 10, forget: async name => { forgotten.push(name) } })
  check('s on the pod row stops the pod: Runpod’s stop was called once, the pod reads EXITED, the record says compute billing ended and the disk bills until Terminate', stopped.ok && rp.state.stops === 1 && readHostRecord(created.id)?.status === 'EXITED' && readHostRecord(created.id)?.jobState === 'stopped' && stopped.words === 'Runpod pod ' + created.id + ' stopped · compute billing ended · ~$1.79 so far · the disk bills until you terminate it in /llmhost' && forgotten[0] === 'pod-' + created.id)
  check('the stopped pod’s facts read stopped and no longer bill compute', pod.tensorFoldPodFacts(readHostRecord(created.id)!, recipe)!.state === 'stopped' && !pod.tensorFoldPodFacts(readHostRecord(created.id)!, recipe)!.bills)
  const again = await pod.stopTensorFoldPod(created.id, { client, pauseMs: 10, forget: async () => {} })
  check('a second s says the pod is already stopped and sends no second stop', again.ok && rp.state.stops === 1 && again.words === 'Runpod pod ' + created.id + ' is already stopped · the disk bills until you terminate it in /llmhost')
  rp.state.failStop = true
  rp.state.pods.get(created.id)!.status = 'RUNNING'
  writeHostRecord({ ...readHostRecord(created.id)!, status: 'RUNNING', jobState: 'ready' })
  const refused = await pod.stopTensorFoldPod(created.id, { client, pauseMs: 10, forget: async () => {} })
  check('a refused stop says compute may still bill and points at /llmhost', !refused.ok && refused.words.includes('compute may still bill') && refused.words.includes('/llmhost → Machines I’m paying for → Stop again or Terminate'))
  const gone = await pod.stopTensorFoldPod('no-such-pod', { client })
  check('s on a pod Mercury no longer records says so without touching the vendor', !gone.ok && gone.words === pod.TENSORFOLD_HOST_WORDS.gone && rp.state.stops === 1)
  check('the gated-model words are on hand for a non-public checkpoint', pod.TENSORFOLD_HOST_WORDS.gated === 'TensorFold pulls public checkpoints only · a gated or private model is not served on a pod yet')
  for (const record of hostRecords()) removeHostRecord(record.id)
  console.log('TENSORFOLD POD ROAD GREEN · ' + checks + ' checks · the engine, Runpod and the host are fixtures; nothing was rented')
} finally {
  await rp.close()
  rmSync(scratch, { recursive: true, force: true })
}

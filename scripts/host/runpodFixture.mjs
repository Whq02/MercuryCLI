import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const sample = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8'))
export const liveCatalogue = sample('catalog-gpus-secure-count1')
const livePod = sample('pod-get-running')
const livePods = sample('pods-list')

export async function runpodFixture() {
  const key = 'fixture-runpod-key-not-a-real-key'
  const requests = []
  const state = { clusters: new Map(), clusterNodes: new Map(), clusterGpus: [], clusterCreateBodies: [], clusterCreateOutcomes: [], clusterCreates: 0, clusterDeletes: 0, clusterCatalogReads: 0, clusterReads: 0, holdClusterDelete: false, clusterCuda: '13.0', pods: new Map(), createBodies: [], keys: [], reads: 0, catalogReads: 0, catalogTimes: [], catalogFailures: [], creates: 0, createOutcomes: [], stops: 0, deletes: 0, noStock: false, stockLoss: false, stockAfterReads: 0, price: 7.99, failCreate: false, stuck: false, failStop: false, customGpus: null, policy: '"minute";q=60;w=60, "hour";q=3000;w=3600, "day";q=50000;w=86400' }
  const gpus = liveCatalogue.gpus
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    requests.push({ method: req.method, path: url.pathname, search: url.search, body })
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...(state.policy ? { 'RateLimit-Policy': state.policy } : {}), ...headers }); res.end(value === undefined ? undefined : JSON.stringify(value)) }
    const problem = (status, title, detail, headers) => send({ title, status, detail }, status, headers)
    if (req.headers.authorization !== 'Bearer ' + key) return send({ error: 'fixture key needed' }, 401)
    if (url.pathname === '/v2/catalog/gpus') {
      assert.equal(url.searchParams.get('include'), 'AVAILABILITY')
      if (url.searchParams.get('product') === 'CLUSTER') {
        state.clusterCatalogReads++
        assert.equal(url.searchParams.get('cloud'), 'SECURE')
        assert.equal(url.searchParams.get('minCudaVersion'), '13.0')
        assert.ok(Number(url.searchParams.get('count')) >= 2)
        return send({ gpus: state.noStock ? state.clusterGpus.map(gpu => ({ ...gpu, availability: 'NONE', dataCenters: [] })) : state.clusterGpus })
      }
      assert.equal(url.searchParams.get('product'), 'POD')
      assert.equal(url.searchParams.get('cloud'), 'SECURE')
      assert.equal(url.searchParams.get('minCudaVersion'), '13.0')
      state.catalogReads++
      state.catalogTimes.push(Date.now())
      const failure = state.catalogFailures.shift()
      if (failure === 429) return problem(429, 'Too Many Requests', 'rate limit exceeded for the minute window', { 'Retry-After': '1' })
      if (failure) return problem(failure, 'Service Unavailable', 'fixture upstream failure')
      if (state.noStock || state.stockLoss && state.catalogReads > 3 || state.stockAfterReads > 0 && state.catalogReads <= state.stockAfterReads) {
        return send({ ...liveCatalogue, gpus: gpus.map(gpu => ({ ...gpu, availability: 'NONE', dataCenters: [] })) })
      }
      if (state.customGpus) return send({ ...liveCatalogue, gpus: state.customGpus })
      if (state.stockAfterReads > 0) {
        return send({ ...liveCatalogue, gpus: gpus.map(gpu => gpu.id === 'NVIDIA B300 SXM6 AC' ? { ...gpu, availability: 'LOW', dataCenters: [{ id: 'EU-NL-1', name: 'EU-NL-1', availability: 'LOW' }] } : gpu) })
      }
      return send(liveCatalogue)
    }
    if (url.pathname === '/v2/clusters' && req.method === 'GET') return send({ clusters: [...state.clusters.values()], pagination: { hasNextPage: false, nextCursor: null } })
    if (url.pathname === '/v2/clusters' && req.method === 'POST') {
      const outcome = state.clusterCreateOutcomes.shift()
      if (outcome === 'refuse') return problem(400, 'Bad Request', 'fixture: cluster shape unavailable')
      if (outcome === 'refuse429') return problem(429, 'Too Many Requests', 'fixture: cluster rate limit', { 'Retry-After': '1' })
      state.clusterCreates++; state.clusterCreateBodies.push(body)
      assert.equal(body.type, 'APPLICATION')
      assert.ok(body.compute.podCount >= 2)
      assert.ok(body.compute.gpuCountPerPod >= 1 && body.compute.gpuCountPerPod <= 8)
      assert.deepEqual(body.ports, ['22/tcp'])
      assert.ok(body.env.PUBLIC_KEY.startsWith('ssh-ed25519 '))
      assert.ok(body.mounts.persistent.size > 0)
      assert.equal(body.gpu, undefined)
      assert.equal(body.cloud, undefined)
      assert.equal(spawnSync('bash', ['-n', '-c', body.args]).status, 0)
      const id = 'fixture-cluster-' + state.clusterCreates
      const nodes = Array.from({ length: body.compute.podCount }, (_, rank) => ({ ...structuredClone(livePod), id: id + '-node-' + rank, name: body.name + '-' + rank, status: 'RUNNING', cudaVersion: state.clusterCuda, cost: (state.clusterGpus.find(gpu => gpu.id === body.compute.gpuTypeId)?.price.secure ?? 7.99) * body.compute.gpuCountPerPod, cluster: { id, rank, ip: '10.65.0.' + (rank + 2) }, createdAt: new Date().toISOString(), ssh: { direct: { host: '127.0.0.1', port: 22000 + rank, username: 'root' } } }))
      const cluster = { id, name: body.name, type: body.type, compute: body.compute, pods: { total: nodes.length, byStatus: { RUNNING: nodes.length } }, primary: { podId: nodes[0].id, status: 'RUNNING' }, createdAt: new Date().toISOString() }
      state.clusters.set(id, cluster); state.clusterNodes.set(id, nodes)
      if (outcome === 'lost') return req.socket.destroy()
      if (outcome === 'http503' || outcome === 'http402') return problem(outcome === 'http503' ? 503 : 402, 'Gateway response', 'fixture: cluster create may have reached the account')
      return send(cluster, 201)
    }
    const clusterMatch = /^\/v2\/clusters\/([^/]+)(\/pods)?$/.exec(url.pathname)
    if (clusterMatch) {
      const cluster = state.clusters.get(clusterMatch[1])
      if (!cluster) return problem(404, 'Not Found', 'fixture: no such cluster')
      if (req.method === 'DELETE') { state.clusterDeletes++; if (!state.holdClusterDelete) { state.clusters.delete(cluster.id); state.clusterNodes.delete(cluster.id) } return send(undefined, 204) }
      state.clusterReads++
      return send(clusterMatch[2] ? { pods: state.clusterNodes.get(cluster.id) } : cluster)
    }
    if (url.pathname === '/v2/account/ssh-keys') { if (req.method === 'PUT') state.keys = body.keys; return send({ keys: state.keys }) }
    if (url.pathname === '/v2/pods' && req.method === 'GET') return send({ ...livePods, pods: [...state.pods.values()], pagination: { hasNextPage: false, nextCursor: null } })
    if (url.pathname === '/v2/pods' && req.method === 'POST') {
      const outcome = state.failCreate ? 'refuse' : state.createOutcomes.shift()
      if (outcome === 'refuse') return problem(400, 'Bad Request', 'fixture: this GPU and data center combination could not be placed')
      if (outcome === 'refuse402') return problem(402, 'Payment Required', 'fixture: insufficient balance')
      state.creates++; state.createBodies.push(body)
      assert.deepEqual(body.ports, ['22/tcp'])
      assert.equal(body.cloud, 'SECURE')
      assert.equal(body.gpu.minCudaVersion, '13.0')
      assert.ok(body.env.PUBLIC_KEY.startsWith('ssh-ed25519 '))
      assert.ok(body.mounts.persistent.size >= 80)
      const syntax = spawnSync('bash', ['-n', '-c', body.args], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, syntax.stderr)
      const gpuEntry = (state.customGpus ?? gpus).find(gpu => gpu.id === body.gpu.id) ?? gpus.find(gpu => gpu.id === body.gpu.id)
      const pod = { ...structuredClone(livePod), id: 'fixture-pod-' + state.creates, name: body.name, status: 'PROVISIONING', cost: gpuEntry.price.secure * body.gpu.count, createdAt: new Date(Date.now() - 60000).toISOString(), startedAt: new Date(Date.now() - 60000).toISOString(), ssh: { direct: null, proxy: null } }
      state.pods.set(pod.id, pod)
      if (outcome === 'lost') return req.socket.destroy()
      if (outcome === 'http503') return problem(503, 'Service Unavailable', 'fixture: the gateway timed out after the create reached the account')
      return send(pod, 201)
    }
    const match = /^\/v2\/pods\/([^/]+)(\/action|\/logs)?$/.exec(url.pathname)
    const pod = match && (state.pods.get(match[1]) ?? [...state.clusterNodes.values()].flat().find(node => node.id === match[1]))
    if (!pod) return send({ error: 'not found' }, 404)
    if (pod.cluster && req.method !== 'GET') return problem(400, 'Bad Request', 'Member pods are managed through the cluster API')
    if (match[2] === '/logs') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: {"source":"container","line":"fixture image pull pending"}\n\n') }
    if (req.method === 'DELETE') { state.deletes++; state.pods.delete(pod.id); return send(undefined, 204) }
    if (match[2] === '/action') { if (state.failStop) return send({ error: 'stop refused' }, 409); assert.equal(body.action, 'stop'); state.stops++; pod.status = 'EXITED'; pod.cost = 0; return send(pod) }
    state.reads++
    if (!state.stuck && pod.status === 'PROVISIONING') { pod.status = 'RUNNING'; pod.ssh = structuredClone(livePod.ssh) }
    return send(pod)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v2', key, state, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

export function fakeSshRunner(modelBaseUrl, actualRunner) {
  assert.equal(new URL(modelBaseUrl).hostname, '127.0.0.1')
  const commands = []
  const children = new Set()
  const state = { refuse: false, failEngine: false, holdHealth: false, docker: true, log: 'MERCURY_STEP installing\nMERCURY_STEP building llama.cpp\nMERCURY_STEP downloading weights\n' }
  const runner = {
    async run(command, args, signal, timeout) {
      commands.push({ command, args })
      if (command === 'ssh-keygen') return actualRunner.run(command, args, signal, timeout)
      assert.ok(['ssh', 'rsync'].includes(command))
      if (state.refuse) throw new Error('fixture SSH connection refused')
      const remote = args.at(-1)
      if (command === 'ssh') {
        const parse = spawnSync('bash', ['-n', '-c', remote], { encoding: 'utf8' })
        assert.equal(parse.status, 0, parse.stderr)
      }
      let output = ''
      if (remote.includes('nvidia-smi')) output = Array.from({ length: 4 }, () => 'NVIDIA B200, 196608').join('\n') + (state.docker ? '\nDOCKER_ENGINE_PRESENT' : '')
      if (remote.includes('/health')) {
        if (state.holdHealth) throw new Error('fixture model loading')
        assert.equal((await fetch(modelBaseUrl + '/models')).status, 200)
        output = 'healthy models'
      }
      if (state.failEngine && remote.includes('launch.log')) throw new Error('launch.log: fixture outer launch permission denied')
      if (remote.includes('tail -n 8')) output = state.log
      if (remote.startsWith('dd if=')) { const offset = Number(/skip=(\d+)/.exec(remote)?.[1] ?? 0); output = state.log.slice(offset, offset + 8192) }
      return actualRunner.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', output], signal)
    },
    tunnel(args) {
      commands.push({ command: 'tunnel', args })
      const forward = args[args.indexOf('-L') + 1]
      assert.match(forward, /^127\.0\.0\.1:\d+:127\.0\.0\.1:30000$/)
      assert.ok(args.includes('ExitOnForwardFailure=yes'))
      const port = Number(forward.split(':')[1])
      const code = "const http=require('node:http'); const base=process.argv[1]; const server=http.createServer(async(req,res)=>{try{let body='';for await(const c of req)body+=c; const out=await fetch(base+req.url,{method:req.method,headers:req.headers,...(body?{body}:{}),redirect:'error'});res.writeHead(out.status,Object.fromEntries(out.headers));res.end(Buffer.from(await out.arrayBuffer()));}catch(e){res.writeHead(502);res.end(String(e));}});server.listen(Number(process.argv[2]),'127.0.0.1');process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});"
      const child = spawn(process.execPath, ['-e', code, modelBaseUrl.replace(/\/v1$/, ''), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
      children.add(child)
      let failure
      child.stderr.on('data', chunk => { failure = String(chunk) })
      child.on('error', error => { failure = error.message })
      child.on('exit', code => { failure = 'fixture tunnel exited ' + code; children.delete(child) })
      return { stop: () => child.kill(), failed: () => failure }
    },
  }
  return { runner, state, commands, close: () => { for (const child of children) child.kill(); children.clear() } }
}

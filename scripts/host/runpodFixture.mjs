import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const sample = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8'))
export const liveCatalogue = sample('catalog-gpus-secure-count1')
const livePod = sample('pod-get-running')
const livePods = sample('pods-list')

export async function runpodFixture() {
  const key = 'fixture-runpod-key-not-a-real-key'
  const requests = []
  const state = { volumes: new Map(), volumeCreates: 0, volumeDeletes: 0, volumeOutcomes: [], volumeBodies: [], volumePageSize: 100, repeatVolumeCursor: false, failVolumeRead: false, pods: new Map(), createBodies: [], keys: [], reads: 0, catalogReads: 0, catalogTimes: [], catalogFailures: [], creates: 0, createOutcomes: [], stops: 0, deletes: 0, noStock: false, stockLoss: false, stockAfterReads: 0, price: 7.99, failCreate: false, stuck: false, failStop: false, failDelete: false, customGpus: null, policy: '"minute";q=60;w=60, "hour";q=3000;w=3600, "day";q=50000;w=86400' }
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
    if (url.pathname === '/v2/catalog/datacenters') return send({ dataCenters: [{ id: 'EU-NL-1', name: 'Netherlands', networkVolumeTypes: ['STANDARD'] }, { id: 'US-CA-2', name: 'California', networkVolumeTypes: ['STANDARD'] }, { id: 'HPS-ONLY', name: 'High performance only', networkVolumeTypes: ['HIGH_PERFORMANCE'] }] })
    const volumeMatch = /^\/v2\/(network|global)-volumes(?:\/([^/]+))?$/.exec(url.pathname)
    if (volumeMatch) {
      const kind = volumeMatch[1]
      const id = volumeMatch[2]
      if (req.method === 'GET') {
        if (state.failVolumeRead) return problem(503, 'Service Unavailable', 'fixture volume list unavailable')
        const all = [...state.volumes.values()].filter(row => row.kind === kind).map(({kind, ...row}) => row)
        const start = Number(url.searchParams.get('cursor') ?? 0)
        const next = start + state.volumePageSize
        return send({ [kind + 'Volumes']: all.slice(start, next), pagination: { hasNextPage: next < all.length || state.repeatVolumeCursor, nextCursor: state.repeatVolumeCursor ? '0' : next < all.length ? String(next) : null } })
      }
      if (req.method === 'POST') {
        const outcome = state.volumeOutcomes.shift()
        if (outcome === 'refuse') return problem(422, 'Unprocessable Entity', 'fixture volume refusal')
        state.volumeCreates++; state.volumeBodies.push(body)
        assert.deepEqual(Object.keys(body).sort(), kind === 'network' ? ['dataCenter', 'name', 'size', 'type'] : ['name'])
        if (kind === 'network') { assert.equal(body.type, 'STANDARD'); assert.ok(body.size >= 10); assert.ok(['EU-NL-1', 'US-CA-2'].includes(body.dataCenter)) }
        const volume = { ...body, id: 'fixture-volume-' + state.volumeCreates, ...(kind === 'global' ? {createdAt: new Date().toISOString(), createdByUserId: 'fixture-user'} : {}) }
        state.volumes.set(volume.id, { ...volume, kind })
        if (outcome === 'lost') return req.socket.destroy()
        if (outcome === 'http503') return problem(503, 'Service Unavailable', 'fixture create reached account')
        return send(volume, 201)
      }
      if (req.method === 'DELETE') {
        if ([...state.pods.values()].some(pod => [...(pod.mounts?.network ?? []), ...(pod.mounts?.global ?? [])].some(row => row.volumeId === id))) return problem(409, 'Conflict', 'volume is attached to a pod')
        state.volumeDeletes++; state.volumes.delete(id); return send(undefined, 204)
      }
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
      if (body.mounts.persistent) assert.ok(body.mounts.persistent.size >= 80)
      else {
        const mount = body.mounts.network?.[0] ?? body.mounts.global?.[0]
        assert.equal(mount?.path, '/workspace')
        const volume = state.volumes.get(mount.volumeId)
        assert.ok(volume)
        if (volume.kind === 'network') assert.deepEqual(body.dataCenterIds, [volume.dataCenter])
      }
      const syntax = spawnSync('bash', ['-n', '-c', body.args], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, syntax.stderr)
      const gpuEntry = (state.customGpus ?? gpus).find(gpu => gpu.id === body.gpu.id) ?? gpus.find(gpu => gpu.id === body.gpu.id)
      const pod = { ...structuredClone(livePod), id: 'fixture-pod-' + state.creates, name: body.name, mounts: body.mounts, status: 'PROVISIONING', cost: gpuEntry.price.secure * body.gpu.count, createdAt: new Date(Date.now() - 60000).toISOString(), startedAt: new Date(Date.now() - 60000).toISOString(), ssh: { direct: null, proxy: null } }
      state.pods.set(pod.id, pod)
      if (outcome === 'lost') return req.socket.destroy()
      if (outcome === 'http503') return problem(503, 'Service Unavailable', 'fixture: the gateway timed out after the create reached the account')
      return send(pod, 201)
    }
    const match = /^\/v2\/pods\/([^/]+)(\/action|\/logs)?$/.exec(url.pathname)
    const pod = match && state.pods.get(match[1])
    if (!pod) return send({ error: 'not found' }, 404)
    if (match[2] === '/logs') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: {"source":"container","line":"fixture image pull pending"}\n\n') }
    if (req.method === 'DELETE') { if (state.failDelete) return problem(503, 'Service Unavailable', 'fixture terminate could not be verified'); state.deletes++; state.pods.delete(pod.id); return send(undefined, 204) }
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
  const state = { weights: new Map(), weightFetches: 0, sampledChecks: 0, fullChecks: 0, corruptWeights: false, refuse: false, failEngine: false, holdHealth: false, docker: true, log: 'MERCURY_STEP installing\nMERCURY_STEP building llama.cpp\nMERCURY_STEP downloading weights\n' }
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
      if (remote.includes('MERCURY_WEIGHTS ')) {
        const match = /m = json.loads\((.+)\)\nroot = pathlib.Path\((.+)\)/.exec(remote)
        assert.ok(match, 'weight command carries the pinned manifest')
        const manifest = JSON.parse(JSON.parse(match[1]))
        const directory = JSON.parse(match[2])
        const kept = state.weights.has(directory) && !state.corruptWeights
        const downloading = remote.includes('if True:\n    progress(')
        if (!kept && !downloading) throw new Error('fixture kept weights did not verify')
        if (downloading) { state.weightFetches++; state.weights.set(directory, manifest); state.corruptWeights = false }
        const sampled = kept && !downloading && !remote.includes('verified = None if True') && !remote.includes('expected_sample = ""')
        if (sampled) state.sampledChecks++; else state.fullChecks++
        const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
        output = 'MERCURY_WEIGHTS ' + JSON.stringify({sha256: digest, sampleManifestSha256: digest, check: sampled ? 'sampled' : 'full', files: manifest.files.length, bytes: manifest.files.reduce((n,f)=>n+f.size,0), skipped: !downloading})
      }
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

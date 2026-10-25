import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { bashSyntax } from './bashSyntax.mjs'
import { PYTHON3 } from '../lib/python3.ts'
const sample = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8'))
export const liveCatalogue = sample('catalog-gpus-secure-count1')
const livePod = sample('pod-get-running')
const livePods = sample('pods-list')

export async function runpodFixture() {
  const key = 'fixture-runpod-key-not-a-real-key'
  const requests = []
  const state = { failNext: null, retryAfter: undefined, volumes: new Map(), volumeCreates: 0, volumeDeletes: 0, failVolumeDelete: false, volumeOutcomes: [], volumeBodies: [], volumePageSize: 100, repeatVolumeCursor: false, failVolumeRead: false, clusters: new Map(), clusterNodes: new Map(), clusterGpus: [], clusterCreateBodies: [], clusterCreateOutcomes: [], clusterCreates: 0, clusterDeletes: 0, clusterCatalogReads: 0, clusterReads: 0, holdClusterDelete: false, clusterCuda: '13.0', pods: new Map(), createBodies: [], keys: [], reads: 0, catalogReads: 0, catalogTimes: [], catalogFailures: [], creates: 0, createOutcomes: [], stops: 0, deletes: 0, noStock: false, stockLoss: false, stockAfterReads: 0, price: 7.99, failCreate: false, stuck: false, failStop: false, failDelete: false, customGpus: null, podPageSize: 1000, podCursorLost: false, repeatPodCursor: false, podListReads: 0, logLines: null, createErrors: null, policy: '"minute";q=60;w=60, "hour";q=3000;w=3600, "day";q=50000;w=86400' }
  const gpus = liveCatalogue.gpus
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    requests.push({ method: req.method, path: url.pathname, search: url.search, body, at: Date.now() })
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...(state.policy ? { 'RateLimit-Policy': state.policy } : {}), ...headers }); res.end(value === undefined ? undefined : JSON.stringify(value)) }
    const problem = (status, title, detail, headers) => send({ title, status, detail }, status, headers)
    if (req.headers.authorization !== 'Bearer ' + key) return send({ error: 'fixture key needed' }, 401)
    const failure = [state.failNext].flat().find(row => row && row.times > 0 && row.route === req.method + ' ' + url.pathname)
    if (failure) {
      failure.times--
      if (failure.status === 'disconnect') return req.socket.destroy()
      const retryAfter = failure.retryAfter ?? state.retryAfter
      return problem(failure.status, 'Scripted failure', 'fixture route failure', retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) })
    }
    if (url.pathname === '/v2/catalog/gpus') {
      assert.equal(url.searchParams.get('include'), 'AVAILABILITY')
      if (url.searchParams.get('product') === 'CLUSTER') {
        state.clusterCatalogReads++
        if (state.failClusterCatalogue) return problem(400, 'Bad Request', 'fixture: cluster catalogue refused this count')
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
        if (outcome === 'drop') return req.socket.destroy()
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
        if (state.failVolumeDelete) return problem(503, 'Service Unavailable', 'fixture delete answer lost')
        if ([...state.pods.values()].some(pod => [...(pod.mounts?.network ?? []), ...(pod.mounts?.global ?? [])].some(row => row.volumeId === id))) return problem(409, 'Conflict', 'volume is attached to a pod')
        state.volumeDeletes++; state.volumes.delete(id); return send(undefined, 204)
      }
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
      const launch = JSON.parse(body.args)
      assert.deepEqual(launch.entrypoint, ['bash', '-lc'])
      assert.equal(launch.cmd.length, 1)
      assert.equal(bashSyntax(launch.cmd[0]).status, 0)
      const id = 'fixture-cluster-' + state.clusterCreates
      const nodes = Array.from({ length: body.compute.podCount }, (_, rank) => ({ ...structuredClone(livePod), id: id + '-node-' + rank, name: body.name + '-' + rank, status: 'RUNNING', cudaVersion: state.clusterCuda, cost: Math.round((state.clusterGpus.find(gpu => gpu.id === body.compute.gpuTypeId)?.price.secure ?? 7.99) * body.compute.gpuCountPerPod * (state.clusterRatePremium ?? 1) * 10000) / 10000, cluster: { id, rank, ip: '10.65.0.' + (rank + 2) }, createdAt: new Date().toISOString(), ssh: { direct: { host: '127.0.0.1', port: 22000 + rank, username: 'root' } } }))
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
    if (url.pathname === '/v2/pods' && req.method === 'GET') {
      state.podListReads++
      const all = [...state.pods.values()]
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const next = start + state.podPageSize
      const more = next < all.length || state.repeatPodCursor || state.podCursorLost
      return send({ ...livePods, pods: all.slice(start, next), pagination: { hasNextPage: more, nextCursor: !more || state.podCursorLost ? null : state.repeatPodCursor ? String(start) : String(next) } })
    }
    if (url.pathname === '/v2/pods' && req.method === 'POST') {
      const outcome = state.failCreate ? 'refuse' : state.createOutcomes.shift()
      if (outcome === 'refuse') return problem(400, 'Bad Request', 'fixture: this GPU and data center combination could not be placed')
      if (outcome === 'refuse402') return problem(402, 'Payment Required', 'fixture: insufficient balance')
      if (outcome === 'refuse422') return send({ title: 'Unprocessable Entity', status: 422, detail: 'request validation failed', errors: state.createErrors ?? ['$.gpu.minCudaVersion: does not match pattern ^\\d+\\.\\d+$'] }, 422)
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
      let bootstrap = body.args
      if (body.image.startsWith('vllm/')) {
        const launch = JSON.parse(body.args)
        assert.deepEqual(launch.entrypoint, ['bash', '-lc'])
        assert.equal(launch.cmd.length, 1)
        bootstrap = launch.cmd[0]
      } else assert.ok(body.args.startsWith('bash -lc '))
      const syntax = bashSyntax(bootstrap)
      assert.equal(syntax.status, 0, syntax.stderr)
      const gpuEntry = (state.customGpus ?? gpus).find(gpu => gpu.id === body.gpu.id) ?? gpus.find(gpu => gpu.id === body.gpu.id)
      const pod = { ...structuredClone(livePod), id: 'fixture-pod-' + state.creates, name: body.name, mounts: body.mounts, status: 'PROVISIONING', cost: gpuEntry.price.secure * body.gpu.count, createdAt: new Date(Date.now() - 60000).toISOString(), startedAt: new Date(Date.now() - 60000).toISOString(), ssh: { direct: null, proxy: null } }
      state.pods.set(pod.id, pod)
      if (outcome === 'lost') return req.socket.destroy()
      if (outcome === 'http503') return problem(503, 'Service Unavailable', 'fixture: the gateway timed out after the create reached the account')
      return send(pod, 201)
    }
    const match = /^\/v2\/pods\/([^/]+)(\/action|\/logs)?$/.exec(url.pathname)
    const pod = match && (state.pods.get(match[1]) ?? [...state.clusterNodes.values()].flat().find(node => node.id === match[1]))
    if (!pod) return send({ error: 'not found' }, 404)
    if (pod.cluster && req.method !== 'GET') return problem(400, 'Bad Request', 'Member pods are managed through the cluster API')
    if (match[2] === '/logs') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const tail = Math.min(5000, Math.max(0, Number(url.searchParams.get('tail') ?? 100)))
      const history = state.logLines ?? [{ source: 'system', line: 'pod assigned to machine' }, { source: 'container', line: 'fixture image pull pending' }]
      const events = tail === 0 ? [] : history.slice(-tail)
      return res.end(events.map((event, index) => { const ts = new Date(Date.now() - (events.length - index) * 1000).toISOString(); return 'id: ' + ts + '\ndata: ' + JSON.stringify({ ...event, ts }) + '\n\n' }).join(''))
    }
    if (req.method === 'DELETE') { if (state.failDelete) return problem(503, 'Service Unavailable', 'fixture terminate could not be verified'); state.deletes++; state.pods.delete(pod.id); return send(undefined, 204) }
    if (match[2] === '/action') { if (state.failStop) return send({ error: 'stop refused' }, 409); assert.equal(body.action, 'stop'); state.stops++; pod.status = 'EXITED'; pod.cost = 0; return send(pod) }
    state.reads++
    if (!state.stuck && pod.status === 'PROVISIONING') { pod.status = 'RUNNING'; pod.ssh = structuredClone(livePod.ssh) }
    return send(pod)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v2', key, state, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

export function fakeSshRunner(modelBaseUrl, actualRunner, modelState) {
  assert.equal(new URL(modelBaseUrl).hostname, '127.0.0.1')
  const commands = []
  const children = new Set()
  const local = modelState ? mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'ssh-engine-')) : undefined
  const shell = text => { const parsed = spawnSync(PYTHON3, ['-c', 'import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))', text], { encoding: 'utf8' }); assert.equal(parsed.status, 0, parsed.stderr); return JSON.parse(parsed.stdout) }
  const state = { weights: new Map(), weightFetches: 0, sampledChecks: 0, fullChecks: 0, corruptWeights: false, stallDownload: 0, checkTransport: false, refuse: false, failEngine: false, holdHealth: false, failRetune: false, failRestore: false, retuned: false, restored: false, restarts: 0, script: '', backup: '', gpus: null, docker: true, goneEngines: new Set(), log: 'MERCURY_STEP installing\nMERCURY_STEP building llama.cpp\nMERCURY_STEP downloading weights\n' }
  const runner = {
    async run(command, args, signal, timeout) {
      commands.push({ command, args })
      if (command === 'ssh-keygen') return actualRunner.run(command, args, signal, timeout)
      assert.ok(['ssh', 'rsync'].includes(command))
      if (state.refuse) throw new Error('fixture SSH connection refused')
      const remote = args.at(-1)
      if (command === 'ssh') {
        const parse = bashSyntax(remote)
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
        if (!downloading && state.checkTransport) throw new Error('ssh exited 255. Connection to fixture closed by remote host.')
        if (!kept && !downloading) throw new Error('ssh exited 1. Traceback (most recent call last):\nRuntimeError: Kept weights failed pinned SHA256/sizes verification')
        if (downloading && state.stallDownload) throw new Error('ssh exited 75. MERCURY_STEP download stopped · stall\nMERCURY_STALL ' + JSON.stringify({ reason: 'stall', bytes: state.stallDownload, seconds: 600 }))
        if (downloading) { state.weightFetches++; state.weights.set(directory, manifest); state.corruptWeights = false }
        const sampled = kept && !downloading && !remote.includes('verified = None if True') && !remote.includes('expected_sample = ""')
        if (sampled) state.sampledChecks++; else state.fullChecks++
        const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
        output = 'MERCURY_WEIGHTS ' + JSON.stringify({sha256: digest, sampleManifestSha256: digest, check: sampled ? 'sampled' : 'full', files: manifest.files.length, bytes: manifest.files.reduce((n,f)=>n+f.size,0), skipped: !downloading})
      }
      if (local && remote.includes('printf %s') && remote.includes('/engine.sh')) {
        const parts = shell(remote); const at = parts.findIndex((value, index) => value === 'printf' && parts[index + 1] === '%s')
        if (at >= 0) { state.script = parts[at + 2]; writeFileSync(join(local, 'engine.sh'), state.script) }
      }
      if (local && remote.startsWith('python3 -c ')) {
        const source = shell(remote)[2].replace(/p = pathlib.Path\([^\n]+\)/, 'p = pathlib.Path(' + JSON.stringify(local) + ')').replace("engine_url = 'http://127.0.0.1:30000'", 'engine_url = ' + JSON.stringify(modelBaseUrl.replace(/\/v1$/, '')))
        const rewritten = await new Promise(resolve => { const child = spawn(PYTHON3, ['-c', source], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data }); child.on('close', status => resolve({ status, stdout, stderr })) })
        output = rewritten.stdout
        if (rewritten.status !== 0) throw new Error('ssh exited ' + rewritten.status + '. ' + rewritten.stdout + rewritten.stderr)
        if (remote.includes('engine.pre-tune')) {
          state.script = readFileSync(join(local, 'engine.sh'), 'utf8')
          state.backup = existsSync(join(local, 'engine.pre-tune.sh')) ? readFileSync(join(local, 'engine.pre-tune.sh'), 'utf8') : ''
          state.restored = remote.includes('restore = True'); state.retuned = !state.restored
        }
      }
      if (local && remote.includes('nohup setsid')) {
        state.restarts++
        const engine = state.script.split('\n').find(line => line.includes('/llama-server') || /^'?llama-server'?(?:\s|$)/.test(line))
        if (engine) { const flags = shell(engine); modelState.slots = Number(flags[flags.indexOf('--parallel') + 1]); modelState.window = Number(flags[flags.indexOf('--ctx-size') + 1]) / modelState.slots }
        if (state.engine) { try { process.kill(-state.engine.pid, 'SIGKILL') } catch {} children.delete(state.engine) }
        state.engine = spawn('bash', ['-c', 'sleep 100000; true', join(local, 'engine.sh')], { detached: true, stdio: 'ignore' })
        state.engine.unref()
        children.add(state.engine)
        writeFileSync(join(local, 'engine.pid'), String(state.engine.pid) + '\n')
      }
      if (remote.includes('/props') && !remote.includes('MERCURY_ENGINE_READ ')) output = JSON.stringify({ default_generation_settings: { n_ctx: modelState?.window }, total_slots: modelState?.slots })
      if (remote.includes('nvidia-smi')) output = state.gpus ?? Array.from({ length: 4 }, () => 'NVIDIA B200, 196608').join('\n') + (state.docker ? '\nDOCKER_ENGINE_PRESENT' : '')
      if (remote.includes('/health')) {
        if (state.holdHealth || state.failRetune && state.retuned || state.failRestore && state.restored) throw new Error('fixture model loading')
        assert.equal((await fetch(modelBaseUrl + '/models')).status, 200)
        output = 'healthy models'
      }
      if (state.failEngine && remote.includes('launch.log')) throw new Error('launch.log: fixture outer launch permission denied')
      if (remote.includes('tail -n 8')) output = state.log
      if (remote.startsWith('dd if=')) { const offset = Number(/skip=(\d+)/.exec(remote)?.[1] ?? 0); output = state.log.slice(offset, offset + 8192) }
      if (remote.includes('MERCURY_ENGINE_GONE')) output = state.goneEngines.has(Number(args[args.indexOf('-p') + 1])) ? 'MERCURY_ENGINE_GONE\nfixture worker engine exited: CUDA out of memory' : 'MERCURY_ENGINE_ALIVE'
      return actualRunner.run(process.execPath, ['-e', 'process.stdout.write(process.env.MERCURY_FIXTURE_SSH_OUTPUT ?? "")'], signal, undefined, { MERCURY_FIXTURE_SSH_OUTPUT: output })
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
  return { runner, state, commands, close: () => { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill() } } children.clear(); if (local) rmSync(local, { recursive: true, force: true }) } }
}

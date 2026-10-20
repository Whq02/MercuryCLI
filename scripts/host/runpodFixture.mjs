import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const sample = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8'))
export const liveCatalogue = sample('catalog-gpus-secure-count1')
const livePod = sample('pod-get-running')
const livePods = sample('pods-list')

export async function runpodFixture() {
  const key = 'fixture-runpod-key-not-a-real-key'
  const requests = []
  const state = { pods: new Map(), createBodies: [], keys: [], reads: 0, catalogReads: 0, catalogTimes: [], catalogFailures: [], creates: 0, createOutcomes: [], stops: 0, deletes: 0, noStock: false, stockLoss: false, stockAfterReads: 0, price: 7.99, failCreate: false, stuck: false, failStop: false, customGpus: null, policy: '"minute";q=60;w=60, "hour";q=3000;w=3600, "day";q=50000;w=86400' }
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
    const pod = match && state.pods.get(match[1])
    if (!pod) return send({ error: 'not found' }, 404)
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

export function fakeSshRunner(modelBaseUrl, actualRunner, modelState) {
  assert.equal(new URL(modelBaseUrl).hostname, '127.0.0.1')
  const commands = []
  const children = new Set()
  const local = modelState ? mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'ssh-engine-')) : undefined
  const shell = text => { const parsed = spawnSync('python3', ['-c', 'import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))', text], { encoding: 'utf8' }); assert.equal(parsed.status, 0, parsed.stderr); return JSON.parse(parsed.stdout) }
  const state = { refuse: false, failEngine: false, holdHealth: false, failRetune: false, failRestore: false, retuned: false, restored: false, restarts: 0, script: '', backup: '', gpus: null, docker: true, log: 'MERCURY_STEP installing\nMERCURY_STEP building llama.cpp\nMERCURY_STEP downloading weights\n' }
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
      if (local && remote.includes('printf %s') && remote.includes('/engine.sh')) {
        const parts = shell(remote); const at = parts.findIndex((value, index) => value === 'printf' && parts[index + 1] === '%s')
        if (at >= 0) { state.script = parts[at + 2]; writeFileSync(join(local, 'engine.sh'), state.script) }
      }
      if (local && remote.startsWith('python3 -c ')) {
        const source = shell(remote)[2].replace(/p = pathlib.Path\([^\n]+\)/, 'p = pathlib.Path(' + JSON.stringify(local) + ')').replace("engine_url = 'http://127.0.0.1:30000'", 'engine_url = ' + JSON.stringify(modelBaseUrl.replace(/\/v1$/, '')))
        const rewritten = await new Promise(resolve => { const child = spawn('python3', ['-c', source], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data }); child.on('close', status => resolve({ status, stdout, stderr })) })
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
        const engine = state.script.split('\n').find(line => line.includes('/llama-server'))
        if (engine) { const flags = shell(engine); modelState.slots = Number(flags[flags.indexOf('--parallel') + 1]); modelState.window = Number(flags[flags.indexOf('--ctx-size') + 1]) / modelState.slots }
        if (state.engine) { try { process.kill(-state.engine.pid, 'SIGKILL') } catch {} children.delete(state.engine) }
        state.engine = spawn('bash', ['-c', 'sleep 100000; true', join(local, 'engine.sh')], { detached: true, stdio: 'ignore' })
        state.engine.unref()
        children.add(state.engine)
        writeFileSync(join(local, 'engine.pid'), String(state.engine.pid) + '\n')
      }
      if (remote.includes('/props')) output = JSON.stringify({ default_generation_settings: { n_ctx: modelState?.window }, total_slots: modelState?.slots })
      if (remote.includes('nvidia-smi')) output = state.gpus ?? Array.from({ length: 4 }, () => 'NVIDIA B200, 196608').join('\n') + (state.docker ? '\nDOCKER_ENGINE_PRESENT' : '')
      if (remote.includes('/health')) {
        if (state.holdHealth || state.failRetune && state.retuned || state.failRestore && state.restored) throw new Error('fixture model loading')
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
  return { runner, state, commands, close: () => { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill() } } children.clear(); if (local) rmSync(local, { recursive: true, force: true }) } }
}

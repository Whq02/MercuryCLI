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
  const state = { pods: new Map(), createBodies: [], keys: [], reads: 0, catalogReads: 0, creates: 0, stops: 0, deletes: 0, noStock: false, stockLoss: false, price: 7.99, failCreate: false, stuck: false, failStop: false, customGpus: null }
  const gpus = liveCatalogue.gpus
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    requests.push({ method: req.method, path: url.pathname, search: url.search, body })
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)) }
    if (req.headers.authorization !== 'Bearer ' + key) return send({ error: 'fixture key needed' }, 401)
    if (url.pathname === '/v2/catalog/gpus') {
      assert.equal(url.searchParams.get('include'), 'AVAILABILITY')
      assert.equal(url.searchParams.get('product'), 'POD')
      assert.equal(url.searchParams.get('cloud'), 'SECURE')
      assert.equal(url.searchParams.get('minCudaVersion'), '13.0')
      state.catalogReads++
      return send(state.noStock || state.stockLoss && state.catalogReads > 3 ? { ...liveCatalogue, gpus: gpus.map(gpu => ({ ...gpu, availability: 'NONE' })) } : state.customGpus ? { ...liveCatalogue, gpus: state.customGpus } : liveCatalogue)
    }
    if (url.pathname === '/v2/account/ssh-keys') { if (req.method === 'PUT') state.keys = body.keys; return send({ keys: state.keys }) }
    if (url.pathname === '/v2/pods' && req.method === 'GET') return send({ ...livePods, pods: [...state.pods.values()], pagination: { hasNextPage: false, nextCursor: null } })
    if (url.pathname === '/v2/pods' && req.method === 'POST') {
      if (state.failCreate) return send({ error: 'fixture placement refused' }, 400)
      state.creates++; state.createBodies.push(body)
      assert.deepEqual(body.ports, ['22/tcp'])
      assert.equal(body.cloud, 'SECURE')
      assert.equal(body.gpu.minCudaVersion, '13.0')
      assert.ok(body.env.PUBLIC_KEY.startsWith('ssh-ed25519 '))
      assert.ok(body.mounts.persistent.size >= 80)
      const syntax = spawnSync('bash', ['-n', '-c', body.args], { encoding: 'utf8' })
      assert.equal(syntax.status, 0, syntax.stderr)
      const pod = { ...structuredClone(livePod), id: 'fixture-pod-' + state.creates, name: body.name, status: 'PROVISIONING', cost: gpus.find(gpu => gpu.id === body.gpu.id).price.secure * body.gpu.count, createdAt: new Date(Date.now() - 60000).toISOString(), startedAt: new Date(Date.now() - 60000).toISOString(), ssh: { direct: null, proxy: null } }
      state.pods.set(pod.id, pod)
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
      if (remote.includes('nvidia-smi')) output = Array.from({ length: 4 }, () => 'NVIDIA B200, 196608').join('\n') + (state.docker ? '\nMERCURY_DOCKER' : '')
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

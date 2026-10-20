import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

export async function runpodFixture() {
  const key = 'fixture-runpod-key-not-a-real-key'
  const requests = []
  const state = { pods: new Map(), createBodies: [], keys: [], reads: 0, catalogReads: 0, creates: 0, stops: 0, deletes: 0, noStock: false, stockLoss: false, price: 7.99, failCreate: false, stuck: false, failStop: false }
  const gpus = [
    { id: 'NVIDIA B200', name: 'B200', memory: 192, secure: true, price: { secure: 7.99 }, maxCount: { secure: 8 } },
    { id: 'NVIDIA B300', name: 'B300', memory: 288, secure: true, price: { secure: 8.99 }, maxCount: { secure: 8 } },
    { id: 'NVIDIA H200', name: 'H200', memory: 141, secure: true, price: { secure: 5.29 }, maxCount: { secure: 8 } },
    { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', name: 'RTX PRO 6000', memory: 96, secure: true, price: { secure: 2.49 }, maxCount: { secure: 4 } },
    { id: 'NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb', name: 'PRO 6000 MIG 24GB', memory: 24, secure: true, price: { secure: 0.69 }, maxCount: { secure: 32 } },
    { id: 'no-stock', name: 'GB300', memory: 288, secure: true, price: { secure: 1.01 }, maxCount: { secure: 8 } },
    { id: 'NVIDIA A100-SXM4-40GB', name: 'A100 SXM 40GB', memory: 40, secure: false, price: { community: 1, secure: 0 }, maxCount: { community: 2, secure: 0 } },
  ]
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
      return send({ gpus: gpus.map(gpu => ({ ...gpu, ...(gpu.name === 'B200' ? { price: { secure: state.price } } : {}), availability: state.noStock || state.stockLoss && state.catalogReads > 3 || gpu.id === 'no-stock' ? 'NONE' : 'HIGH', dataCenters: [{ id: 'FIXTURE-1', availability: state.noStock || gpu.id === 'no-stock' ? 'NONE' : 'HIGH' }] })) })
    }
    if (url.pathname === '/v2/account/ssh-keys') { if (req.method === 'PUT') state.keys = body.keys; return send({ keys: state.keys }) }
    if (url.pathname === '/v2/pods' && req.method === 'GET') return send({ pods: [...state.pods.values()], pagination: { hasNextPage: false, nextCursor: null } })
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
      const pod = { id: 'fixture-pod-' + state.creates, name: body.name, status: 'PROVISIONING', cost: (body.gpu.id.includes('B300') ? 8.99 : state.price) * body.gpu.count, createdAt: new Date(Date.now() - 60000).toISOString(), startedAt: new Date(Date.now() - 60000).toISOString(), ssh: { direct: null } }
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
    if (!state.stuck && pod.status === 'PROVISIONING') { pod.status = 'RUNNING'; pod.ssh.direct = { host: '127.0.0.1', port: 2222, username: 'root' } }
    return send(pod)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v2', key, state, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

export function fakeSshRunner(modelBaseUrl, actualRunner) {
  assert.equal(new URL(modelBaseUrl).hostname, '127.0.0.1')
  const commands = []
  const children = new Set()
  const state = { refuse: false, failEngine: false, holdHealth: false, docker: true }
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
      if (state.failEngine && remote.includes('tmux has-session')) throw new Error('fixture engine boot failed')
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

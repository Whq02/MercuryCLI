import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { catalogue, installFixture, proofHome, root, serverPath } from './fixture.ts'
import { writeHostRecord } from '../../src/services/host/store.js'
import { closeHostTunnel, type HostRunner } from '../../src/services/host/ssh.js'
import { mediaHostInstallScript, readMediaHostSnapshot, runMediaHostSetup, mediaHostStatePath } from '../../src/services/media/host.js'
import { mediaPullPlan, pullMedia } from '../../src/services/media/setup.js'

const calls: { command: string; args: string[] }[] = []
const servers: Server[] = []
const machine = { totalMemoryBytes: 64 * 1024 ** 3, usableMemoryBytes: 48 * 1024 ** 3, freeBytes: 1e12 }
const signal = new AbortController().signal
let installed = false
const remoteCatalogue = { ...catalogue, runtime: { ...catalogue.runtime, platforms: { 'linux-x64': [{ variant: 'cuda12', binary: 'sd-server', files: [{ asset: 'fixture.zip', bytes: 64, sha256: 'a'.repeat(64) }] }] } } }
const runner: HostRunner = {
  async run(command, args) { calls.push({ command, args }); return args.at(-1)?.startsWith('python3 -c') ? JSON.stringify(machine) : '' },
  tunnel(args) {
    calls.push({ command: 'tunnel', args })
    const forward = args[args.indexOf('-L') + 1]!
    assert.match(forward, /^127\.0\.0\.1:\d+:127\.0\.0\.1:30080$/)
    const server = createServer(async (req, res) => {
      assert.match(req.headers.authorization ?? '', /^Bearer [a-f0-9]{64}$/)
      if (req.url === '/health') { res.end('{"ok":true}'); return }
      if (req.url === '/snapshot') { res.end(JSON.stringify({ ...machine, catalogue: remoteCatalogue, config: {}, runtime: { installed }, files: [] })); return }
      let text = ''
      for await (const chunk of req) text += chunk
      assert.deepEqual(JSON.parse(text), ['pull-runtime', '--variant', 'cuda12'])
      installed = true
      res.end('{"event":"progress","file":"fixture.zip","bytes":64,"total":64}\n{"event":"done"}\n')
    })
    server.listen(Number(forward.split(':')[1]), '127.0.0.1')
    servers.push(server)
    return { stop() { server.close() }, failed() { return undefined } }
  },
}
try {
  installFixture()
  writeFileSync(join(dirname(serverPath), 'catalog.json'), JSON.stringify(remoteCatalogue))
  writeFileSync(join(dirname(serverPath), 'remote-server.js'), 'export {}\n')
  const hash = createHash('sha256').update(readFileSync(join(dirname(serverPath), 'remote-server.js'))).digest('hex')
  writeFileSync(join(dirname(serverPath), 'manifest.json'), JSON.stringify({ files: { 'remote-server.js': hash } }))
  writeHostRecord({ id: 'fixture-rental', name: 'fixture GPU', recipe: 'fixture', price: 1, startedAt: new Date().toISOString(), status: 'RUNNING', jobState: 'ready', target: { host: 'gpu.example', user: 'render', port: 2222 } })
  const settings = { root, serverPath, host: 'fixture-rental' }
  const snapshot = await readMediaHostSnapshot(settings, runner)
  assert.equal(snapshot.runtime?.variant, 'cuda12')
  assert.equal(snapshot.location, 'Runpod pod fixture-rental')
  assert.equal(snapshot.freeBytes, machine.freeBytes)
  const plan = mediaPullPlan(snapshot)
  const run = (args: string[], progress: Parameters<typeof runMediaHostSetup>[1]) => runMediaHostSetup(args, progress, signal, settings, runner)
  assert.equal(await pullMedia(plan, async () => false, run, () => {}), false)
  assert.deepEqual(calls.map(call => call.command), ['ssh'])
  assert.equal(await pullMedia(plan, async () => true, run, () => {}), true)
  assert.equal((await readMediaHostSnapshot(settings, runner)).runtimeInstalled, true)
  const scp = calls.find(call => call.command === 'scp')!.args
  assert.ok(scp.includes('-P') && scp.includes('2222'))
  assert.ok(!scp.includes('-l'))
  assert.match(scp.at(-1)!, /^render@gpu.example:\/workspace\/mercury-media\/bundles\//)
  assert.equal(JSON.parse(readFileSync(mediaHostStatePath(settings.host), 'utf8')).name, snapshot.location)
  const script = mediaHostInstallScript('/workspace/mercury-media/bundles/fixture', 'a'.repeat(64))
  assert.match(script, /sha256sum -c/)
  assert.match(script, /remote-server\.js/)
  assert.match(script, /"port":30080/)
  assert.ok(!calls.some(call => /terminate|stopPod|createPod/.test(call.args.join(' '))))
  console.log('media host setup: consent, rented-machine facts, Linux CUDA plan, bundle hashes, private tunnel and installed reread')
} finally {
  closeHostTunnel('media-fixture-rental')
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  rmSync(proofHome, { recursive: true, force: true })
}

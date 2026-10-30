import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { dist, sceneRoot } from '../hooks/lib/runDoor.ts'

const paths = sceneRoot('daemon-refused-start-')
process.env.MERCURY_CONFIG_DIR = paths.home
process.env.MERCURY_DAEMON_DIR = join(paths.home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const child = spawn('node', [dist, 'daemon', 'run'], { cwd: paths.cwd, env: process.env, stdio: 'ignore' })
const exited = new Promise(resolve => child.once('exit', resolve))
try {
  let ready = false
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !ready) {
    const reply = await daemonControlRpc({ op: 'status' }, 500)
    ready = reply.ok
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, 'scratch daemon did not answer')
  const second = spawnSync('node', [dist, 'daemon', 'run'], { cwd: paths.cwd, env: process.env, encoding: 'utf8', timeout: 15_000 })
  assert.ok(second.stderr.includes('refusing to start'), second.stderr)
  assert.equal(second.status, 1, 'a refused daemon start must fail')
  assert.ok((await daemonControlRpc({ op: 'status' }, 2000)).ok, 'the first daemon must remain live')
  console.log('PASS refused daemon start exits 1 and leaves its live predecessor intact')
} finally {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, 2000)
  const guard = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(guard)
  rmSync(paths.root, { recursive: true, force: true })
}

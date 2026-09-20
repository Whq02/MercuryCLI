import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectWindowsProcesses, signalWindowsProcess } from '../../src/daemon/processSweepWindows.js'

if (process.platform !== 'win32') {
  console.log('SKIP: the Windows process collector runs on Windows only')
  process.exit(0)
}
const root = resolve(import.meta.dir, '../..')
const node = join(root, 'dist/vendor/node/node.exe')
const bundle = join(root, 'dist/mercury.mjs')
assert.ok(existsSync(node) && existsSync(bundle), 'build the Windows product first')
const homes: string[] = []
const children: ChildProcess[] = []
const environments: NodeJS.ProcessEnv[] = []
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MERCURY_') && !/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|HF_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/.test(key)))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const rowOf = async (pid: number | undefined) => (await collectWindowsProcesses()).observations.find(o => o.process.pid === pid)
try {
  for (const detached of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), 'process-sweep-'))
    homes.push(home)
    const env = {
      ...cleanEnv,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_DAEMON_OWNER_PID: String(process.pid),
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      MERCURY_TELEMETRY: '0',
      MERCURY_UPDATE_API_BASE_URL: 'http://127.0.0.1:9',
    }
    environments.push(env)
    const child = spawn(node, [bundle, 'daemon', 'run', home], { cwd: home, env, windowsHide: true, detached, stdio: 'ignore' })
    if (detached) child.unref()
    children.push(child)
    await once(child, 'spawn')
    const deadline = Date.now() + 20_000
    while (!existsSync(join(home, 'daemon/supervisor.json')) && child.exitCode === null && Date.now() < deadline) await sleep(100)
    assert.ok(existsSync(join(home, 'daemon/supervisor.json')), 'the built daemon must register')
    assert.equal(JSON.parse(readFileSync(join(home, 'daemon/supervisor.json'), 'utf8')).pid, child.pid)
  }
  const [withConsole, headless] = children
  const table = await collectWindowsProcesses()
  assert.equal(table.complete, true, table.error)
  const self = table.observations.find(o => o.process.pid === process.pid)
  assert.ok(self && self.process.user !== '', 'the collector sees this proof process and its owner')
  const live = table.observations.find(o => o.process.pid === withConsole!.pid)
  const stale = table.observations.find(o => o.process.pid === headless!.pid)
  assert.ok(live && stale, 'CIM returns both built daemons')
  for (const target of [live, stale]) {
    assert.equal(target.process.user, self.process.user)
    assert.equal(target.state, 'running')
    assert.ok(target.startToken !== null && target.process.startedAtMs > 0)
    assert.ok(target.process.args.includes(bundle) && target.process.exe.toLowerCase() === node.toLowerCase())
  }
  assert.equal(live.terminalAlive, true, JSON.stringify(live))
  assert.equal(live.process.terminal, 'session ' + live.process.terminal!.split(' ')[1] + ' · console attached')
  assert.equal(stale.terminalAlive, false, JSON.stringify(stale))
  assert.match(stale.process.terminal ?? '', /console absent$/)

  for (const force of [false, true, false]) {
    const receipt = await signalWindowsProcess(live, force)
    assert.equal(receipt.sent, false, JSON.stringify(receipt))
    assert.match(receipt.reason ?? '', /console or connected interactive session is live/)
  }
  assert.equal(withConsole!.exitCode, null, 'the daemon with a console is untouched by every refused signal')

  const parent = table.observations.find(o => o.process.pid === process.ppid)
  if (parent !== undefined) {
    const upward = await signalWindowsProcess(parent, true)
    assert.equal(upward.sent, false, JSON.stringify(upward))
    assert.match(upward.reason ?? '', /parent|ancestor|owner|live/)
  }
  const ownerBefore = process.env.MERCURY_DAEMON_OWNER_PID
  process.env.MERCURY_DAEMON_OWNER_PID = String(stale.process.pid)
  const guarded = await signalWindowsProcess(stale, true)
  if (ownerBefore === undefined) delete process.env.MERCURY_DAEMON_OWNER_PID
  else process.env.MERCURY_DAEMON_OWNER_PID = ownerBefore
  assert.equal(guarded.sent, false, JSON.stringify(guarded))
  assert.match(guarded.reason ?? '', /owner/)
  assert.ok((await rowOf(headless!.pid)) !== undefined, 'the owner guard left the headless daemon alive')

  const polite = await signalWindowsProcess(stale, false)
  assert.equal(polite.sent, false, JSON.stringify(polite))
  assert.match(polite.reason ?? '', /forcefully|\/F/)
  await sleep(1500)
  const afterPolite = await rowOf(headless!.pid)
  assert.ok(afterPolite !== undefined, 'a polite stop cannot reach a process with no window, so it is still alive')
  const forced = await signalWindowsProcess(afterPolite, true)
  assert.equal(forced.sent, true, JSON.stringify(forced))
  const gone = Date.now() + 10_000
  while ((await rowOf(headless!.pid)) !== undefined && Date.now() < gone) await sleep(250)
  assert.equal(await rowOf(headless!.pid), undefined, 'the headless daemon has ended after the requested stops')
  const again = await signalWindowsProcess(stale, true)
  assert.equal(again.sent, false, JSON.stringify(again))
  assert.equal(withConsole!.exitCode, null, 'the daemon with a console is still alive after the other one ended')
  assert.ok((await rowOf(withConsole!.pid)) !== undefined)
  console.log(JSON.stringify({
    status: 'PASS',
    protected: { pid: live.process.pid, terminal: live.process.terminal },
    ended: { pid: stale.process.pid, terminal: stale.process.terminal, polite, forced, again },
  }))
} finally {
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const alive = (await rowOf(child.pid)) !== undefined
    if (alive) {
      const stop = spawn(node, [bundle, 'daemon', 'stop'], { cwd: homes[i]!, env: environments[i], windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => stop.kill(), 10_000)
      await once(stop, 'exit').finally(() => clearTimeout(timer))
      const deadline = Date.now() + 5000
      while ((await rowOf(child.pid)) !== undefined && Date.now() < deadline) await sleep(250)
      if ((await rowOf(child.pid)) !== undefined) child.kill()
    }
    const deadline = Date.now() + 5000
    while ((await rowOf(child.pid)) !== undefined && Date.now() < deadline) await sleep(250)
    assert.equal(await rowOf(child.pid), undefined, 'owned daemon must be gone before its home is removed')
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  console.log('CLEANUP: owned daemons gone; both scratch homes removed')
}

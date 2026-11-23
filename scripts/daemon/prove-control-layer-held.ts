#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const distAt = process.argv.indexOf('--dist')
const DIST = distAt < 0 ? join(ROOT, 'dist', 'mercury.mjs') : resolve(process.argv[distAt + 1]!)
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' a daemon whose control layer cannot start gives the home back and exits, naming the holder and the one command that frees the plane')
console.log('============================================================')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'control-layer-held-')))
const home = join(scratch, 'home')
const daemonDir = join(scratch, 'daemon')
const ground = join(scratch, 'ground')
mkdirSync(home, { recursive: true })
mkdirSync(daemonDir, { recursive: true })
mkdirSync(ground, { recursive: true })
writeFileSync(join(home, 'settings.json'), '{}')
writeFileSync(join(ground, 'README.md'), '# proof\n')

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { controlSockPath, daemonStatePath } = await import('../../src/daemon/control/controlSocket.ts')
const plane = controlSockPath()
console.log(` plane ${plane}`)

if (process.platform === 'win32') {
  const holder = createServer(() => {})
  await new Promise<void>(resolveListen => holder.listen(plane, resolveListen))
  process.on('exit', () => holder.close())
  console.log(' the pipe is bound by this proof and answers nothing — the shape of a daemon that holds the pipe but is not serving (the field\'s EADDRINUSE)')
} else {
  mkdirSync(plane, { recursive: true })
  console.log(' the socket path is taken by something the daemon cannot clear (a directory in its place) — the POSIX stand-in for a pipe another process holds: the bind answers EADDRINUSE')
}

const env = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_PERSIST: '1',
  BROWSER: '/usr/bin/true',
}
const started = Date.now()
const child = spawn(NODE, [DIST, 'daemon', 'run', ground], { cwd: ground, env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', chunk => { output += String(chunk) })
child.stderr.on('data', chunk => { output += String(chunk) })
const WAIT_MS = 45_000
const exit = await new Promise<{ code: number | null; timedOut: boolean }>(resolveExit => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    resolveExit({ code: null, timedOut: true })
  }, WAIT_MS)
  child.on('close', code => {
    clearTimeout(timer)
    resolveExit({ code, timedOut: false })
  })
})
const elapsed = Date.now() - started
console.log(` the daemon ${exit.timedOut ? `was still running after ${WAIT_MS / 1000} s (killed)` : `exited ${exit.code} after ${elapsed} ms`}`)

check('the control layer could not start (the bound plane refused the bind)', /control layer FAILED to start/.test(output), 'giveHomeBack in src/daemon/run/shutdown.ts prints this line when the control layer cannot start; output was: ' + output.slice(0, 400))
check(`the daemon EXITED instead of lingering as a pipe-less cron daemon (RED on 015ac050c0: "continuing as pure cron daemon (no roster)" and it ran on)`, !exit.timedOut && exit.code === 1, `timedOut ${exit.timedOut} code ${exit.code}; giveHomeBack in src/daemon/run/shutdown.ts must end with process.exit(1) after a failed control-layer start`)
check('the daemon never called itself a cron daemon', !/pure cron daemon/.test(output), 'a failed control-layer start must go through giveHomeBack in src/daemon/run/shutdown.ts and exit, not carry on; output was: ' + output.slice(0, 400))
check('the line says it gives the home back and exits', /gives the home back and exits/.test(output), 'planeHeldLine in src/daemon/control/main.ts builds this line; output was: ' + output.slice(0, 600))
check('the line names the plane it could not take', output.includes(plane), 'planeHeldLine in src/daemon/control/main.ts must name the plane path ' + plane + '; output was: ' + output.slice(0, 600))
const holderAnswered = /holds the control (pipe|socket)/.test(output)
check(holderAnswered ? 'the line names the holding pid and the one command that frees the plane (`mercury daemon stop`), with the hand remedy' : 'nothing answered on the plane: the line says so, names the record file whose pid to end by hand, and says to start again', holderAnswered ? /pid \d+ \(build /.test(output) && /mercury daemon stop/.test(output) && /end its pid by hand/.test(output) : /does not answer/.test(output) && /end it by hand/.test(output) && output.includes(daemonStatePath()) && /then start again/.test(output), 'planeHeldLine and FREE_THE_PLANE_WORDS in src/daemon/control/main.ts build this line; output was: ' + output.slice(0, 800))
check('the daemon leaves no socket of its own and no key of its own behind', !existsSync(join(daemonDir, `control.sock.${child.pid}`)) && !existsSync(join(daemonDir, 'control.key')), `left: ${existsSync(join(daemonDir, `control.sock.${child.pid}`)) ? 'own socket ' : ''}${existsSync(join(daemonDir, 'control.key')) ? 'key' : ''}; giveHomeBack in src/daemon/run/shutdown.ts removes them`)
check('no daemon record of its own is left behind', !existsSync(daemonStatePath()) || JSON.parse(readFileSync(daemonStatePath(), 'utf8')).pid !== child.pid, 'giveHomeBack in src/daemon/run/shutdown.ts must call clearDaemonState; record was: ' + (existsSync(daemonStatePath()) ? readFileSync(daemonStatePath(), 'utf8').slice(0, 200) : 'absent'))
check('the daemon lock is released (a later daemon can take the home once the plane is free)', !existsSync(join(daemonDir, 'daemon.lock')) || !readFileSync(join(daemonDir, 'daemon.lock'), 'utf8').includes(`"pid":${child.pid}`), 'giveHomeBack in src/daemon/run/shutdown.ts must release state.daemonLock; lock was: ' + (existsSync(join(daemonDir, 'daemon.lock')) ? readFileSync(join(daemonDir, 'daemon.lock'), 'utf8').slice(0, 200) : 'absent'))

console.log('\n§2 a refused start names the holder and the freeing command')
const { FREE_THE_PLANE_WORDS } = await import('../../src/daemon/control/main.ts')
check('the refused-start words name `mercury daemon stop` and the hand remedy', /mercury daemon stop/.test(FREE_THE_PLANE_WORDS) && /end its pid by hand/.test(FREE_THE_PLANE_WORDS), 'FREE_THE_PLANE_WORDS in src/daemon/control/main.ts must keep both phrases; it reads: ' + FREE_THE_PLANE_WORDS)

if (process.platform !== 'win32') {
  console.log('\n§3 a boot that fails after its own control socket is up says which step failed, names no holder, and leaves no link behind')
  const file = join(scratch, 'failed-boot.txt')
  const ran = spawnSync(process.execPath, [join(import.meta.dir, 'daemonRunScenarios.ts'), 'periodic-failed-boot', '--dist', dirname(DIST), '--out', file], { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 240_000 })
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const failed = lines.filter(line => line.includes('control layer FAILED to start'))
  const left = lines.filter(line => /^@ the (first|second) left: /.test(line))
  check('two daemons were started and each boot failed with its control socket up, exit 1', ran.status === 0 && failed.length === 2 && lines.filter(line => / left: code 1 signal null$/.test(line)).length === 2 && lines.filter(line => line.includes('clock: rename control.sock')).length === 2, lines.slice(0, 8).join(' | ') || `the harness wrote no recording (exit ${ran.status}); run scripts/daemon/daemonRunScenarios.ts periodic-failed-boot and read giveHomeBack in src/daemon/run/shutdown.ts`)
  check('each says which step of its start failed, with the error', failed.join(' | ').includes('FAILED to start at "the sessionless beat": Error: ') && failed.join(' | ').includes('FAILED to start at "the reconcile tick": Error: '), 'giveHomeBack in src/daemon/run/shutdown.ts prints state.bootStep in this line; lines were: ' + failed.join(' | '))
  check('neither names itself as a daemon that holds the home: no holder is named and nobody is told to stop one', lines.filter(line => line.includes('gives the home back and exits: no other daemon holds the control socket')).length === 2 && !lines.some(line => /pid .*\) holds the control socket/.test(line) || line.includes('mercury daemon stop')), lines.filter(line => line.includes('gives the home back')).join(' | ') + '; planeHeldLine in src/daemon/control/main.ts must answer the holder-is-self case with no pid and no stop command')
  check('neither leaves control.sock behind: the link to its own socket goes with the socket', left.length === 2 && left.every(line => !line.includes('control.sock')), 'giveHomeBack in src/daemon/run/shutdown.ts must call unpublishOwnPlane before exit; left: ' + left.join(' | '))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ control-layer-held PROVEN' : `\n❌ ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

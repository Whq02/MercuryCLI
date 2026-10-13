#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
const { controlSockPath, daemonStatePath } = await import('../../src/daemon/controlSocket.ts')
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

check('the control layer could not start (the bound plane refused the bind)', /control layer FAILED to start/.test(output), output.slice(0, 400))
check(`the daemon EXITED instead of lingering as a pipe-less cron daemon (RED on 015ac050c0: "continuing as pure cron daemon (no roster)" and it ran on)`, !exit.timedOut && exit.code === 1, `timedOut ${exit.timedOut} code ${exit.code}`)
check('the daemon never called itself a cron daemon', !/pure cron daemon/.test(output), output.slice(0, 400))
check('the line says it gives the home back and exits', /gives the home back and exits/.test(output), output.slice(0, 600))
check('the line names the plane it could not take', output.includes(plane), output.slice(0, 600))
const holderAnswered = /holds the control (pipe|socket)/.test(output)
check(holderAnswered ? 'the line names the holding pid and the one command that frees the plane (`mercury daemon stop`), with the hand remedy' : 'nothing answered on the plane: the line says so, names the record file whose pid to end by hand, and says to start again', holderAnswered ? /pid \d+ \(build /.test(output) && /mercury daemon stop/.test(output) && /end its pid by hand/.test(output) : /does not answer/.test(output) && /end it by hand/.test(output) && output.includes(daemonStatePath()) && /then start again/.test(output), output.slice(0, 800))
check('the daemon leaves no socket of its own and no key of its own behind', !existsSync(join(daemonDir, `control.sock.${child.pid}`)) && !existsSync(join(daemonDir, 'control.key')), `left: ${existsSync(join(daemonDir, `control.sock.${child.pid}`)) ? 'own socket ' : ''}${existsSync(join(daemonDir, 'control.key')) ? 'key' : ''}`)
check('no daemon record of its own is left behind', !existsSync(daemonStatePath()) || JSON.parse(readFileSync(daemonStatePath(), 'utf8')).pid !== child.pid, existsSync(daemonStatePath()) ? readFileSync(daemonStatePath(), 'utf8').slice(0, 200) : 'absent')
check('the daemon lock is released (a later daemon can take the home once the plane is free)', !existsSync(join(daemonDir, 'daemon.lock')) || !readFileSync(join(daemonDir, 'daemon.lock'), 'utf8').includes(`"pid":${child.pid}`), existsSync(join(daemonDir, 'daemon.lock')) ? readFileSync(join(daemonDir, 'daemon.lock'), 'utf8').slice(0, 200) : 'absent')

console.log('\n§2 a refused start names the holder and the freeing command')
const { FREE_THE_PLANE_WORDS } = await import('../../src/daemon/main.ts')
check('the refused-start words name `mercury daemon stop` and the hand remedy', /mercury daemon stop/.test(FREE_THE_PLANE_WORDS) && /end its pid by hand/.test(FREE_THE_PLANE_WORDS), FREE_THE_PLANE_WORDS)
const mainSource = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
check('the boot refusal line ("refusing to start so the live one is not clobbered") carries those words', /refusing to start so the live one is not clobbered · \$\{FREE_THE_PLANE_WORDS\}/.test(mainSource))

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ control-layer-held PROVEN' : `\n❌ ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

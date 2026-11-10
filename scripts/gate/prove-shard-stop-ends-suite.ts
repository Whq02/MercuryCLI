#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}

if (process.platform === 'win32') {
  console.log('SKIP shard-stop-ends-suite: POSIX process semantics only')
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'shard-stop-'))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const running = (pid: number): boolean => {
  const row = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return row !== '' && !row.startsWith('Z')
}
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (done()) return true
    await sleep(100)
  }
  return done()
}

type World = { dir: string; suites: string; pids: string; out: string; env: NodeJS.ProcessEnv }
function world(tag: string, seconds: number): World {
  const dir = join(work, tag)
  const suites = join(dir, 'suites')
  const pids = join(dir, 'suite.pids')
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  mkdirSync(join(suites, 'sleeper'), { recursive: true })
  writeFileSync(
    join(suites, 'sleeper', 'run-all.sh'),
    `#!/usr/bin/env bash\n# gate-class: pure\nsleep ${seconds} &\nprintf '%s %s\\n' "$$" "$!" >'${pids}.tmp' && mv '${pids}.tmp' '${pids}'\necho sleeper started\nwait\nexit 0\n`,
  )
  chmodSync(join(suites, 'sleeper', 'run-all.sh'), 0o755)
  writeFileSync(join(dir, 'seed.tsv'), 'sleeper\t5\n')
  writeFileSync(join(dir, 'ceilings.tsv'), '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: join(dir, 'tmp'),
    MERCURY_CONFIG_DIR: join(dir, 'home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_CI_SHARD_SUITES_DIR: suites,
    MERCURY_CI_SHARD_SEED_FILE: join(dir, 'seed.tsv'),
    MERCURY_CI_SHARD_CEILING_FILE: join(dir, 'ceilings.tsv'),
    MERCURY_CI_SHARD_OUT: join(dir, 'out'),
  }
  for (const name of ['RUNNER_TEMP', 'NODE_COMPILE_CACHE', 'NODE_OPTIONS', 'BUN_OPTIONS', 'MERCURY_SUITE_TMPDIR', 'MERCURY_SUITE_SCRIPT', 'MERCURY_SUITE_RUNNER_PID', 'MERCURY_PROCESS_LEDGER_DIR', 'MERCURY_TMPDIR', 'MERCURY_SUITE_TIMEOUT', 'MERCURY_SUITE_TIMEOUT_FLOOR', 'MERCURY_SUITE_CEILING']) delete env[name]
  for (const name of Object.keys(env)) if (name.startsWith('BASH_FUNC_')) delete env[name]
  return { dir, suites, pids, out: join(dir, 'out'), env }
}
function suitePids(w: World): number[] {
  return existsSync(w.pids) ? readFileSync(w.pids, 'utf8').trim().split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 1) : []
}
function ended(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(r => child.on('exit', (code, signal) => r({ code, signal })))
}
const suiteLog = (w: World): string => {
  const file = join(w.out, 'sleeper.out')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}
const strays: number[] = []

console.log('============================================================')
console.log(' a stopped runner leaves no suite running')
console.log('============================================================')

try {
  section('§1 the shard runner stopped by TERM: its suite in flight is ended before the runner returns')
  {
    const w = world('term', 120)
    const shard = spawn('bash', ['scripts/gate/ci-shard.sh', '0', '1'], { cwd: ROOT, env: w.env, stdio: 'ignore' })
    const exit = ended(shard)
    const started = await until(() => suitePids(w).length === 2, 60_000)
    const pids = suitePids(w)
    strays.push(...pids)
    check('the suite started under the runner', started && pids.every(running), `pids ${JSON.stringify(pids)}`)
    shard.kill('SIGTERM')
    const result = await exit
    check('the runner ended as a stopped shell does', result.code === 143 || result.signal === 'SIGTERM', JSON.stringify(result))
    const gone = await until(() => !pids.some(running), 3_000)
    check("no process of the suite is alive once the runner has returned", gone, `alive ${JSON.stringify(pids.filter(running))}`)
    check('the suite log names the stop', suiteLog(w).includes('__SUITE_RUNNER_SIGNALLED TERM'), suiteLog(w).slice(-200))
  }

  section('§2 the shard runner killed outright: no trap runs, and the suite unit ends its own tree within seconds')
  {
    const w = world('kill', 120)
    const shard = spawn('bash', ['scripts/gate/ci-shard.sh', '0', '1'], { cwd: ROOT, env: w.env, stdio: 'ignore' })
    const exit = ended(shard)
    const started = await until(() => suitePids(w).length === 2, 60_000)
    const pids = suitePids(w)
    strays.push(...pids)
    check('the suite started under the runner', started && pids.every(running), `pids ${JSON.stringify(pids)}`)
    shard.kill('SIGKILL')
    const result = await exit
    check('the runner died of the kill', result.signal === 'SIGKILL', JSON.stringify(result))
    const gone = await until(() => !pids.some(running), 15_000)
    check('no process of the suite is alive fifteen seconds later', gone, `alive ${JSON.stringify(pids.filter(running))}`)
    check('the suite log says its launcher was gone', suiteLog(w).includes('__SUITE_LAUNCHER_GONE'), suiteLog(w).slice(-200))
  }

  section('§3 a suite unit whose launcher stays runs to its own end, untouched')
  {
    const w = world('stays', 3)
    mkdirSync(w.out, { recursive: true })
    const unit = spawnSync('bash', ['scripts/gate/run-suite.sh', join(w.suites, 'sleeper', 'run-all.sh'), '60', w.out], { cwd: ROOT, env: w.env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })
    const log = suiteLog(w)
    check('the unit ended green', unit.status === 0, `rc ${unit.status} ${String(unit.stderr).slice(-200)}`)
    check('no stop marker in its log', !log.includes('__SUITE_LAUNCHER_GONE') && !log.includes('__SUITE_RUNNER_GONE') && !log.includes('__SUITE_RUNNER_SIGNALLED'), log.slice(-200))
  }

  section('§4 any launcher: a suite unit started in the background by a shell that is then killed ends its tree')
  {
    const w = world('launcher', 120)
    mkdirSync(w.out, { recursive: true })
    const launcher = spawn('bash', ['-c', 'bash scripts/gate/run-suite.sh "$1" 300 "$2" >/dev/null 2>&1 & wait', 'bash', join(w.suites, 'sleeper', 'run-all.sh'), w.out], { cwd: ROOT, env: w.env, stdio: 'ignore' })
    const exit = ended(launcher)
    const started = await until(() => suitePids(w).length === 2, 60_000)
    const pids = suitePids(w)
    strays.push(...pids)
    check('the suite started under the launcher', started && pids.every(running), `pids ${JSON.stringify(pids)}`)
    launcher.kill('SIGKILL')
    await exit
    const gone = await until(() => !pids.some(running), 15_000)
    check('no process of the suite is alive fifteen seconds later', gone, `alive ${JSON.stringify(pids.filter(running))}`)
    check('the suite log says its launcher was gone', suiteLog(w).includes('__SUITE_LAUNCHER_GONE'), suiteLog(w).slice(-200))
  }
} finally {
  for (const pid of strays) {
    if (running(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
  await sleep(500)
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

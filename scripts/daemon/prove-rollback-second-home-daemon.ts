#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { switchCurrent } from '../../src/platform/update-channel/installLayout.ts'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'
import { untilAsync } from '../lib/untilAsync.ts'

if (process.platform === 'win32') {
  console.log('prove-rollback-second-home-daemon: [SKIP] the staged release install is the POSIX one')
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(driver.kind === 'unavailable' ? `${driver.reason}: ${driver.remedy}` : 'the window scene needs the POSIX capture driver')

const TREE = resolve(import.meta.dir, '..', '..')
const python = driver.python
const engine = captureEngineEntry(driver, TREE)
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'rb-')))
const NEXT_TREE = 'c3c3c3c3c3c3'
const REOPEN = 'close this window and open Mercury again'
const staged = stageInstall('release', join(SCRATCH, 'h'))
const versionsDir = join(staged.home, 'versions')
const was = readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim()
const next = was.replace(/(\d+)$/, patch => String(Number(patch) + 1))
const project = join(SCRATCH, 'p')
for (const dir of [project, join(versionsDir, next)]) mkdirSync(dir)

for (const name of readdirSync(join(versionsDir, was))) {
  const from = join(versionsDir, was, name)
  const to = join(versionsDir, next, name)
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to)
  else if (name === 'mercury.mjs') writeFileSync(to, readFileSync(from, 'utf8').replaceAll(`VERSION:"${was}"`, `VERSION:"${next}"`))
  else copyFileSync(from, to, constants.COPYFILE_FICLONE)
}
const manifest = JSON.parse(readFileSync(join(versionsDir, next, 'manifest.json'), 'utf8')) as { buildTree: string }
const wasTree = manifest.buildTree.slice(0, 12)
writeFileSync(join(versionsDir, next, 'manifest.json'), JSON.stringify({ ...manifest, version: next, buildTree: NEXT_TREE + manifest.buildTree.slice(NEXT_TREE.length) }))
switchCurrent({ versionsDir, binDir: staged.bin, shimPath: staged.command, isWindows: false }, next)

type Home = { dir: string; log: string; env: NodeJS.ProcessEnv }
const otherHome = (id: number, login: NodeJS.ProcessEnv = {}): Home => {
  const dir = `${staged.home}${id}`
  mkdirSync(dir)
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ first: staged.home, id }))
  return { dir, log: join(SCRATCH, `home${id}.log`), env: { ...staged.env, ...login, MERCURY_CONFIG_DIR: dir, MERCURY_VERSIONS_DIR: versionsDir } }
}
const first: NodeJS.ProcessEnv = staged.env
const second = otherHome(2)
const third = otherHome(3, { ANTHROPIC_API_KEY: FIXTURE_API_KEY })
seedFirstRun(third.dir, [project])

const run = (env: NodeJS.ProcessEnv, args: string[]): { status: number | null; out: string } => {
  const child = spawnSync(staged.command, args, { cwd: project, env, encoding: 'utf8', timeout: 90_000 })
  return { status: child.status, out: `${child.stdout}${child.stderr}`.trim() }
}
const logged = (home: Home): string => readFileSync(home.log, 'utf8')
const shown = (text: string): void => console.log(text.split('\n').filter(line => line.trim() !== '').map(line => `    | ${line}`).join('\n'))

async function windowOf(home: Home): Promise<string> {
  const out = join(SCRATCH, 'window.json')
  const config = join(SCRATCH, 'window-config.json')
  writeFileSync(config, JSON.stringify({ argv: [staged.command], cwd: project, cols: 120, rows: 40, out, total: 600, sends: [{ awaitText: 'New Session', requireAwait: true, awaitSettleTicks: 4, data: '\r' }], readyText: 'Type a prompt', readySettleTicks: 25 }))
  const env = { ...home.env, TERM: 'xterm-256color', MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()) }
  await new Promise<void>(done => {
    const child = spawn(python, [engine, config], { cwd: TREE, env, stdio: 'ignore' })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
    child.on('close', () => {
      clearTimeout(deadline)
      done()
    })
  })
  const capture = (existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}) as { grid?: Array<Array<{ c?: string }>> }
  return (capture.grid ?? []).map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')
}

const THE_VERDICT = 'screenIsOlder in src/daemon/control/handshake.ts: the installed build decides before the version word does'
let failures = 0
const check = (label: string, ok: boolean, detail = '', fix = THE_VERDICT): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix ${fix}`}`)
}

console.log('============================================================')
console.log(' after a rollback, another home is told what is installed')
console.log('============================================================')
const daemons: ChildProcess[] = []
try {
  check(`the staged install runs v${next} with v${was} kept behind it`, run(first, ['--version']).out === `Mercury ${next}`, run(first, ['--version']).out)
  for (const home of [second, third]) {
    const fd = openSync(home.log, 'a')
    daemons.push(spawn(staged.command, ['daemon', 'run', project], { cwd: project, env: home.env, stdio: ['ignore', fd, fd], detached: true }))
  }
  const up = await untilAsync(() => [second, third].every((home, index) => run(home.env, ['daemon', 'status']).out.includes(`running · pid ${daemons[index]?.pid} · v${next}`)), 60_000, 500)
  check(`two other homes each run their own daemon on v${next}`, up, [second, third].map(home => `${run(home.env, ['daemon', 'status']).out} · ${logged(home).slice(-300)}`).join(' · '))

  const rolled = run(first, ['update', '--rollback'])
  check(`the first home rolls back to v${was}`, rolled.status === 0 && rolled.out.includes(`rolled back: ${next} → ${was}`), rolled.out)
  check('the rollback names no one version for every window still open', rolled.out.includes('window still open keeps working on the version it started with') && !/keeps working on v\d/.test(rolled.out), rolled.out, 'OPEN_WINDOWS_LINE in src/commands/verbs/update.ts')
  await untilAsync(() => [second, third].every(home => logged(home).includes(wasTree)), 15_000)
  check('both daemons log the build the install moved back to', [second, third].every(home => logged(home).includes(wasTree)), [second, third].map(home => logged(home).slice(-400)).join(' · '))

  console.log(`── a new start under one of them, v${was}: its commands ──`)
  const status = run(second.env, ['daemon', 'status'])
  shown(status.out)
  check('daemon status does not say this Mercury is not the installed build', status.status === 0 && !status.out.includes('not the installed build'), status.out)
  const restart = run(second.env, ['daemon', 'restart'])
  shown(restart.out)
  check(`daemon restart does not call v${next} installed`, !restart.out.includes(`v${next} is installed`), restart.out)
  check(`daemon restart lands the daemon on v${was}`, restart.status === 0 && restart.out.includes(`v${was}`), `exit ${restart.status}: ${restart.out}`)
  const after = run(second.env, ['daemon', 'status'])
  shown(after.out)
  check(`the daemon that answers afterwards is v${was}`, after.out.includes(`v${was}`) && !after.out.includes(`v${next}`), after.out)

  console.log(`── a new window under the other, v${was} ──`)
  const frame = await windowOf(third)
  shown(frame.split('\n').slice(-8).join('\n'))
  check('the window opens its chat', frame.includes('Type a prompt'), frame.slice(-600))
  check(`and is not told that v${next} is installed, nor to close and open again`, frame.includes('Type a prompt') && !frame.includes(`v${next} is installed`) && !frame.includes(REOPEN), frame.split('\n').filter(line => line.includes('installed') || line.includes(REOPEN)).join(' · '))
} finally {
  for (const env of [first, second.env, third.env]) run(env, ['daemon', 'stop'])
  for (const daemon of daemons) daemon.kill('SIGKILL')
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-rollback-second-home-daemon: ALL HOLD' : `\nprove-rollback-second-home-daemon: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)

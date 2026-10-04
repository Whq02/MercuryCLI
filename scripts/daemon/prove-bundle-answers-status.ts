#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const VENDORED_NODE = join(REPO, 'dist', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'

const STATUS_BOUND_MS = 60_000
const STOP_BOUND_MS = 20_000
const RUNNING_ROW = /^\s*daemon:\s+running · pid (\d+) · v\S+ · up \d+s$/m
const NOT_RUNNING_ROW = /^\s*daemon:\s+not running$/m
const REFUSED_START_WORDS = /too many arguments|unknown option|unknown verb/

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const firstLine = (s: string): string => s.split('\n').find(l => l.trim() !== '') ?? '(empty)'

const SCRATCH = mkdtempSync(join(tmpdir(), 'bundle-status-'))
const home = join(SCRATCH, 'home')
const work = join(SCRATCH, 'work')
for (const d of [home, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# bundle status fixture\n')
const env: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'proof-key-not-a-real-key',
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:1',
  MERCURY_DAEMON_PERSIST: '1',
  MERCURY_DAEMON_NO_SELF_WARM: '1',
  MERCURY_EVOLUTION_LEDGER: '0',
}
for (const name of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM']) delete env[name]

const bundle = (...words: string[]): { rc: number; text: string } => {
  const r = spawnSync(NODE, [DIST, ...words], { env, encoding: 'utf8', timeout: 30_000 })
  return { rc: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

console.log('a built bundle starts its own daemon in a scratch home, answers status by its running row, and stops through its own stop')
console.log(`  node: ${NODE}\n  world: ${SCRATCH}`)

section('§1 the bundle answers --version as Mercury')
const version = bundle('--version')
check('`--version` exits 0 and answers as Mercury', version.rc === 0 && /^Mercury /.test(version.text.trim()), `exit ${version.rc}: ${firstLine(version.text)}`)

section('§2 `daemon run <work>` starts the daemon from the bundle')
const logPath = join(SCRATCH, 'daemon.log')
const logFd = openSync(logPath, 'a')
const daemon = spawn(NODE, [DIST, 'daemon', 'run', work], { env, stdio: ['ignore', logFd, logFd] })
const daemonPid = daemon.pid
let exitCode: number | null = null
daemon.on('exit', code => {
  exitCode = code
})
check('the daemon process started', daemonPid !== undefined && alive(daemonPid))

section(`§3 \`daemon status\` reads the running row within ${STATUS_BOUND_MS / 1000}s — the deploy road's check greps exactly this row (\`daemon:\` + \`running\`); whoever renames it renames the check in the same change`)
const t0 = Date.now()
let statusText = ''
let statusRc = -1
let answeredMs: number | null = null
while (Date.now() - t0 < STATUS_BOUND_MS && exitCode === null) {
  const r = bundle('daemon', 'status')
  statusText = r.text
  statusRc = r.rc
  if (RUNNING_ROW.test(statusText)) {
    answeredMs = Date.now() - t0
    break
  }
  await sleep(1000)
}
check(`the running row answered within the bound${answeredMs !== null ? ` (${answeredMs}ms)` : ''}`, answeredMs !== null, `exit ${statusRc}; last answer:\n${statusText}\n--- daemon.log ---\n${readFileSync(logPath, 'utf8')}`)
check('`daemon status` exits 0 when it answers', statusRc === 0, `exit ${statusRc}`)
const rowPid = Number(RUNNING_ROW.exec(statusText)?.[1] ?? NaN)
check('the running row names the pid the bundle just started', rowPid === daemonPid, `row pid ${rowPid}, started pid ${daemonPid}`)
check('the daemon still runs after it answered', exitCode === null && alive(daemonPid))

section(`§4 \`daemon stop\` is acknowledged and the daemon leaves within ${STOP_BOUND_MS / 1000}s`)
const stop = bundle('daemon', 'stop')
check('`daemon stop` exits 0 and says the shutdown was acknowledged', stop.rc === 0 && stop.text.includes('shutdown acknowledged'), `exit ${stop.rc}: ${firstLine(stop.text)}`)
const t1 = Date.now()
while (Date.now() - t1 < STOP_BOUND_MS && alive(daemonPid)) await sleep(250)
check('the daemon process left', !alive(daemonPid), `pid ${daemonPid} alive ${STOP_BOUND_MS / 1000}s after the stop`)
const after = bundle('daemon', 'status')
check('after the stop, `daemon status` reads the not-running row', after.rc === 0 && NOT_RUNNING_ROW.test(after.text), `exit ${after.rc}:\n${after.text}`)

section('§5 the daemon log carries no refusal of its own start words')
const log = readFileSync(logPath, 'utf8')
check('the log carries the control socket coming up', log.includes('control socket up'), log.slice(-600))
check('no "too many arguments", "unknown option" or "unknown verb"', !REFUSED_START_WORDS.test(log), log.split('\n').filter(l => REFUSED_START_WORDS.test(l)).join('\n'))

if (alive(daemonPid)) daemon.kill('SIGTERM')
if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`[forensics] world kept: ${SCRATCH}`)
console.log(failures === 0 ? '\nprove-bundle-answers-status: all green' : `\nprove-bundle-answers-status: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

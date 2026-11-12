#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sealed-store-other-builds-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.CI
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { getProcessStartInstant } = await import(join(SRC, 'daemon/ownerWatch.ts'))

let total = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  total++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const THIS_MARK = '1f0e0d0c0b0a'
const OTHER_MARK = '0a0b0c0d0e0f'

const THIS_BUILD = `
globalThis.MACRO = { VERSION: '1.0.0' }
const SRC = ${JSON.stringify(SRC)}
const started = Date.now()
if (process.argv[2] === 'stay') {
  console.log(JSON.stringify({ loaded: 'this-build', pid: process.pid, started }))
  process.stdin.resume()
} else if (process.argv[2] === 'window') {
  const { registerCockpit } = await import(SRC + '/daemon/processSweepRun.ts')
  const home = process.env.MERCURY_CONFIG_DIR
  const registration = await registerCockpit({ terminal: null, home, daemonDirPath: home + '/daemon' })
  console.log(JSON.stringify({ loaded: 'this-build', pid: process.pid, started, registration: registration === null ? null : registration.path }))
  process.stdin.resume()
} else {
  const { otherBuildAlive } = await import(SRC + '/utils/secureStorage/otherBuilds.ts')
  const { plainTextStorage } = await import(SRC + '/utils/secureStorage/plainTextStorage.ts')
  const { startSealedStore } = await import(SRC + '/utils/secureStorage/sealedStoreStart.ts')
  const { createKeyCustody } = await import(SRC + '/utils/secureStorage/sealedRecord.ts')
  const { getProcessStartInstant } = await import(SRC + '/daemon/ownerWatch.ts')
  const home = process.env.MERCURY_CONFIG_DIR
  const alive = JSON.parse(process.env.FIXTURE_TABLE ?? '[]')
  const observation = (pid, args, startedAtMs, startToken) => ({ process: { pid, ppid: 1, exe: process.execPath, args, startedAtMs, user: 'fixture-user', terminal: null }, startToken, state: 'S', terminalAlive: null })
  const table = [observation(process.pid, [process.execPath, process.argv[1]], started, getProcessStartInstant(process.pid)), ...alive.map(other => observation(other.pid, other.args, other.started, other.startToken))]
  const read = () => otherBuildAlive({ home, ownDaemonDir: home + '/daemon', collect: async () => ({ complete: true, observations: table }) })
  const protector = {
    scheme: 'fake-protector',
    protect: secret => ({ ok: true, bytes: Buffer.concat([Buffer.from('held:'), secret]) }),
    unprotect: token => ({ ok: true, bytes: token.subarray(5) }),
    async protectAsync(secret) { return this.protect(secret) },
    async unprotectAsync(token) { return this.unprotect(token) },
  }
  plainTextStorage.update({ trustedDeviceToken: 'fixture-device-only' })
  const decision = await read()
  const outcome = await startSealedStore({ file: plainTextStorage, custody: createKeyCustody(protector), otherBuildAlive: read }).settled
  console.log('RESULT ' + JSON.stringify({ decision, outcome, sealed: Object.hasOwn(plainTextStorage.read() ?? {}, 'mercurySealed') }))
  process.exit(0)
}
`
const OTHER_BUILD = `
console.log(JSON.stringify({ loaded: 'another-build', pid: process.pid, started: Date.now() }))
process.stdin.resume()
`

type Alive = { child: ChildProcess; pid: number; args: string[]; started: number; startToken: string | null; loaded: string; registration: string | null }
type Result = { decision: string | null; outcome: string; sealed: boolean } | null
const running: ChildProcess[] = []

function payload(folder: string, source: string, mark: string): string {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'mercury.mjs'), source)
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ buildTree: `${mark}${'0'.repeat(28)}` }))
  return join(folder, 'mercury.mjs')
}

async function startAlive(script: string, more: string[] = [], home?: string): Promise<Alive> {
  const child = spawn(process.execPath, [script, ...more], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(home === undefined ? {} : { MERCURY_CONFIG_DIR: home }) } })
  running.push(child)
  let out = ''
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      if (out.includes('\n')) resolve(out.split('\n')[0] ?? '')
    })
    child.once('error', reject)
    child.once('exit', () => reject(new Error(`the fixture process ended before it spoke: ${out}`)))
  })
  const said = JSON.parse(line) as { loaded: string; pid: number; started: number; registration?: string | null }
  return { child, pid: said.pid, args: [process.execPath, script, ...more], started: said.started, startToken: getProcessStartInstant(said.pid) as string | null, loaded: said.loaded, registration: said.registration ?? null }
}

function startThisBuild(script: string, home: string, alive: Alive[]): Result {
  mkdirSync(home, { recursive: true })
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home, FIXTURE_TABLE: JSON.stringify(alive.map(({ pid, args, started, startToken }) => ({ pid, args, started, startToken }))) },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const line = run.stdout.split('\n').find(candidate => candidate.startsWith('RESULT '))
  if (line === undefined) {
    console.log(`  the start of this build gave no result: rc=${String(run.status)} ${run.stderr.slice(-400)}`)
    return null
  }
  return JSON.parse(line.slice(7)) as Result
}

const stillAlive = (other: Alive): boolean => {
  try {
    process.kill(other.pid, 0)
    return true
  } catch {
    return false
  }
}
const windowRecord = (home: string, window: Alive, mark: string | null): void => {
  mkdirSync(join(home, 'processes'), { recursive: true })
  const id = `11111111-2222-3333-4444-${String(window.pid).padStart(12, '0')}`
  writeFileSync(
    join(home, 'processes', `cockpit-${window.pid}-${id}.json`),
    JSON.stringify({ schema: 1, id, pid: window.pid, startToken: window.startToken, exe: process.execPath, bundle: window.args[1], ...(mark === null ? {} : { buildTree: mark }), configHome: home, daemonDir: join(home, 'daemon'), terminal: null, bornAt: window.started, heartbeatAt: Date.now() }),
  )
}
const daemonRecord = (home: string, daemon: Alive, mark: string): void => {
  mkdirSync(join(home, 'daemon'), { recursive: true })
  writeFileSync(join(home, 'daemon', 'daemon.json'), JSON.stringify({ pid: daemon.pid, version: '1.0.0', origin: 'transient', startedAt: daemon.started, dir: join(home, 'daemon'), controlSock: join(home, 'daemon', 'control.sock'), buildTree: mark, script: daemon.args[1], startInstant: daemon.startToken, persist: true }))
}
const plainFor = (result: Result, why: RegExp): boolean => result !== null && result.sealed === false && result.decision !== null && why.test(result.decision) && result.outcome === `left plain until the next start: ${result.decision}`
const sealedFor = (result: Result): boolean => result !== null && result.decision === null && result.outcome === 'sealed' && result.sealed === true
const said = (result: Result): string => (result === null ? 'no result' : JSON.stringify(result))

let worlds = 0
const world = (): string => {
  const at = join(SCRATCH, `world-${++worlds}`)
  mkdirSync(at, { recursive: true })
  return at
}

section('§1 an older build alive through a folder alias, the alias then moved to this build')
{
  const at = world()
  const other = payload(join(at, 'payloads', 'older'), OTHER_BUILD, OTHER_MARK)
  payload(join(at, 'payloads', 'this'), THIS_BUILD, THIS_MARK)
  const alias = join(at, 'current')
  symlinkSync(join(at, 'payloads', 'older'), alias, 'dir')
  const older = await startAlive(join(alias, 'mercury.mjs'))
  check('a process of the older build is alive, started through the alias', older.loaded === 'another-build' && other.endsWith('mercury.mjs') && older.startToken !== null, JSON.stringify(older.args))
  unlinkSync(alias)
  symlinkSync(join(at, 'payloads', 'this'), alias, 'dir')
  const result = startThisBuild(join(alias, 'mercury.mjs'), join(at, 'home'), [older])
  check('this build, started through the moved alias, does not take that process for its own build: its bundle is named through a link', plainFor(result, /^process \d+ names its bundle by a path that is not its real path \(.*current.mercury\.mjs\)$/), said(result))
  check('the older process is still alive, and the store it reads is still plain', stillAlive(older) && result?.sealed === false, said(result))
}

section('§2 the other way: the alias rolled back to this build while a window of the build it pointed to is alive')
{
  const at = world()
  const mine = payload(join(at, 'payloads', 'this'), THIS_BUILD, THIS_MARK)
  const longAgo = new Date(Date.now() - 86_400_000)
  utimesSync(mine, longAgo, longAgo)
  payload(join(at, 'payloads', 'newer'), OTHER_BUILD, OTHER_MARK)
  const alias = join(at, 'current')
  symlinkSync(join(at, 'payloads', 'newer'), alias, 'dir')
  const window = await startAlive(join(alias, 'mercury.mjs'))
  windowRecord(join(at, 'home'), window, OTHER_MARK)
  unlinkSync(alias)
  symlinkSync(join(at, 'payloads', 'this'), alias, 'dir')
  const result = startThisBuild(join(alias, 'mercury.mjs'), join(at, 'home'), [window])
  check('that window wrote its own build mark when it loaded, and the mark is not this build\'s: the file stays plain', plainFor(result, new RegExp(`^another Mercury build is running \\(process ${window.pid}, build ${OTHER_MARK}\\)$`)), said(result))
  check('the window is still alive', stillAlive(window))
}

section('§3 a window of a build that writes no mark, alive by its own real path')
{
  const at = world()
  const older = await startAlive(payload(join(at, 'payloads', 'older'), OTHER_BUILD, OTHER_MARK))
  windowRecord(join(at, 'home'), older, null)
  const result = startThisBuild(payload(join(at, 'payloads', 'this'), THIS_BUILD, THIS_MARK), join(at, 'home'), [older])
  check('a registration with no build mark is an older build\'s: the file stays plain', plainFor(result, new RegExp(`^an older Mercury build is running \\(process ${older.pid}: its record carries no build mark\\)$`)), said(result))
}

section('§4 a payload renamed into place over a real path, under a process of the payload it replaced')
{
  const at = world()
  payload(join(at, 'payloads', 'staged'), THIS_BUILD, THIS_MARK)
  const live = join(at, 'payloads', 'live')
  payload(live, OTHER_BUILD, OTHER_MARK)
  const older = await startAlive(join(live, 'mercury.mjs'))
  renameSync(live, join(at, 'payloads', 'retired'))
  renameSync(join(at, 'payloads', 'staged'), live)
  const result = startThisBuild(join(live, 'mercury.mjs'), join(at, 'home'), [older])
  check('the older process names the very path this build now runs from, with no link in it, and was born after this payload was written: it still counts, born before the payload was put in place', plainFor(result, new RegExp(`^process ${older.pid} started before this build was put in place$`)), said(result))
  check('the older process is still alive', stillAlive(older))
}

section('§5 what must still seal')
{
  const alone = world()
  const only = startThisBuild(payload(join(alone, 'payloads', 'this'), THIS_BUILD, THIS_MARK), join(alone, 'home'), [])
  check('this build alone seals', sealedFor(only), said(only))

  const handed = world()
  const mine = payload(join(handed, 'payloads', 'this'), THIS_BUILD, THIS_MARK)
  const daemon = await startAlive(mine, ['stay'])
  daemonRecord(join(handed, 'home'), daemon, THIS_MARK)
  const withDaemon = startThisBuild(mine, join(handed, 'home'), [daemon])
  check('this build with its own handed-over daemon alive, its record carrying this build\'s mark, seals', daemon.loaded === 'this-build' && sealedFor(withDaemon) && stillAlive(daemon), said(withDaemon))

  const withRunner = world()
  const script = payload(join(withRunner, 'payloads', 'this'), THIS_BUILD, THIS_MARK)
  const runner = await startAlive(script, ['stay'])
  const beside = startThisBuild(script, join(withRunner, 'home'), [runner])
  check('this build with a runner of its own, which writes no record, started by the real path: seals', sealedFor(beside) && stillAlive(runner), said(beside))

  const linked = world()
  const real = payload(join(linked, 'payloads', 'this'), THIS_BUILD, THIS_MARK)
  symlinkSync(join(linked, 'payloads', 'this'), join(linked, 'current'), 'dir')
  mkdirSync(join(linked, 'home'), { recursive: true })
  const window = await startAlive(join(linked, 'current', 'mercury.mjs'), ['window'], join(linked, 'home'))
  const registered = window.registration === null ? {} : (JSON.parse(readFileSync(window.registration, 'utf8')) as Record<string, unknown>)
  check('a window of this build writes its own registration with the mark of the build it loaded', registered.pid === window.pid && registered.buildTree === THIS_MARK && typeof registered.startToken === 'string', JSON.stringify(registered))
  const byRecord = startThisBuild(real, join(linked, 'home'), [window])
  check('this build with that window alive, though it was started through a link: its registration carries this build\'s mark, and it seals', sealedFor(byRecord) && stillAlive(window), said(byRecord))

  const unrecorded = world()
  const direct = payload(join(unrecorded, 'payloads', 'this'), THIS_BUILD, THIS_MARK)
  symlinkSync(join(unrecorded, 'payloads', 'this'), join(unrecorded, 'current'), 'dir')
  const headless = await startAlive(join(unrecorded, 'current', 'mercury.mjs'), ['stay'])
  const unknown = startThisBuild(direct, join(unrecorded, 'home'), [headless])
  check('the cost, said: a process of this build that wrote no record and was started through a link is unknown, and the file stays plain while it lives', plainFor(unknown, /^process \d+ names its bundle by a path that is not its real path/), said(unknown))
  headless.child.kill()
  await new Promise(resolve => headless.child.once('exit', resolve))
  const afterwards = startThisBuild(direct, join(unrecorded, 'home'), [])
  check('and once it has ended, the next start seals', sealedFor(afterwards), said(afterwards))
}

for (const child of running) {
  if (child.exitCode === null && child.signalCode === null) child.kill()
}
rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)

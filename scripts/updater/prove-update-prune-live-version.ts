#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LayoutRoots, PruneReport } from '../../src/services/privateChannel/installLayout.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'update-prune-live-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_VERSIONS_DIR
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_UPDATE_FAULT
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { pruneSupersededVersions } = await import('../../src/services/privateChannel/installLayout.ts')
const service = (await import('../../src/services/privateChannel/updateService.ts')) as { livePayloadDirs?: (roots: LayoutRoots) => Promise<string[]> }
const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')

const IS_WINDOWS = process.platform === 'win32'
const DEAD = 4242421

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const describe = (value: unknown): string => (value instanceof Error ? value.message.slice(0, 160) : String(JSON.stringify(value)).slice(0, 240))

const realKill = process.kill.bind(process)
process.kill = ((pid: number, signal?: string | number) => {
  if (pid === DEAD && signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  return realKill(pid, signal as NodeJS.Signals)
}) as typeof process.kill

const DAEMON_VERSION = '9.9.6-beta.1'
const SUPERSEDED = '9.9.6-beta.2'
const PREVIOUS = '9.9.6-beta.3'
const CURRENT = '9.9.6-beta.4'

const makePayload = (dir: string, version: string): void => {
  mkdirSync(join(dir, 'vendor', 'ripgrep', 'stub'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ version })}\n`)
  writeFileSync(join(dir, 'mercury.mjs'), `console.log('Mercury ${version}')\n`)
  writeFileSync(join(dir, 'mercury'), '#!/bin/sh\nexec node "$(dirname "$0")/mercury.mjs" "$@"\n')
}

const layoutFor = (name: string): LayoutRoots => {
  const base = join(SCRATCH, name)
  const roots: LayoutRoots = { versionsDir: join(base, 'versions'), binDir: join(base, 'bin'), shimPath: join(base, 'bin', IS_WINDOWS ? 'mercury.cmd' : 'mercury'), isWindows: IS_WINDOWS }
  for (const version of [DAEMON_VERSION, SUPERSEDED, PREVIOUS, CURRENT]) makePayload(join(roots.versionsDir, version), version)
  writeFileSync(join(roots.versionsDir, 'current.txt'), `${CURRENT}\n`)
  writeFileSync(join(roots.versionsDir, 'previous.txt'), `${PREVIOUS}\n`)
  return roots
}

const daemonRecord = (record: { pid: number; version: string; script?: string } | null): void => {
  const dir = join(process.env.MERCURY_CONFIG_DIR!, 'daemon')
  mkdirSync(dir, { recursive: true })
  if (record === null) rmSync(join(dir, 'daemon.json'), { force: true })
  else writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ origin: 'transient', startedAt: Date.now(), dir: SCRATCH, controlSock: join(dir, 'control.sock'), proto: 1, buildTree: null, ...record }, null, 2))
}

const pruneAsTheUpdateDoes = async (roots: LayoutRoots): Promise<PruneReport> => {
  const live = service.livePayloadDirs === undefined ? null : await service.livePayloadDirs(roots)
  return live === null ? pruneSupersededVersions(roots) : pruneSupersededVersions(roots, live)
}
const intact = (roots: LayoutRoots, version: string): boolean => existsSync(join(roots.versionsDir, version, 'mercury.mjs')) && existsSync(join(roots.versionsDir, version, 'manifest.json'))
const whole = (roots: LayoutRoots, version: string): boolean => intact(roots, version) && existsSync(join(roots.versionsDir, version, 'vendor', 'ripgrep', 'stub', 'rg')) && existsSync(join(roots.versionsDir, version, 'mercury'))

const NODE = nodeBinPath()
const WINDOW_BODY = "process.title = 'mercury'\nconsole.log('ready')\nsetInterval(() => {}, 1000)\n"
const STAYING_BODY = "console.log('ready')\nsetInterval(() => {}, 1000)\n"
const started: ChildProcess[] = []
const startFrom = (script: string, body: string, args: string[] = []): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, body)
    const child = spawn(NODE, [script, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    started.push(child)
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`${script} ended with ${code} before it was ready`)))
    child.stdout!.once('data', () => resolve(child))
  })
const end = (child: ChildProcess): Promise<void> =>
  new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
const commandLineOf = (pid: number): string => spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
const processesDir = (): string => join(process.env.MERCURY_CONFIG_DIR!, 'processes')
const register = (pid: number, bundle: string, startToken: string | null): void => {
  const id = randomUUID()
  mkdirSync(processesDir(), { recursive: true })
  writeFileSync(join(processesDir(), `cockpit-${pid}-${id}.json`), JSON.stringify({ schema: 1, id, pid, startToken, exe: NODE, bundle, configHome: process.env.MERCURY_CONFIG_DIR, daemonDir: join(process.env.MERCURY_CONFIG_DIR!, 'daemon'), terminal: null, bornAt: Date.now(), heartbeatAt: Date.now() }, null, 2))
}
const forgetWindows = (): void => rmSync(processesDir(), { recursive: true, force: true })

console.log('============================================================')
console.log(' the update prune and the version a live Mercury runs from')
console.log('============================================================')

console.log('§1 the background daemon runs from a version that is neither current nor previous')
{
  const roots = layoutFor('live-daemon')
  daemonRecord({ pid: process.pid, version: DAEMON_VERSION, script: join(roots.versionsDir, DAEMON_VERSION, 'mercury.mjs') })
  const report = await pruneAsTheUpdateDoes(roots)
  check('the version the live daemon runs from is kept and reported kept, not removed', report.kept.includes(DAEMON_VERSION) && !report.removed.includes(DAEMON_VERSION) && intact(roots, DAEMON_VERSION), describe(report))
  check('the superseded version nobody runs from still goes', report.removed.includes(SUPERSEDED) && !existsSync(join(roots.versionsDir, SUPERSEDED)), describe(report))
  check('current and previous are kept as before, nothing is left', report.kept.includes(CURRENT) && report.kept.includes(PREVIOUS) && report.left.length === 0, describe(report))
}

console.log('§2 a daemon record whose process has gone keeps nothing extra')
{
  const roots = layoutFor('dead-daemon')
  daemonRecord({ pid: DEAD, version: DAEMON_VERSION, script: join(roots.versionsDir, DAEMON_VERSION, 'mercury.mjs') })
  const report = await pruneAsTheUpdateDoes(roots)
  check('a dead daemon\'s version is pruned like any other', report.removed.includes(DAEMON_VERSION) && report.removed.includes(SUPERSEDED) && !existsSync(join(roots.versionsDir, DAEMON_VERSION)), describe(report))
}

console.log('§3 a live daemon record that names its version but no script keeps that version by name')
{
  const roots = layoutFor('unplaced-daemon')
  daemonRecord({ pid: process.pid, version: DAEMON_VERSION })
  const report = await pruneAsTheUpdateDoes(roots)
  check('a version the update cannot place but a live daemon names is kept, not removed', report.kept.includes(DAEMON_VERSION) && intact(roots, DAEMON_VERSION), describe(report))
}

console.log('§4 no daemon record: the prune keeps only current, previous and the updater\'s own copy')
{
  const roots = layoutFor('no-daemon')
  daemonRecord(null)
  const report = await pruneAsTheUpdateDoes(roots)
  check('both superseded versions go', report.removed.length === 2 && report.kept.length === 2 && report.left.length === 0, describe(report))
}

console.log('§5 a removal that fails is named as not removed whole — in the layout\'s report, in the update\'s outcome and on the verbs\' screen')
{
  const roots = layoutFor('left')
  daemonRecord(null)
  process.env.MERCURY_UPDATE_FAULT = 'prune-rm'
  const report = await pruneAsTheUpdateDoes(roots)
  delete process.env.MERCURY_UPDATE_FAULT
  check('the layout reports the versions it could not remove under left, intact, and throws nothing', report.left.length === 2 && report.left.includes(DAEMON_VERSION) && report.left.includes(SUPERSEDED) && report.removed.length === 0 && intact(roots, DAEMON_VERSION) && intact(roots, SUPERSEDED), describe(report))
  const svc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'privateChannel', 'updateService.ts'), 'utf8')
  const prunes = svc.split('pruneSupersededVersions(roots, await livePayloadDirs(roots))').length - 1
  check('the update and the install transactions prune with the live payload directories, not the updater\'s copy alone', prunes === 2, `${prunes} call(s) feed the live set`)
  const outcomes = (svc.match(/\n {6}pruned: string\[\]\n {6}left: string\[\]\n/g) ?? []).length
  check('the updated and the installed outcomes carry left beside pruned', outcomes === 2, `${outcomes} outcome type(s) carry left`)
  const returned = (svc.match(/\n {6}pruned,\n {6}left,\n/g) ?? []).length
  check('both transactions return what was left beside what went', returned === 2, `${returned} return(s) carry left`)
  const verbs = ['update.ts', 'installVerb.ts'].map(name => readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', name), 'utf8'))
  check('the update and the install verbs print what was not removed whole, and why, right after what was removed', verbs.every(verb => verb.includes("result.left.length > 0 ? ") && verb.includes('older versions not removed whole (a file in them is still in use, or could not be deleted; the next ') && verb.indexOf('removed older versions:') >= 0 && verb.indexOf('older versions not removed whole') > verb.indexOf('removed older versions:')), `${verbs.filter(verb => verb.includes('older versions not removed whole')).length} verb(s) print it`)
}

console.log('§6 a window opened on a version that is neither current nor previous: its registration names the bundle it runs from')
{
  const roots = layoutFor('live-window')
  daemonRecord(null)
  const bundle = join(roots.versionsDir, DAEMON_VERSION, 'mercury.mjs')
  const window = await startFrom(bundle, WINDOW_BODY)
  register(window.pid!, bundle, await getProcessStartTokenAsync(window.pid!))
  if (!IS_WINDOWS) check("the window's command line reads mercury: only its registration names the bundle", commandLineOf(window.pid!) === 'mercury', commandLineOf(window.pid!))
  const report = await pruneAsTheUpdateDoes(roots)
  check('the version the open window runs from is kept whole: bundle, manifest, launcher and vendored search binary', report.kept.includes(DAEMON_VERSION) && !report.removed.includes(DAEMON_VERSION) && whole(roots, DAEMON_VERSION), describe(report))
  check('the superseded version nobody runs from still goes', report.removed.includes(SUPERSEDED) && !existsSync(join(roots.versionsDir, SUPERSEDED)), describe(report))
  await end(window)
  const later = await pruneAsTheUpdateDoes(roots)
  check('once the window has closed its registration pins nothing: the next prune takes the version', later.removed.includes(DAEMON_VERSION) && !existsSync(join(roots.versionsDir, DAEMON_VERSION)), describe(later))
  forgetWindows()
}

console.log('§7 a registration never pins for a process that is not its window')
if (IS_WINDOWS) console.log('  [SKIP] a Windows command line always names the bundle, so no registration decides there')
else {
  const unnamed = layoutFor('recorded-pid-not-mercury')
  daemonRecord(null)
  const stranger = await startFrom(join(SCRATCH, 'another-program.mjs'), STAYING_BODY)
  register(stranger.pid!, join(unnamed.versionsDir, DAEMON_VERSION, 'mercury.mjs'), await getProcessStartTokenAsync(stranger.pid!))
  const first = await pruneAsTheUpdateDoes(unnamed)
  check('a live process on the recorded pid and start time whose command line does not name Mercury pins nothing', first.removed.includes(DAEMON_VERSION) && first.removed.includes(SUPERSEDED), describe(first))
  await end(stranger)
  forgetWindows()

  const reborn = layoutFor('recorded-pid-reused')
  const newer = await startFrom(join(reborn.versionsDir, CURRENT, 'mercury.mjs'), WINDOW_BODY)
  register(newer.pid!, join(reborn.versionsDir, DAEMON_VERSION, 'mercury.mjs'), await getProcessStartTokenAsync(process.pid))
  const second = await pruneAsTheUpdateDoes(reborn)
  check('another Mercury born at another time on the recorded pid pins nothing for the window that is gone', second.removed.includes(DAEMON_VERSION) && second.kept.includes(CURRENT), describe(second))
  await end(newer)
  forgetWindows()
}

console.log('§8 a daemon that kept its sessions at a handover: the record names its successor, its own command line names the older bundle')
{
  const roots = layoutFor('predecessor-daemon')
  daemonRecord({ pid: process.pid, version: CURRENT, script: join(roots.versionsDir, CURRENT, 'mercury.mjs') })
  const predecessor = await startFrom(join(roots.versionsDir, DAEMON_VERSION, 'mercury.mjs'), STAYING_BODY, ['daemon', 'run', SCRATCH])
  const report = await pruneAsTheUpdateDoes(roots)
  check('the version the predecessor still runs from is kept whole', report.kept.includes(DAEMON_VERSION) && !report.removed.includes(DAEMON_VERSION) && whole(roots, DAEMON_VERSION), describe(report))
  check('the superseded version nobody runs from still goes', report.removed.includes(SUPERSEDED) && !existsSync(join(roots.versionsDir, SUPERSEDED)), describe(report))
  await end(predecessor)
  const later = await pruneAsTheUpdateDoes(roots)
  check('once the predecessor has gone the next prune takes its version', later.removed.includes(DAEMON_VERSION) && !existsSync(join(roots.versionsDir, DAEMON_VERSION)), describe(later))
  daemonRecord(null)
}

console.log('§9 the process table cannot be read: the prune runs on what the records prove, as it did before')
if (IS_WINDOWS) console.log('  [SKIP] the scene hides ps from the search path; Windows reads its table another way')
else {
  const roots = layoutFor('unread-table')
  daemonRecord({ pid: process.pid, version: DAEMON_VERSION, script: join(roots.versionsDir, DAEMON_VERSION, 'mercury.mjs') })
  const searchPath = process.env.PATH
  process.env.PATH = join(SCRATCH, 'no-programs-here')
  const blind = await pruneAsTheUpdateDoes(roots)
  process.env.PATH = searchPath
  check("the recorded live daemon's version is kept, the version nobody is recorded on goes, and nothing is left or thrown", blind.kept.includes(DAEMON_VERSION) && whole(roots, DAEMON_VERSION) && blind.removed.length === 1 && blind.removed[0] === SUPERSEDED && blind.left.length === 0, describe(blind))
  daemonRecord(null)
}

for (const child of started) await end(child)
process.kill = realKill as typeof process.kill
try {
  rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(`\nprove-update-prune-live-version: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

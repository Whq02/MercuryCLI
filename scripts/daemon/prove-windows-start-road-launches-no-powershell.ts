#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'

const SCENES = ['warm', 'unlined', 'own', 'own-noisy', 'cold'] as const
type Scene = (typeof SCENES)[number]
const scene = process.argv.find(arg => arg.startsWith('--scene='))?.slice(8)
if (scene === undefined) {
  let failed = 0
  for (const name of SCENES) {
    const result = cp.spawnSync(process.execPath, [import.meta.filename, `--scene=${name}`], { stdio: 'inherit', env: process.env })
    if (result.status !== 0) failed++
  }
  console.log(failed === 0 ? '\nprove-windows-start-road-launches-no-powershell: all green' : `\nprove-windows-start-road-launches-no-powershell: ${failed} scene(s) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}
const isScene = (name: string): name is Scene => SCENES.some(known => known === name)
if (!isScene(scene)) throw new Error(`no such scene: ${scene}`)

const HOST = process.platform
const SCRATCH = mkdtempSync(join(tmpdir(), 'windows-start-road-'))
const WORK = join(SCRATCH, 'work')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
for (const dir of [process.env.MERCURY_CONFIG_DIR, process.env.MERCURY_DAEMON_DIR, WORK]) mkdirSync(dir, { recursive: true })
writeFileSync(
  join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'proof-token-not-a-real-one', refreshToken: 'proof-refresh-not-a-real-one', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
for (const name of ['MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES', 'MERCURY_WARM_RUNNER', 'MERCURY_DAEMON_NO_SELF_WARM']) delete process.env[name]

const STRANGERS = [600_101, 600_102, 600_103, 600_104, 600_105, 600_106]
const FIRST_RUNNER = 600_201
const standIn = (pid: number): boolean => pid >= 600_100 && pid < 600_300
const alive = new Set<number>(STRANGERS)
const realKill = process.kill
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
  const target = Math.abs(pid)
  if (!standIn(target)) return realKill(pid, signal)
  if (!alive.has(target)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  if (signal !== undefined && signal !== 0) alive.delete(target)
  return true
}) as typeof process.kill

const second = (pid: number): string => String(pid % 60).padStart(2, '0')
const instantOf = (pid: number): string => `2026-11-24T10:00:${second(pid)}.0000000Z`
const wordsOf = (pid: number): string => `Tuesday, November 24, 2026 10:00:${second(pid)} AM`
const anEarlierInstant = (pid: number): string => `2026-11-20T08:00:${second(pid)}.0000000Z`

type Launch = { exe: string; seam: 'execFile' | 'spawn' | 'spawnSync'; reads: string; pids: number[]; at: number }
const launches: Launch[] = []
const isPowerShell = (file: string): boolean => /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(file)
const exeOf = (file: string): string => file.replace(/^.*[\\/]/, '').toLowerCase()
function scriptOf(args: readonly string[]): string {
  const encoded = args.indexOf('-EncodedCommand')
  if (encoded >= 0) return Buffer.from(args[encoded + 1] ?? '', 'base64').toString('utf16le')
  return args.at(-1) ?? ''
}
function noted(seam: Launch['seam'], file: string, args: readonly string[]): { script: string; pids: number[]; together: boolean; words: boolean; both: boolean } {
  const script = scriptOf(args)
  const pids = [...script.matchAll(/ProcessId\s*=\s*(\d+)/g)].map(match => Number(match[1]))
  const together = script.includes('ConvertTo-Json')
  const both = together && script.includes('Out-String') && script.includes("ToString('o')")
  const words = together ? script.includes('Out-String') : !script.includes("ToString('o')")
  const reads = !script.includes('Win32_Process') ? (script.includes('ProtectedData') ? 'the credential store' : 'something else') : pids.length === 0 ? 'the process census' : `${together ? 'a batched start read' : 'a start read'} (${both ? 'both forms' : words ? 'the date words' : 'the instant form'})`
  launches.push({ exe: exeOf(file), seam, reads, pids, at: Date.now() })
  return { script, pids, together, words, both }
}
function startReadAnswer(read: { pids: number[]; together: boolean; words: boolean; both: boolean }): string {
  const here = read.pids.filter(pid => alive.has(pid) || pid === process.pid)
  const token = (pid: number): string => (read.words ? wordsOf(pid) : instantOf(pid))
  if (read.both) return JSON.stringify(here.map(pid => ({ token: wordsOf(pid), instant: instantOf(pid) })))
  if (read.together) return JSON.stringify(here.map(pid => ({ pid, token: token(pid) })))
  return here.length > 0 ? `${token(here[0]!)}\n` : ''
}
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
type Loose = (...all: unknown[]) => unknown
const real = { execFile: cp.execFile as Loose, spawn: cp.spawn as Loose, spawnSync: cp.spawnSync as Loose }
mock.module('node:child_process', () => ({
  ...cp,
  execFile: (file: string, args: string[], options: unknown, callback?: ExecFileCallback) => {
    if (!isPowerShell(file)) return real.execFile(file, args, options, callback)
    const read = noted('execFile', file, args)
    const done = typeof options === 'function' ? (options as ExecFileCallback) : callback
    setTimeout(() => done?.(null, startReadAnswer(read), read.both && scene === 'own-noisy' ? '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress"><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>' : ''), 5)
    return { kill: () => true }
  },
  spawnSync: (file: string, args: string[], options: unknown) => {
    if (!isPowerShell(file)) return real.spawnSync(file, args, options)
    const read = noted('spawnSync', file, args)
    return { status: 0, signal: null, stdout: startReadAnswer(read), stderr: '', pid: 0, output: [] }
  },
  spawn: (file: string, args: string[], options: unknown) => {
    if (!isPowerShell(file)) return real.spawn(file, args, options)
    noted('spawn', file, args)
    const child = Object.assign(new EventEmitter(), { pid: 0, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true })
    setTimeout(() => child.emit('error', new Error('this proof runs no PowerShell')), 5)
    return child
  },
}))

const wire = await import('../../src/daemon/runner-wire/peer.ts')
const { methodsFrom } = await import('../../src/daemon/runner-wire/methods.ts')
type Runner = { pid: number; short: string | null; lines: number }
const runners: Runner[] = []
const childModule = { ...(await import('../../src/daemon/runner-link/headlessRun.ts')) }
mock.module('../../src/daemon/runner-link/headlessRun.ts', () => ({
  ...childModule,
  spawnRunnerChild: (spec: { agentId?: string }) => {
    const pid = FIRST_RUNNER + runners.length
    alive.add(pid)
    const runner: Runner = { pid, short: spec.agentId ?? null, lines: 0 }
    runners.push(runner)
    const toRunner = new PassThrough()
    const toHost = new PassThrough()
    const peer = wire.createPeer({ input: toRunner, output: toHost, side: 'runner', log: () => {} })
    for (const spec of methodsFrom('host', 'request')) {
      peer.onRequest(spec.name as never, ((params: { session_id?: string }) => {
        if (spec.name === 'initialize') return { protocol: 1, runner: { version: '0.0.0-stand-in', pid }, session_id: null }
        if (spec.name === 'session/claim') return { session_id: String(params.session_id) }
        if (spec.name === 'queue/add') {
          runner.lines++
          return { accepted: true }
        }
        return {}
      }) as never)
    }
    const child = Object.assign(new EventEmitter(), { pid, stdin: toRunner, stdout: toHost, stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true })
    return { child, argv: [], env: {}, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }
  },
}))

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { TaskRoster } = await import('../../src/daemon/roster/roster.ts')
const warm = await import('../../src/daemon/runner-link/warmRunner.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')

class SceneEnd extends Error {}
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${scene}: ${label}${cond ? '' : ` — ${[detail, 'change: the admission holds the next warm runner until the admitted session’s first line is delivered (rewarmAfterFirstLine in src/daemon/concourse-workers/admitWarm.ts, called by admit.ts and reactivate.ts; the roster says when in TaskRoster.reply, src/daemon/roster/roster.ts), and after its patience for a session that gets no line'].filter(Boolean).join(' | ')}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const guard = setTimeout(() => {
  console.log(`\nTIMEOUT — ${scene}: the scene did not end within 60 s`)
  process.exit(1)
}, 60_000)
guard.unref?.()
const until = async (cond: () => boolean, withinMs: number): Promise<boolean> => {
  const stop = Date.now() + withinMs
  while (!cond() && Date.now() < stop) await sleep(10)
  return cond()
}
const told = (some: readonly Launch[]): string => (some.length === 0 ? 'none' : some.map(launch => `${launch.exe} by ${launch.seam}: ${launch.reads}${launch.pids.length > 0 ? ` of ${launch.pids.join(',')}` : ''}`).join(' · '))

if (scene === 'own' || scene === 'own-noisy') {
  console.log(`\n── ${scene}: a process asks for its own start in both forms, the date words for its locks and the instant for its records (the Windows seams: win32, every launch counted) ──`)
  const watch = await import('../../src/daemon/control/ownerWatch.ts')
  const hint = 'change: on Windows a process reads both forms of its own start in one launch and keeps them (startTokenOfAsync in src/daemon/control/ownerWatch.ts), so every later ask of its own pid, in either form, singly or in a batch, launches nothing'
  const own = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${scene}: ${label}${cond ? '' : ` — ${[detail, hint].filter(Boolean).join(' | ')}`}`)
  }
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const asWords = watch.getProcessStartTokenAsync(process.pid)
    const asInstant = watch.getProcessStartInstantAsync(process.pid)
    const [words, instant] = await Promise.all([asWords, asInstant])
    own('the date words are what a single read gives', words === wordsOf(process.pid), JSON.stringify(words))
    own('the instant is what a single read gives', instant === instantOf(process.pid), JSON.stringify(instant))
    own(scene === 'own-noisy' ? 'both forms came from one PowerShell, read by what it wrote on stdout whatever stood on stderr' : 'both forms came from one PowerShell', launches.length === 1, `${launches.length} launch(es): ${told(launches)}`)
    const atStart = launches.length
    const again = await Promise.all([watch.getProcessStartTokenAsync(process.pid), watch.getProcessStartInstantAsync(process.pid)])
    const batched = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: instantOf(process.pid) }])
    const forALock = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: wordsOf(process.pid) }])
    const cached = watch.getProcessStartInstantCachedOrRefresh(process.pid)
    await sleep(60)
    own('every later ask of its own pid is answered from that one read', again[0] === words && again[1] === instant && batched.get(process.pid) === instant && forALock.get(process.pid) === words && cached === instant, JSON.stringify({ again, batched: [...batched], forALock: [...forALock], cached }))
    own('and launches nothing', launches.length === atStart, `${launches.length - atStart} launch(es) more: ${told(launches.slice(atStart))}`)
  } finally {
    Object.defineProperty(process, 'platform', { value: HOST, configurable: true })
    rmSync(SCRATCH, { recursive: true, force: true })
  }
  process.exit(failures === 0 ? 0 : 1)
}

const dir = process.env.MERCURY_DAEMON_DIR!
const now = Date.now()
sup.updateConcourseWorkers(workers => {
  for (const [index, pid] of STRANGERS.entries()) {
    const runnerId = `concourse-w${index + 1}`
    const record: ConcourseWorkerRecordV1 = { schema: 1, runnerId, sessionId: `00000000-eeee-4000-8000-${String(index + 1).padStart(12, '0')}`, workspaceId: join(SCRATCH, `another-folder-${index + 1}`), isolation: 'exclusive', modelKey: 'claude-sonnet-5', spawnedAt: now - 86_400_000, lastLiveAt: now - 80_000_000, parkedAt: now - 80_000_000, parkedBy: 'operator', pid, procStart: anEarlierInstant(pid) }
    workers[runnerId] = record
  }
}, dir)

const roster = new TaskRoster({ dir: SCRATCH, breaker: new DaemonBreaker(), maxInflight: 4 })
const warmDeps = { roster: () => roster, dir }
const admit = sup.makeConcourseAdmitHandler({
  roster: () => roster,
  dir,
  claimWarm: args => warm.claimWarmRunner(args, warmDeps),
  ensureWarm: (workspaceDir, kit, bypassConsent) => {
    void warm.ensureWarmRunner({ workspaceDir, ...(kit !== undefined ? { kit } : {}), ...(bypassConsent === true ? { bypassConsent: true } : {}) }, warmDeps).catch(() => {})
  },
})

console.log(`\n── ${scene}: a home with six old session records whose pids went to other processes, a daemon up, ${scene === 'cold' ? 'no warm runner' : 'a warm runner standing'} (the Windows seams: win32, every launch counted) ──`)
try {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  if (scene === 'cold') {
    const before = launches.length
    const admitted = await admit({ by: 'operator', workspaceDir: WORK })
    const ofRunner = launches.slice(before).filter(launch => launch.pids.includes(FIRST_RUNNER))
    const record = admitted.ok ? sup.readSessionWorkers(dir)[admitted.runnerId] : undefined
    const cold = 'change: the admission of a session on a runner spawned for it keeps the start read the roster made at the spawn (registerLongLived hands it back; claimedPidFields in src/daemon/concourse-workers/marks.ts takes it, in src/daemon/concourse-workers/admit.ts) and reads again only when that read gave nothing'
    const told1 = (label: string, cond: boolean, detail = ''): void => {
      if (!cond) failures++
      console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${scene}: ${label}${cond ? '' : ` — ${[detail, cold].filter(Boolean).join(' | ')}`}`)
    }
    told1('the Enter is answered by a runner spawned for the session', admitted.ok === true && runners.length === 1, JSON.stringify(admitted).slice(0, 300))
    told1('that runner’s start is read once: one PowerShell for one fact', ofRunner.length === 1, `${ofRunner.length} launch(es): ${told(ofRunner)}`)
    told1('the session record names the pid and the start instant that read gave', record?.pid === FIRST_RUNNER && record.procStart === instantOf(FIRST_RUNNER), JSON.stringify({ pid: record?.pid, procStart: record?.procStart }))
    throw new SceneEnd()
  }
  const stood = await warm.ensureWarmRunner({ workspaceDir: WORK }, warmDeps)
  await until(() => roster.has(stood.short ?? '').ready, 5_000)
  await sleep(50)
  check('the warm runner stands and its runner answered', stood.state === 'warmed' && runners.length === 1 && roster.has(stood.short ?? '').ready, JSON.stringify({ stood, runners }))
  const before = launches.length
  const enterAt = Date.now()
  const admitted = await admit({ by: 'operator', workspaceDir: WORK })
  check('the Enter is answered by the standing warm runner', admitted.ok === true && admitted.runnerId === stood.short, JSON.stringify(admitted).slice(0, 300))
  if (scene === 'warm') {
    await sleep(120)
    check('no next warm runner is started before the session’s first line is delivered', runners.length === 1, `${runners.length - 1} runner(s) started ${runners.length > 1 ? 'at the admission' : ''}`)
    const delivered = admitted.ok ? await roster.reply(admitted.runnerId, { type: 'prompt', content: 'hi' }) : false
    const lineAt = Date.now()
    const road = launches.slice(before).filter(launch => launch.at <= lineAt)
    check('the first line is delivered to the session’s runner', delivered === true && runners[0]!.lines === 1, JSON.stringify({ delivered, runners }))
    check('no PowerShell is launched by the daemon between the Enter and the first delivered line', road.length === 0, `${road.length} launch(es) in ${lineAt - enterAt} ms: ${told(road)}`)
    check('the next warm runner is started once the line is delivered', await until(() => runners.length === 2, 2_000), `${runners.length - 1} runner(s) started within 2 s of the line`)
  } else {
    await sleep(1_500)
    check('a session that has no line yet has no next warm runner 1.5 s after its admission', runners.length === 1, `${runners.length - 1} runner(s) started`)
    check('a session that never gets a line still gets its next warm runner, by time', await until(() => runners.length === 2, 6_000), `${runners.length - 1} runner(s) started within 7.5 s of the admission`)
    const road = launches.slice(before)
    console.log(`  [note] ${scene}: launched after the Enter with no line sent: ${told(road)}`)
  }
} catch (error) {
  if (!(error instanceof SceneEnd)) throw error
} finally {
  Object.defineProperty(process, 'platform', { value: HOST, configurable: true })
  for (const entry of roster.list()) roster.kill(entry.short)
  rmSync(SCRATCH, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)

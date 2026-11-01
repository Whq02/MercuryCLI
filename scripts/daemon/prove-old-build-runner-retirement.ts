#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DIST, NODE, SCRATCH_ROOT, makeTally, sleep } from './dupline-world.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { SESSIONLESS_EXIT_GRACE_MS, SESSIONLESS_EXIT_BEAT_MS } from '../../src/daemon/sessionlessExit.ts'

if (process.platform === 'win32') {
  console.log('__SUITE_SKIPPED old-build-runner-retirement: simultaneous daemon handover uses POSIX sockets; Windows waits for live sessions to close')
  process.exit(0)
}

const tally = makeTally('prove-old-build-runner-retirement')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'old-build-runner-')))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
const daemonDir = join(home, 'daemon')
const runtime = join(home, 'runtime')
const oldTree = '1111111111111111111111111111111111111111'
const newTree = '2222222222222222222222222222222222222222'
const model = 'claude-sonnet-5'
const children: ChildProcess[] = []
const logs: string[] = []
const ownedRunners = new Set<number>()
let successorPid: number | undefined
let releaseFocus: (() => void) | undefined
let stopObserving: (() => void) | undefined

for (const path of [home, work, daemonDir, runtime]) mkdirSync(path, { recursive: true })
writeFileSync(join(work, 'fixture.txt'), 'runner retirement witness\n')
seedFirstRun(home, [work])
for (const key of ['MERCURY_HOME', 'MERCURY_CRITTER', 'MERCURY_CREW_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'NODE_ENV']) delete process.env[key]
Object.assign(process.env, {
  HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: join('..', 'home', 'daemon'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_PERMISSION_MODE: 'sovereign',
  MERCURY_DAEMON_NO_SELF_WARM: '1',
  MERCURY_TERMINAL_TITLE: '0',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  OPENAI_API_KEY: '',
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

function buildIdentity(name: string, tree: string): string {
  const dir = join(runtime, 'builds', name)
  mkdirSync(dir, { recursive: true })
  for (const file of ['mercury.mjs', 'shell-parent-guard.mjs']) copyFileSync(join(dirname(DIST), file), join(dir, file))
  symlinkSync(join(dirname(DIST), 'vendor'), join(dir, 'vendor'), 'dir')
  const manifest = JSON.parse(readFileSync(join(dirname(DIST), 'manifest.json'), 'utf8'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, buildTree: tree }))
  return join(dir, 'mercury.mjs')
}
function install(script: string): void {
  const next = join(runtime, 'next')
  symlinkSync(dirname(script), next, 'dir')
  renameSync(next, join(runtime, 'current'))
}
function alive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
async function until(test: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  do {
    if (await test()) return true
    await sleep(50)
  } while (Date.now() < end)
  return false
}
function requireThat(label: string, ok: boolean, detail = ''): asserts ok {
  tally.check(label, ok, detail)
  if (!ok) throw new Error(label)
}
function read<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return undefined }
}
type RecordView = { runnerId: string; sessionId: string; pid?: number; buildTree?: string; stoppedAt?: number; crash?: { reason: string; at: number } }
function record(sessionId: string): RecordView | undefined {
  const rows = read<{ workers: Record<string, RecordView> }>(join(daemonDir, 'concourse-workers.json'))
  return Object.values(rows?.workers ?? {}).find(row => row.sessionId === sessionId)
}
function remember(sessionId: string): number {
  const pid = record(sessionId)?.pid
  if (pid === undefined || pid <= 1 || !alive(pid)) throw new Error(`no live runner for ${sessionId}`)
  ownedRunners.add(pid)
  return pid
}
function commandOf(pid: number): string {
  return spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim() ?? ''
}

const oldScript = buildIdentity('before', oldTree)
const newScript = buildIdentity('after', newTree)
install(oldScript)
process.chdir(work)
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { focusDaemonSession } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { runnerStatusWords } = await import('../../src/components/SwitchboardTagBar.tsx')
const { decideHandover } = await import('../../src/daemon/handover.ts')
const hello = () => daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }, { timeoutMs: 1500 })
const admit = () => daemonControlRpc({ op: 'sessionAdmit', proto: MERCURY_DAEMON_PROTO, workspaceDir: work, isolation: 'shared', model, bypassConsent: true, by: 'operator', birthKey: randomUUID(), bornBlank: true }, { timeoutMs: 60_000 })

async function rememberRoster(): Promise<void> {
  const listed = await daemonControlRpc({ op: 'list', proto: MERCURY_DAEMON_PROTO }, { timeoutMs: 3000 })
  if (!listed.ok || listed.op !== 'list') return
  for (const job of listed.jobs) {
    if (job.pid === undefined || !alive(job.pid)) continue
    const command = commandOf(job.pid)
    if (command.includes(oldScript) || command.includes(newScript)) ownedRunners.add(job.pid)
  }
}
try {
  tally.section('Two installed identities of the candidate bundle; no historical OCR binary or download is simulated')
  const predecessor = spawn(NODE, [oldScript, 'daemon', 'run', work], { cwd: work, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(predecessor)
  predecessor.stdout?.on('data', chunk => logs.push(String(chunk)))
  predecessor.stderr?.on('data', chunk => logs.push(String(chunk)))
  requireThat('the old built daemon serves its own identity', await until(async () => {
    const answer = await hello()
    return answer.ok && answer.op === 'hello' && answer.pid === predecessor.pid && answer.buildTree === oldTree.slice(0, 12) && answer.ready
  }, 60_000), logs.join('').slice(-1200))
  const born = await admit()
  requireThat('a real session is admitted on the old build', born.ok && born.op === 'sessionAdmit', JSON.stringify(born))
  const sid = born.sessionId
  const firstPid = remember(sid)
  const connector = await focusDaemonSession({ sessionId: sid, runnerId: born.runnerId, title: 'retirement', projectLabel: basename(work), workspaceId: work, home: getProjectDir(work), modelKey: model })
  releaseFocus = releaseFocusedSessionConnector
  const shell = await connector.sendWords('printf old-runner-witness', { mode: 'bash' })
  requireThat('the old session accepts a local shell turn', ['accepted', 'delivered', 'queued'].includes(shell.state), JSON.stringify(shell))
  requireThat('the old session completes its local shell turn', await until(() => {
    const transcript = join(getProjectDir(work), `${sid}.jsonl`)
    return existsSync(transcript) && readFileSync(transcript, 'utf8').includes('<bash-exit-code>0</bash-exit-code>') && read<{ busy?: boolean }>(join(daemonDir, 'session-facts', `${sid}.json`))?.busy === false
  }, 60_000))
  await rememberRoster()

  tally.section('The installed pointer moves; the built restart command hands over without ending the old session')
  install(newScript)
  const movedAt = Date.now()
  const restart = spawnSync(NODE, [newScript, 'daemon', 'restart'], { cwd: work, env: process.env, encoding: 'utf8', timeout: 60_000 })
  requireThat('the built restart command succeeds', restart.status === 0, `${restart.stdout}\n${restart.stderr}`)
  requireThat('the new build takes the plane and names its predecessor', await until(async () => {
    const answer = await hello()
    if (!answer.ok || answer.op !== 'hello' || answer.pid === predecessor.pid || answer.buildTree !== newTree.slice(0, 12) || !answer.ready) return false
    successorPid = answer.pid
    return answer.predecessorPids?.includes(predecessor.pid!) === true
  }), `${restart.stdout}\n${restart.stderr}\n${logs.join('').slice(-1000)}`)
  tally.check('the held session still runs the exact old pid and bundle', record(sid)?.pid === firstPid && alive(firstPid) && commandOf(firstPid).includes(oldScript))
  const next = await admit()
  requireThat('a new session is admitted by the successor', next.ok && next.op === 'sessionAdmit', JSON.stringify(next))
  const nextPid = remember(next.sessionId)
  tally.check('new sessions run the new bundle, not the predecessor', commandOf(nextPid).includes(newScript) && record(next.sessionId)?.buildTree === newTree.slice(0, 12))
  await rememberRoster()
  const holdMs = SESSIONLESS_EXIT_GRACE_MS + SESSIONLESS_EXIT_BEAT_MS
  await sleep(Math.max(0, movedAt + holdMs - Date.now()))
  tally.check('an open old session is retained beyond the empty-daemon grace', alive(predecessor.pid) && alive(firstPid) && record(sid)?.pid === firstPid)
  console.log(`  old session retained for ${Date.now() - movedAt} ms after the pointer moved`)

  tally.section('An unexpected old-runner exit still reaches the focused chat through the successor')
  const seenWords: string[] = []
  const observe = (): void => {
    const state = connector.status().runner
    if (state !== null && state !== undefined) seenWords.push(runnerStatusWords(state, Date.now()))
  }
  const observeTimer = setInterval(observe, 20)
  stopObserving = () => clearInterval(observeTimer)
  for (let attempt = 0; attempt < 2; attempt++) {
    const pid = remember(sid)
    requireThat('only a runner from this proof is interrupted', commandOf(pid).includes(oldScript))
    process.kill(pid, 'SIGKILL')
    requireThat('the predecessor respawns its session after the injected death', await until(() => {
      const current = record(sid)
      return current?.pid !== undefined && current.pid !== pid && alive(current.pid) && current.crash !== undefined
    }))
    const respawn = remember(sid)
    tally.check('the respawn remains on the original build while that session is held', commandOf(respawn).includes(oldScript) && record(sid)?.buildTree === oldTree.slice(0, 12))
    requireThat('the respawn reports ready before the next operation', await until(() => {
      const facts = read<{ runner?: unknown; queueReady?: boolean; atMs: number }>(join(daemonDir, 'session-facts', `${sid}.json`))
      return facts !== undefined && facts.runner == null && facts.queueReady === true && facts.atMs > (record(sid)?.crash?.at ?? Infinity)
    }, 60_000))
  }
  requireThat('the focused screen receives the old runner crash words', await until(() => seenWords.some(words => words.startsWith('the runner crashed')), 5000), JSON.stringify(seenWords))
  tally.check('the crash is recorded for the old session, not its healthy successor sibling', record(sid)?.crash?.reason.includes('SIGKILL') === true && record(next.sessionId)?.crash === undefined && alive(nextPid))
  console.log(`  screen status: ${seenWords.find(words => words.startsWith('the runner crashed'))}`)
  stopObserving()
  stopObserving = undefined
  releaseFocus()
  releaseFocus = undefined

  tally.section('Closing the old session reaps its runner and then its predecessor, without ending the new session')
  const finalOldPid = remember(sid)
  const stoppedAt = Date.now()
  const stop = await daemonControlRpc({ op: 'sessionControl', proto: MERCURY_DAEMON_PROTO, action: 'stop', sessionId: sid, by: 'operator' }, { timeoutMs: 15_000 })
  requireThat('the successor forwards the stop to the old session', stop.ok && stop.op === 'sessionControl' && stop.outcome === 'applied', JSON.stringify(stop))
  requireThat('the old runner is observed gone and the stop is recorded', await until(() => !alive(finalOldPid) && record(sid)?.stoppedAt !== undefined, 20_000))
  requireThat('the superseded predecessor is reaped after its last session closes', await until(() => !alive(predecessor.pid), 20_000), logs.join('').slice(-1500))
  const oldLog = logs.join('')
  const successorLog = readFileSync(join(daemonDir, 'daemon.log'), 'utf8')
  const selfRetired = /armed restart — idle now|last session this daemon held has exited/.test(oldLog)
  const askedToLeave = successorLog.split('\n').some(line => line.includes(`(pid ${predecessor.pid},`) && line.includes('holds no live session and has not left on its own — asking it to leave')) && oldLog.includes('control:shutdown — shutting down')
  tally.check('an idle reaper, not another crash, ended the predecessor', (selfRetired || askedToLeave) && predecessor.exitCode === 0, oldLog.slice(-2000) + successorLog.slice(-2000))
  console.log(`  reaper: ${selfRetired ? 'predecessor idle beat' : 'successor idle-predecessor sweep'}`)
  tally.check('the new daemon and new runner remain alive', alive(successorPid) && alive(nextPid))
  console.log(`  old daemon reaped ${Date.now() - stoppedAt} ms after the session stop`)
  tally.check('Windows defers its single-pipe handover while a session is live', !decideHandover({ daemonBuildTree: oldTree, deployedBuildTree: newTree, healState: 'armed', live: 1, platform: 'win32' }).handover)
} catch (error) {
  tally.check('the retirement journey completed', false, String(error))
  console.log(logs.join('').slice(-2500))
} finally {
  stopObserving?.()
  releaseFocus?.()
  await rememberRoster().catch(() => {})
  try { await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 8000 }) } catch {}
  await until(() => !alive(successorPid) && children.every(child => !alive(child.pid)), 10_000)
  for (const child of children) if (alive(child.pid)) child.kill('SIGKILL')
  if (alive(successorPid) && commandOf(successorPid!).includes(newScript)) process.kill(successorPid!, 'SIGKILL')
  for (const pid of ownedRunners) if (alive(pid) && (commandOf(pid).includes(oldScript) || commandOf(pid).includes(newScript))) process.kill(pid, 'SIGKILL')
  tally.check('cleanup leaves no owned runner or daemon alive', await until(() => [...ownedRunners].every(pid => !alive(pid)) && !alive(successorPid) && children.every(child => !alive(child.pid)), 10_000))
  process.chdir(dirname(DIST))
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()

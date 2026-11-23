#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distBuildInputs } from '../lib/distProvenance.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_CONCOURSE_WORKER', 'MERCURY_WARM_RUNNER', 'MERCURY_DAEMON_NO_SELF_WARM', 'CI', 'NODE_ENV']) {
  delete process.env[key]
}
const ROOT = join(import.meta.dir, '..', '..')
const BIN = join(ROOT, 'dist', 'mercury.mjs')
const KEEP = process.argv.includes('--keep')
const built = existsSync(BIN) ? distBuildInputs(ROOT) : { stale: true, line: `${BIN} is absent` }
if (built.stale) {
  console.log(`prove-explicit-default-mode-reaches-runner: ${built.line}: run \`bun run build.ts\` in ${ROOT}, then run this proof again`)
  process.exit(1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'typed-default-mode-')))
const PROOF_ENV = {
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_DAP: '0',
  NO_COLOR: '1',
}

const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/control/protocol.ts')
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { readSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')

const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT: prove-explicit-default-mode-reaches-runner exceeded 300s; a daemon or a runner never answered: read the last section header above and the daemon lines under it')
  process.exit(1)
}, 300_000)
watchdog.unref?.()

const DOOR = 'the door reads the pair in readSessionAdmit (src/daemon/control/controlServer.ts); the seat spec keeps it in buildConcourseWorkerSpec (src/daemon/concourse-workers/spec.ts); headlessPermissionArgv (src/daemon/runner-link/headlessRun.ts) spells --mode default for it'
const HINTS = {
  birth: `a typed default must reach a cold seat's argv: ${DOOR}`,
  respawn: 'a respawn starts from the registered seat spec: permissionModeTyped must stay on the spec that buildConcourseWorkerSpec (src/daemon/concourse-workers/spec.ts) returns, and buildRunnerInvocation (src/daemon/runner-link/headlessRun.ts) must read it',
  revive: "a revive starts from the session record: stampSpawnPosture (src/daemon/concourse-workers/spec.ts) must stamp permissionModeTyped and reviveConcourseWorker (src/daemon/concourse-workers/revive.ts) must hand the record's word to the seat spec",
  reactivate: 'a resume of a session with a record goes through reactivateConcourseSession (src/daemon/concourse-workers/reactivate.ts): it must hand the carried pair to reviveConcourseWorker, and a carried mode nobody typed must clear the word',
  warm: 'a claimed warm seat respawns from the spec the claim patched: claimWarmRunner (src/daemon/runner-link/warmRunner.ts) must pass permissionModeTyped to patchSeatClaim (src/daemon/roster/retarget.ts)',
  asToday: 'only a mode typed for this start may change what a seat boots in: a carried default without permissionModeTyped, or nothing carried, must keep the saved mode (headlessPermissionModeTyped in src/daemon/runner-link/headlessRun.ts)',
}
let failures = 0
let hint = ''
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` (${[detail, hint].filter(Boolean).join('; ')})`}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  do {
    if (await cond()) return true
    await wait(150)
  } while (Date.now() < deadline)
  return cond()
}
const rpc = (request: object, timeoutMs = 15_000): Promise<Record<string, unknown>> => daemonControlRpc(request as never, { timeoutMs }) as Promise<Record<string, unknown>>
const pidAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type World = { work: string; daemonDir: string; log: () => string; end: () => Promise<void> }
type Mark = { atMs: number; generation: number; short: string }
const TYPED = { permissionMode: 'default', permissionModeTyped: true }

async function daemonUnder(name: string, saved: string, warm: boolean): Promise<World | null> {
  const home = join(SCRATCH, `home-${name}`)
  const work = join(SCRATCH, `work-${name}`)
  const daemonDir = join(home, 'daemon')
  mkdirSync(work, { recursive: true })
  seedFirstRun(home, [work])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { mode: saved } }))
  writeFileSync(join(work, 'README.md'), '# work\n')
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_DAEMON_DIR = daemonDir
  const env = { ...process.env, ...PROOF_ENV, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: daemonDir, MERCURY_DAEMON_PERSIST: '1', MERCURY_DAEMON_NO_SELF_WARM: '1', ...(warm ? {} : { MERCURY_WARM_RUNNER: '0' }) }
  let log = ''
  const daemon: ChildProcess = spawn('node', [BIN, 'daemon', 'run', work], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [daemon.stdout, daemon.stderr]) stream?.on('data', d => (log += String(d)))
  const exited = new Promise<void>(r => daemon.once('exit', () => r()))
  const end = async (): Promise<void> => {
    await rpc({ op: 'shutdown', reapWorkers: true }, 5_000).catch(() => undefined)
    const gone = await Promise.race([exited.then(() => true), wait(15_000).then(() => false)])
    if (!gone) daemon.kill('SIGKILL')
    delete process.env.MERCURY_DAEMON_DIR
  }
  const ready = await until(async () => {
    const hello = (await rpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null }).catch(() => ({ ok: false }))) as { ok?: boolean; ready?: boolean }
    return hello.ok === true && hello.ready === true
  }, 60_000)
  if (ready) return { work, daemonDir, log: () => log, end }
  failures++
  console.log(`  [FAIL] the built daemon under a saved '${saved}' answers hello (${log.slice(-400)}; build first with \`bun run build.ts\`, then read the daemon lines above)`)
  await end()
  return null
}

const recordOf = (world: World, sid: string) => Object.values(workers.readSessionWorkers(world.daemonDir)).find(r => r.sessionId === sid && r.endedAt === undefined)
const factsOf = (world: World, sid: string) => readSessionFacts(sid, world.daemonDir) as { permissionMode?: string; queueReady?: boolean; atMs?: number; runnerGeneration?: number } | null
const markOf = (world: World, sid: string): Mark => ({ atMs: Date.now(), generation: factsOf(world, sid)?.runnerGeneration ?? 0, short: recordOf(world, sid)?.runnerId ?? '' })

async function runnerWord(world: World, sid: string, since?: Mark): Promise<string> {
  const spoke = await until(async () => {
    await rpc({ op: 'sessionControl', action: 'session-facts', sessionId: sid, by: 'operator' }).catch(() => undefined)
    await wait(250)
    const facts = factsOf(world, sid)
    if (facts?.queueReady !== true) return false
    if (since === undefined) return true
    const sameSeat = recordOf(world, sid)?.runnerId === since.short
    return (facts.atMs ?? 0) > since.atMs && (!sameSeat || (facts.runnerGeneration ?? 0) > since.generation)
  }, 60_000)
  return spoke ? String(factsOf(world, sid)?.permissionMode) : `no runner answered (the facts last said ${JSON.stringify(factsOf(world, sid)?.permissionMode)}; daemon: ${world.log().split('\n').slice(-4).join(' | ').slice(-500)})`
}

async function admit(world: World, extra: Record<string, unknown>): Promise<string> {
  const reply = await rpc({ op: 'sessionAdmit', workspaceDir: world.work, isolation: 'shared', by: 'operator', ...(extra.resumeSessionId === undefined ? { birthKey: randomUUID(), bornBlank: true } : {}), ...extra }, 60_000)
  const sid = typeof reply.sessionId === 'string' ? reply.sessionId : ''
  if (reply.ok !== true || sid === '') {
    failures++
    console.log(`  [FAIL] the daemon admits ${JSON.stringify(extra)} (${JSON.stringify(reply).slice(0, 400)}; read makeConcourseAdmitHandler in src/daemon/concourse-workers/admit.ts)`)
    return ''
  }
  await until(() => recordOf(world, sid)?.pid !== undefined, 30_000)
  return sid
}

function seedTranscript(world: World, sid: string): void {
  const path = workers.concourseTranscriptPath({ sessionId: sid, workspaceId: workers.canonicalWorkspaceId(world.work) })
  mkdirSync(join(path, '..'), { recursive: true })
  const asked = randomUUID()
  const stamp = { cwd: world.work, sessionId: sid, timestamp: new Date().toISOString(), isSidechain: false, entrypoint: 'cli', version: '1.0.0' }
  const rows = [
    { type: 'user', uuid: asked, parentUuid: null, ...stamp, message: { role: 'user', content: 'Seed turn.' } },
    { type: 'assistant', uuid: randomUUID(), parentUuid: asked, ...stamp, message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Seed reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  writeFileSync(path, rows.map(row => (encodeTranscriptLine as (p: string, r: Record<string, unknown>) => { line: string })(path, row).line).join(''))
}

async function stopped(world: World, sid: string): Promise<Mark> {
  const pid = recordOf(world, sid)?.pid
  await rpc({ op: 'sessionControl', action: 'stop', sessionId: sid, by: 'operator' })
  await until(() => !pidAlive(pid), 30_000)
  await wait(300)
  return markOf(world, sid)
}

console.log('============================================================')
console.log(' a mode typed for this start reaches the runner: the built daemon, the built runner')
console.log('============================================================')

section("§1 saved 'flow', a launch that typed --mode default: every cold road boots the runner in default")
{
  const world = await daemonUnder('flow-cold', 'flow', false)
  if (world !== null) {
    try {
      hint = HINTS.birth
      const sid = await admit(world, TYPED)
      const born = recordOf(world, sid)
      check("the record stamps 'default' and that it was typed", born?.permissionMode === 'default' && born.permissionModeTyped === true, JSON.stringify({ permissionMode: born?.permissionMode, permissionModeTyped: born?.permissionModeTyped }))
      const atBirth = await runnerWord(world, sid)
      check(`the born runner's own word is 'default' (${atBirth})`, atBirth === 'default')

      hint = HINTS.respawn
      const beforeCrash = markOf(world, sid)
      const crashed = recordOf(world, sid)?.pid
      if (crashed !== undefined) process.kill(crashed, 'SIGKILL')
      const afterCrash = await runnerWord(world, sid, beforeCrash)
      check(`a crashed runner comes back in 'default' (${afterCrash})`, afterCrash === 'default')

      hint = HINTS.revive
      seedTranscript(world, sid)
      const beforeVerb = await stopped(world, sid)
      await rpc({ op: 'sessionControl', action: 'resume', sessionId: sid, by: 'operator' }, 30_000)
      const afterVerb = await runnerWord(world, sid, beforeVerb)
      check(`the resume verb revives a stopped session in 'default' (${afterVerb})`, afterVerb === 'default')

      hint = HINTS.reactivate
      const beforeResume = await stopped(world, sid)
      await admit(world, { resumeSessionId: sid, ...TYPED })
      const afterResume = await runnerWord(world, sid, beforeResume)
      check(`a resume from a launch that typed default revives it in 'default' (${afterResume})`, afterResume === 'default')
      const beforeMoved = await stopped(world, sid)
      await admit(world, { resumeSessionId: sid, permissionMode: 'flow' })
      const afterMoved = await runnerWord(world, sid, beforeMoved)
      const moved = recordOf(world, sid)
      check(`a resume that carries a mode nobody typed boots that mode and clears the typed word (${afterMoved})`, afterMoved === 'flow' && moved?.permissionMode === 'flow' && moved.permissionModeTyped === undefined, JSON.stringify({ permissionMode: moved?.permissionMode, permissionModeTyped: moved?.permissionModeTyped }))
      await stopped(world, sid)

      hint = HINTS.birth
      const recordless = randomUUID()
      seedTranscript(world, recordless)
      await admit(world, { resumeSessionId: recordless, ...TYPED })
      const afterRecordless = await runnerWord(world, recordless)
      check(`a resume of a session with no record boots in 'default' (${afterRecordless})`, afterRecordless === 'default')
      await stopped(world, recordless)

      hint = HINTS.asToday
      const untyped = await admit(world, { permissionMode: 'default' })
      const untypedWord = await runnerWord(world, untyped)
      check(`a carried default nobody typed keeps today's road: the saved mode applies (${untypedWord})`, untypedWord === 'flow' && recordOf(world, untyped)?.permissionModeTyped === undefined)
      const bare = await admit(world, {})
      const bareWord = await runnerWord(world, bare)
      check(`nothing carried keeps today's road: the saved mode applies (${bareWord})`, bareWord === 'flow')
    } finally {
      await world.end()
    }
  }
}

section("§2 saved 'flow', a launch that typed --mode default, the warm pool: the claimed seat stays in default after a respawn")
{
  const world = await daemonUnder('flow-warm', 'flow', true)
  if (world !== null) {
    try {
      hint = HINTS.warm
      const warmed = await rpc({ op: 'concourseWarm', workspaceDir: world.work })
      check('the pool warms a runner for the workspace', warmed.ok === true && warmed.state === 'warmed', JSON.stringify(warmed).slice(0, 300))
      await wait(1_000)
      const sid = await admit(world, TYPED)
      check('the admission claims the warm runner', await until(() => world.log().includes('warm claim acked'), 30_000), world.log().split('\n').filter(l => l.includes('warm')).slice(-4).join(' | ').slice(-500))
      const claimed = await runnerWord(world, sid)
      check(`the claimed runner's own word is 'default' (${claimed})`, claimed === 'default')
      const beforeCrash = markOf(world, sid)
      const crashed = recordOf(world, sid)?.pid
      if (crashed !== undefined) process.kill(crashed, 'SIGKILL')
      const afterCrash = await runnerWord(world, sid, beforeCrash)
      check(`the claimed seat's respawn comes back in 'default' (${afterCrash})`, afterCrash === 'default')
    } finally {
      await world.end()
    }
  }
}

section("§3 saved 'sovereign': a typed default boots default, and nothing carried still never arms the bypass")
{
  const world = await daemonUnder('sovereign', 'sovereign', false)
  if (world !== null) {
    try {
      hint = HINTS.birth
      const typed = await admit(world, TYPED)
      const typedWord = await runnerWord(world, typed)
      check(`a typed default boots 'default' (${typedWord})`, typedWord === 'default')
      hint = HINTS.asToday
      const bare = await admit(world, {})
      const bareWord = await runnerWord(world, bare)
      check(`nothing carried boots 'default', as today (${bareWord})`, bareWord === 'default')
    } finally {
      await world.end()
    }
  }
}

clearTimeout(watchdog)
if (KEEP) console.log(`\n[keep] ${SCRATCH}`)
else rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-explicit-default-mode-reaches-runner: ALL LAWS HOLD' : `\nprove-explicit-default-mode-reaches-runner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

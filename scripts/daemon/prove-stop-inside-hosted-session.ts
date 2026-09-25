#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUN, DIST, NODE, REPO, SCRATCH_ROOT, argAfter, childEnv, makeTally, removeWorld, sleep } from './dupline-world.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startScriptedFixture, type Script } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-stop-inside-hosted-session')
const ROOT = REPO
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')
const CLIENT = argAfter('--client') ?? 'source'
const REFUSAL = 'run it from a plain shell; from inside a hosted session your own turn would end'
const STOP_EXIT_MARK = 'STOP-EXIT='
const RESTART_EXIT_MARK = 'RESTART-EXIT='
const INTERRUPTED = 'Request interrupted by user'

tally.section('§1 the verdict: a caller under the daemon it is about to stop is a hosted caller')
{
  const mod = (await import('../../src/daemon/hostedCaller.ts').catch(() => null)) as null | Record<string, unknown>
  tally.check('src/daemon/hostedCaller.ts loads', mod !== null, 'the module is missing (red on the base by construction)')
  if (mod !== null) {
    const verdict = mod.hostedCallerVerdict as (pid: number | null | undefined, facts: { ancestors: readonly number[]; workerParentPid: number | null }) => { hosted: boolean; road?: string; daemonPid?: number }
    const of = mod.hostedCallerOf as (pid: number | null | undefined, opts?: { pid?: number; env?: NodeJS.ProcessEnv; ancestors?: (pid: number) => Promise<number[]> }) => Promise<{ hosted: boolean; road?: string }>
    const line = mod.hostedCallerRefusalLine as (verb: 'stop' | 'restart') => string
    const words = mod.HOSTED_CALLER_REFUSAL as string
    const walk = [4100, 4000, 777, 1]
    const byAncestry = verdict(777, { ancestors: walk, workerParentPid: null })
    tally.check('the daemon pid among the ancestors reads hosted (the tool shell scrubbed the stamp)', byAncestry.hosted && byAncestry.road === 'ancestry' && byAncestry.daemonPid === 777, JSON.stringify(byAncestry))
    const byStamp = verdict(777, { ancestors: [], workerParentPid: 777 })
    tally.check('the worker-parent stamp naming the daemon reads hosted', byStamp.hosted && byStamp.road === 'stamp', JSON.stringify(byStamp))
    tally.check('a caller whose tree never reaches the daemon is a plain shell', !verdict(777, { ancestors: [4100, 4000, 1], workerParentPid: null }).hosted)
    tally.check('a stamp naming ANOTHER daemon does not read hosted', !verdict(777, { ancestors: [4100, 4000, 1], workerParentPid: 778 }).hosted)
    tally.check('no daemon pid (no record) is never hosted', !verdict(null, { ancestors: walk, workerParentPid: 777 }).hosted && !verdict(undefined, { ancestors: walk, workerParentPid: null }).hosted)
    tally.check('pid 0 and pid 1 are never a daemon', !verdict(0, { ancestors: [0], workerParentPid: 0 }).hosted && !verdict(1, { ancestors: [1], workerParentPid: null }).hosted)
    const walked: number[] = []
    const live = await of(777, { pid: 4242, env: {}, ancestors: async pid => (walked.push(pid), walk) })
    tally.check('the live reading walks the caller pid it is given and judges by the walk', walked[0] === 4242 && live.hosted && live.road === 'ancestry', JSON.stringify({ walked, live }))
    const stamped = await of(777, { pid: 4242, env: { MERCURY_WORKER_PARENT_PID: '777' }, ancestors: async () => [] })
    tally.check('the live reading takes the stamp without walking', stamped.hosted && stamped.road === 'stamp', JSON.stringify(stamped))
    const plain = await of(777, { pid: 4242, env: {}, ancestors: async () => [4100, 1] })
    tally.check('the live reading of a plain shell is not hosted', !plain.hosted, JSON.stringify(plain))
    tally.check('the refusal is the one line', words === REFUSAL && line('stop') === `[daemon] stop refused — ${REFUSAL}` && line('restart') === `[daemon] restart refused — ${REFUSAL}`, `${words} · ${line('stop')}`)
  }
}

tally.section('§2 the verbs consult the verdict before anything that would end the caller')
{
  const main = read('src', 'daemon', 'main.ts')
  const stopAt = main.indexOf('async function daemonStopCmd(')
  const stopEnd = main.indexOf('async function daemonRestartCmd(', stopAt)
  const stop = stopAt !== -1 && stopEnd !== -1 ? main.slice(stopAt, stopEnd) : ''
  const guardAt = stop.indexOf('hostedCallerOf(')
  const rpcAt = stop.indexOf("op: 'shutdown'")
  tally.check('the stop verb asks whether it runs inside a session this daemon hosts', guardAt !== -1, 'no hostedCallerOf in daemonStopCmd (red on the base by construction)')
  tally.check('…BEFORE the shutdown RPC (the reap is the cut)', guardAt !== -1 && rpcAt !== -1 && guardAt < rpcAt)
  tally.check('…and refuses with the one line, exit 1', stop.includes("hostedCallerRefusalLine('stop')") && /hosting\.hosted\)\s*\{[\s\S]{0,200}process\.exitCode = 1[\s\S]{0,40}return/.test(stop))
  const restartAt = main.indexOf('async function daemonRestartCmd(')
  const restartEnd = main.indexOf('async function daemonRun(', restartAt)
  const restart = restartAt !== -1 && restartEnd !== -1 ? main.slice(restartAt, restartEnd) : ''
  tally.check('the restart verb reads the handshake first and asks the same question', restart.includes('handshakeDaemon()') && restart.includes('hostedCallerOf('))
  tally.check("…refusing the stop-and-start road (a pre-handshake daemon) and a daemon that counts nothing live — the two roads that would end this turn", /hosting\.hosted && first\.daemon !== null && \(first\.heal === 'operator' \|\| first\.live === 0\)/.test(restart) && restart.includes("hostedCallerRefusalLine('restart')"))
  tally.check('…and lets the armed road through, saying this session is one of the live ones', restart.includes("receipt.state === 'armed'") && restart.includes('this hosted session is one of them; your turn goes on'))
  const teardown = main.slice(main.indexOf('const shutdown = (signal: string) => {'), main.indexOf('const bail = setTimeout(() => process.exit(1), 15_000)'))
  tally.check('the seam stands as read: the teardown reaps every rostered worker (why the refusal is client-side, and why no flag can keep one)', teardown.includes('for (const j of roster.list())') && teardown.includes('roster.kill(j.short)'))
  const { DAEMON_USAGE, parseDaemonVerb } = await import('../../src/daemon/verbs.ts')
  const stopRow = DAEMON_USAGE.split('\n').find(l => l.trimStart().startsWith('stop')) ?? ''
  const promisesSurvival = (text: string): boolean => /leaves? (in-flight )?(them|workers) running|workers? (survive|stay alive|keep running|live on)|skips that reap/i.test(text)
  tally.check('the usage carries no --keep: the flag is retired, not explained', !DAEMON_USAGE.includes('--keep') && !DAEMON_USAGE.includes('--any'), stopRow)
  tally.check('the stop row of the usage names the reap and promises no survival', /reap/.test(stopRow) && !promisesSurvival(stopRow), stopRow)
  const keep = parseDaemonVerb(['stop', '--keep'], () => false) as { kind: string; word?: string }
  tally.check("`stop --keep` is refused by the grammar, typed, naming the flag", keep.kind === 'unknown-flag' && keep.word === '--keep', `accepted as ${JSON.stringify(keep)}`)
  tally.check('the stop verb reads no --keep and asks for the reap by name', !stop.includes('--keep') && stop.includes("{ op: 'shutdown', reapWorkers: true }"), stop.split('\n').filter(l => /--keep|reapWorkers/.test(l)).join(' | '))
}

tally.section('§3 LIVE — a session this daemon hosts runs the stop from its own Bash')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist <bundle>`)
  tally.finish()
}
if (process.platform === 'win32') {
  console.log('  [SKIP] the live leg drives a POSIX process tree')
  tally.finish()
}
console.log(`  bundle under proof: ${DIST} · client road: ${CLIENT}`)
const world = mkdtempSync(join(SCRATCH_ROOT, 'stop-inside-hosted-'))
const runHome = join(world, 'home')
const daemonDir = join(runHome, 'daemon')
const workA = join(world, 'work-stop')
const workB = join(world, 'work-restart')
for (const d of [runHome, daemonDir, workA, workB]) mkdirSync(d, { recursive: true })
for (const d of [workA, workB]) writeFileSync(join(d, 'README.md'), '# fixture\n')
seedFirstRun(runHome, [workA, workB])
process.env.MERCURY_CONFIG_DIR = runHome
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const STOP_ASK = 'stop the daemon from in here'
const RESTART_ASK = 'restart the daemon from in here'
const clientCommand = (verb: string): string =>
  CLIENT === 'bundle'
    ? `"${NODE}" "${DIST}" daemon ${verb}`
    : `"${BUN}" run "${join(ROOT, 'scripts', 'daemon', 'hosted-caller-client.ts')}" ${verb}`
const stopCommand = `${clientCommand('stop')} 2>&1; echo "${STOP_EXIT_MARK}$?"`
const restartCommand = `${clientCommand('restart')} 2>&1; echo "${RESTART_EXIT_MARK}$?"`
const script: Script = req => {
  if (req.step === 0 && req.ask.includes(STOP_ASK)) return [{ type: 'tool_use', name: 'Bash', input: { command: stopCommand, description: 'stop the daemon from inside its own session' } }]
  if (req.step === 0 && req.ask.includes(RESTART_ASK)) return [{ type: 'tool_use', name: 'Bash', input: { command: restartCommand, description: 'restart the daemon from inside its own session' } }]
  const last = req.results[req.results.length - 1]
  return [{ type: 'text', text: last === undefined ? 'nothing to do' : `the turn went on after: ${last.text.slice(0, 400)}` }]
}
const fixture = await startScriptedFixture(script)
const port = Number(new URL(fixture.base).port)
const daemonEnv: NodeJS.ProcessEnv = { ...childEnv(runHome, port), ANTHROPIC_API_KEY: FIXTURE_API_KEY, MERCURY_CACHE_CLOCK: '0', MERCURY_PARTY: '0' }
delete daemonEnv.MERCURY_WORKER_PARENT_PID
delete daemonEnv.MERCURY_DAEMON_OWNER_PID
delete daemonEnv.MERCURY_DAEMON_OWNER_FD
delete daemonEnv.MERCURY_CONCOURSE_WORKER
delete daemonEnv.MERCURY_DAEMON_SUCCESSOR_OF
const daemonLogPath = join(world, 'daemon.log')
const logFd = openSync(daemonLogPath, 'a')
const daemon = spawn(NODE, [DIST, 'daemon', 'run', workA], { cwd: workA, env: daemonEnv, stdio: ['ignore', logFd, logFd] })
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(100)
  }
  return false
}
type Rec = { runnerId: string; sessionId: string; pid?: number; stoppedAt?: number; crash?: unknown; turnCutAt?: number; endedAt?: number; lastDeliveryAt?: number; lastTurnSettledAt?: number }
const recordsFile = join(daemonDir, 'concourse-workers.json')
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(recordsFile, 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid)
  } catch {
    return undefined
  }
}
const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const supervisorPid = async (): Promise<number | null> => {
  try {
    return (JSON.parse(readFileSync(join(daemonDir, 'supervisor.json'), 'utf8')) as { pid?: number }).pid ?? null
  } catch {
    return null
  }
}
const ping = async (): Promise<boolean> => (await daemonControlRpc({ op: 'ping' })).ok
const hello = async (): Promise<{ pid?: number; live?: number; restartArmed?: boolean } | null> => {
  const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
  const reply = (await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null } as never, { timeoutMs: 1500, protoRetry: false })) as { ok?: boolean; pid?: number; live?: number; restartArmed?: boolean }
  return reply.ok === true ? reply : null
}
const transcriptOf = (work: string, sid: string): string => join(paths.getProjectDir(work), `${sid}.jsonl`)
const transcriptText = (work: string, sid: string): string => {
  const p = transcriptOf(work, sid)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const dispatch = async (id: string, prompt: string, work: string): Promise<{ sid: string; rec: Rec | undefined }> => {
  const reply = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: id, prompt, workspaceDir: work, title: id, model: 'claude-opus-5', effort: 'high', permissionMode: 'sovereign' } as never)) as { ok?: boolean; sessionId?: string; error?: string }
  tally.check(`${id}: the session dispatched onto a runner`, reply.ok === true && typeof reply.sessionId === 'string', JSON.stringify(reply))
  const sid = reply.sessionId ?? ''
  await until(() => readRec(sid)?.pid !== undefined, 30_000)
  return { sid, rec: readRec(sid) }
}
const resultTextsOf = (mark: string): string[] => fixture.requests.flatMap(r => r.results.map(x => x.text)).filter(t => t.includes(mark))
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
  } catch {
  }
  await until(async () => !alive(daemon.pid), 8_000)
  try {
    daemon.kill('SIGTERM')
  } catch {
  }
  const successor = await supervisorPid()
  if (successor !== null && successor !== daemon.pid && alive(successor)) {
    console.log(`  [cleanup] a successor daemon (pid ${successor}) came up in the scratch home — ending it`)
    try {
      process.kill(successor, 'SIGTERM')
    } catch {
    }
    await until(() => !alive(successor), 8_000)
  }
  await fixture.close()
  if (tally.failed() === 0) await removeWorld(world)
  else console.log(`  [forensics] world kept: ${world} (daemon.log beside it)`)
}

try {
  tally.check('the scratch-home daemon serves', await until(ping, 60_000), daemonLog().slice(-600))
  const bootPid = await supervisorPid()
  tally.check('the supervisor record names the daemon the proof booted', bootPid === daemon.pid, `record ${bootPid} · spawned ${daemon.pid}`)

  console.log('\n  the stop: `mercury daemon stop` from the Bash of a session this daemon hosts')
  const a = await dispatch('stop-inside', STOP_ASK, workA)
  const pidA = a.rec?.pid
  tally.check('the runner is live', a.rec !== undefined && alive(pidA), JSON.stringify(a.rec))
  tally.check('the runner opened its turn and was told to run the stop', await until(() => fixture.requests.some(r => r.step === 0 && r.ask.includes(STOP_ASK)), 60_000), JSON.stringify(fixture.requests.map(r => [r.n, r.step, r.ask.slice(0, 40)])))
  const answered = await until(() => resultTextsOf(STOP_EXIT_MARK).length > 0 || !alive(pidA) || !alive(daemon.pid), 120_000)
  const stopResult = resultTextsOf(STOP_EXIT_MARK)[0] ?? ''
  const stopExit = /STOP-EXIT=(\d+)/.exec(stopResult)?.[1]
  console.log(`  the stop's tool result as the model saw it: ${JSON.stringify(stopResult.slice(0, 400))}`)
  tally.check('the stop came back to the model as a tool result — the turn went on (red on the base: the runner was cut before any result)', answered && stopResult !== '', `runner alive=${alive(pidA)} · daemon alive=${alive(daemon.pid)} · daemon.log tail: ${daemonLog().slice(-500)}`)
  tally.check('the result carries the one refusal line', stopResult.includes(REFUSAL), stopResult.slice(0, 300))
  tally.check('the stop exited 1 (refused), nothing acknowledged', stopExit === '1' && !stopResult.includes('shutdown acknowledged'), `exit ${stopExit}`)
  tally.check('the daemon still serves, the same process', (await ping()) && alive(daemon.pid) && (await supervisorPid()) === daemon.pid, `daemon alive=${alive(daemon.pid)} · record ${await supervisorPid()}`)
  tally.check('the daemon never began a shutdown', !/control:shutdown|shutting down/.test(daemonLog()), daemonLog().split('\n').filter(l => /shut/.test(l)).join(' | '))
  tally.check("the runner lives on — nothing signalled its tree", alive(pidA), `pid ${pidA} alive=${alive(pidA)}`)
  tally.check('the turn settled: the model spoke after the tool result and the seat reads idle', await until(() => fixture.requests.some(r => r.step === 1 && r.ask.includes(STOP_ASK)) && readFacts(a.sid)?.busy === false, 60_000), JSON.stringify({ steps: fixture.requests.map(r => r.step), facts: readFacts(a.sid) }))
  const transcriptA = transcriptText(workA, a.sid)
  tally.check('its transcript carries no interruption row (red on the base: "[Request interrupted by user for tool use]")', transcriptA !== '' && !transcriptA.includes(INTERRUPTED), transcriptA === '' ? 'no transcript' : transcriptA.split('\n').filter(l => l.includes(INTERRUPTED)).join(' | ').slice(0, 300))
  const recA = readRec(a.sid)
  tally.check('its record carries no stop, cut or crash stamp', recA !== undefined && recA.stoppedAt === undefined && recA.turnCutAt === undefined && recA.crash === undefined && recA.endedAt === undefined, JSON.stringify(recA))

  console.log('\n  the restart: `mercury daemon restart` from the Bash of a session this daemon hosts arms, and the turn goes on')
  const b = await dispatch('restart-inside', RESTART_ASK, workB)
  const pidB = b.rec?.pid
  tally.check('the second runner is live', b.rec !== undefined && alive(pidB), JSON.stringify(b.rec))
  const restartAnswered = await until(() => resultTextsOf(RESTART_EXIT_MARK).length > 0 || !alive(pidB) || !alive(daemon.pid), 120_000)
  const restartResult = resultTextsOf(RESTART_EXIT_MARK)[0] ?? ''
  const restartExit = /RESTART-EXIT=(\d+)/.exec(restartResult)?.[1]
  console.log(`  the restart's tool result as the model saw it: ${JSON.stringify(restartResult.slice(0, 400))}`)
  tally.check('the restart came back as a tool result — the turn went on', restartAnswered && restartResult !== '', `runner alive=${alive(pidB)} · daemon alive=${alive(daemon.pid)}`)
  tally.check('the daemon armed the restart for when its live sessions finish (nothing ends now)', /restart armed/.test(restartResult) && restartExit === '0', restartResult.slice(0, 300))
  tally.check('…and the receipt says this session is one of them', restartResult.includes('this hosted session is one of them; your turn goes on'), restartResult.slice(0, 300))
  const facts = await hello()
  tally.check('the daemon reads armed with both sessions live, the same process', facts !== null && facts.restartArmed === true && (facts.live ?? 0) >= 2 && facts.pid === daemon.pid, JSON.stringify(facts))
  tally.check('both runners live on', alive(pidA) && alive(pidB), `a=${alive(pidA)} b=${alive(pidB)}`)
  tally.check('the restart turn settled with no interruption row', await until(() => readFacts(b.sid)?.busy === false, 60_000) && !transcriptText(workB, b.sid).includes(INTERRUPTED), JSON.stringify(readFacts(b.sid)))
} finally {
  await cleanup()
}
tally.finish()

#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootRunner, bound, childEnv, DIST, exportWorld, isOutcome, isSession, j, makeTally, removeWorld, SCRATCH_ROOT, seedHome, sleep, type Runner } from '../daemon/dupline-world.ts'
import { PeerDeadline } from '../../src/runner/wire/peer.ts'
import { LEAD_ASK_HELD, LEAD_ASK_SLEEPER, SEAT_NAME, SEAT_SLEEP_SECONDS, startCrewStopFixture, type Fixture } from './crew-stop-fixture.ts'

const { check, section, finish, failed } = makeTally('prove-operator-line-before-a-finished-turn')
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length)
const runs = (scene: string): boolean => ONLY === undefined || ONLY.split(',').includes(scene)

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const SID = 'c0ffee00-0000-4000-8000-0000000b4f17'
const OLD_REFUSAL = 'the session has not run a turn'
const RUNNING_LINE = 'crew-seat: take the short road'
const STOPPED_LINE = 'crew-seat: carry on from where the stop left you'
const SLOW_LINE = 'crew-seat: this line arrives while the servers start'
const HOST_WAIT_MS = 2_000
const SERVER_WAIT_MS = 6_000
const SERVER_SLEEP_SECONDS = 6113

type Row = { id: string; kind: string; name: string; status: string }
type Answer = { subtype: 'success'; response: Record<string, unknown> } | { subtype: 'error'; error: string }
type World = { name: string; home: string; cwd: string; env: NodeJS.ProcessEnv; fx: Fixture; runner: Runner; failedAtOpen: number }

async function openWorld(name: string, extraArgv: string[]): Promise<World> {
  const failedAtOpen = failed()
  const home = join(SCRATCH_ROOT, `mercury-operator-line-${name}-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  const fx = await startCrewStopFixture({ seatTool: 'bash' })
  const env = childEnv(home, fx.port)
  delete env.MERCURY_DAEMON_PERMISSION_MODE
  delete env.MERCURY_SKIP_PERMISSIONS
  const runner = bootRunner({ cwd, env, extraArgv })
  return { name, home, cwd, env, fx, runner, failedAtOpen }
}

async function closeWorld(w: World): Promise<void> {
  await w.runner.stop(bound(8_000))
  await w.fx.close()
  exportWorld(w.name, w.home, {
    'frames.jsonl': w.runner.frames.map(l => JSON.stringify(l)).join('\n') + '\n',
    'stderr.txt': w.runner.stderr(),
    'hits.json': JSON.stringify(w.fx.hits, null, 2),
  })
  if (failed() === w.failedAtOpen) await removeWorld(w.home)
  else console.log(`  [forensics] ${w.name} world kept: ${w.home}\n${w.runner.stderr().split('\n').slice(-12).join('\n')}`)
}

const ask = (runner: Runner, method: 'agent/stop' | 'agent/resume', params: Record<string, unknown>, timeoutMs: number): Promise<Answer | null> =>
  runner.request(method, params as never, timeoutMs).then(
    response => ({ subtype: 'success', response }) as Answer,
    (error: unknown) => (error instanceof PeerDeadline ? null : ({ subtype: 'error', error: error instanceof Error ? error.message : String(error) } as Answer)),
  )

async function rowsOf(runner: Runner): Promise<Row[]> {
  const answer = await runner.request('session/facts', {}, bound(15_000)).catch(() => ({}) as Record<string, unknown>)
  return Array.isArray(answer.work) ? (answer.work as Row[]) : []
}

async function waitRow(runner: Runner, label: string, test: (r: Row) => boolean, timeoutMs: number): Promise<Row | null> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const rows = await rowsOf(runner)
    const hit = rows.find(test)
    if (hit !== undefined) return hit
    if (Date.now() >= until) {
      console.log(`  [wait] ${label}: no such row within ${timeoutMs} ms — rows ${j(rows.map(r => `${r.kind}:${r.name}:${r.status}`))}`)
      return null
    }
    await sleep(300)
  }
}

const sleepPids = (): string[] =>
  (spawnSync('pgrep', ['-f', `sleep ${SEAT_SLEEP_SECONDS}`], { encoding: 'utf8' }).stdout ?? '').split('\n').map(s => s.trim()).filter(s => s !== '')

async function waitSleepChildren(present: boolean, known: readonly string[], timeoutMs: number): Promise<string[]> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const mine = sleepPids().filter(pid => !known.includes(pid))
    if ((mine.length > 0) === present || Date.now() >= until) return mine
    await sleep(250)
  }
}

const seatAsks = (fx: Fixture, words: string): number => fx.hits.filter(h => (h.route === 'seat' || h.route === 'seat-ack') && h.ask.includes(words)).length

if (!existsSync(DIST)) {
  check('the built bundle is present', false, DIST)
} else {
  console.log(`bundle: ${DIST}`)

  if (runs('running')) {
    section('A a line to a crewmate that runs inside the session\'s first turn is queued for it (no turn has ended in this process)')
    const w = await openWorld('running', [])
    const stale = sleepPids()
    void w.runner.prompt(LEAD_ASK_HELD, U1)
    const init = await w.runner.waitFor('the session row', isSession, bound(90_000))
    check('A the runner is up', init !== null, w.runner.stderr().split('\n').slice(-5).join(' | '))
    const row = await waitRow(w.runner, 'the crewmate\'s row', r => r.kind === 'agent' && r.name === SEAT_NAME && r.status === 'running', bound(60_000))
    check('A the crewmate runs and the first turn has not ended', row !== null && !w.runner.frames.some(isOutcome), j(w.fx.hits.map(h => h.route)))
    if (row !== null) {
      const reply = await ask(w.runner, 'agent/resume', { agent_id: row.id, note: RUNNING_LINE }, bound(15_000))
      check('A the line is queued for the running crewmate', reply?.subtype === 'success' && reply.response.queued === true && reply.response.agent_id === row.id, j(reply))
      check('A the runner does not answer that the session has not run a turn', !(reply?.subtype === 'error' && reply.error.includes(OLD_REFUSAL)), j(reply))
      const child = await waitSleepChildren(true, stale, bound(30_000))
      const stopped = await ask(w.runner, 'agent/stop', { agent_id: row.id }, bound(15_000))
      check('A the crewmate stops on the operator\'s word', stopped?.subtype === 'success', j(stopped))
      const gone = await waitSleepChildren(false, stale, bound(10_000))
      check('A its shell child is gone', child.length > 0 && gone.length === 0, j({ child, gone }))
      const outcome = await w.runner.waitFor('the first turn\'s outcome', isOutcome, bound(60_000))
      check('A the first turn settles after the stop', outcome !== null, j(w.fx.hits.map(h => h.route)))
    }
    await closeWorld(w)
  }

  if (runs('reopened')) {
    section('B a line to a stopped crewmate of a session reopened and not yet prompted resumes it with the operator\'s words')
    const first = await openWorld('reopened', ['--session-id', SID])
    const stale = sleepPids()
    void first.runner.prompt(LEAD_ASK_SLEEPER, U2)
    const row = await waitRow(first.runner, 'the crewmate\'s row', r => r.kind === 'agent' && r.name === SEAT_NAME && r.status === 'running', bound(90_000))
    check('B the first process launched the crewmate', row !== null, j(first.fx.hits.map(h => h.route)))
    await waitSleepChildren(true, stale, bound(30_000))
    const stopped = row === null ? null : await ask(first.runner, 'agent/stop', { agent_id: row.id }, bound(15_000))
    check('B the crewmate is stopped in the first process', stopped?.subtype === 'success', j(stopped))
    await waitSleepChildren(false, stale, bound(10_000))
    await first.runner.waitFor('the first process\'s turn', isOutcome, bound(60_000))
    await first.runner.stop(bound(8_000))
    const before = seatAsks(first.fx, STOPPED_LINE)
    const second = bootRunner({ cwd: first.cwd, env: first.env, extraArgv: ['--resume', SID] })
    const up = await second.request('session/facts', {}, bound(90_000)).then(() => true, () => false)
    check('B the session is reopened in a second process and no turn has run in it', up && !second.frames.some(isOutcome), second.stderr().split('\n').slice(-5).join(' | '))
    if (row !== null && up) {
      const reply = await ask(second, 'agent/resume', { agent_id: row.id, note: STOPPED_LINE }, bound(30_000))
      check('B the runner takes the line and resumes the crewmate', reply?.subtype === 'success' && typeof reply.response.agent_id === 'string', j(reply))
      check('B the runner does not answer that the session has not run a turn', !(reply?.subtype === 'error' && reply.error.includes(OLD_REFUSAL)), j(reply))
      const until = Date.now() + bound(60_000)
      while (seatAsks(first.fx, STOPPED_LINE) === before && Date.now() < until) await sleep(300)
      check('B the resumed crewmate asks its model with the operator\'s words', seatAsks(first.fx, STOPPED_LINE) > before, j(first.fx.hits.map(h => `${h.route}:${h.ask.trim().slice(0, 90)}`)))
      const resumedId = reply?.subtype === 'success' && typeof reply.response.agent_id === 'string' ? reply.response.agent_id : row.id
      const settled = await waitRow(second, 'the resumed crewmate\'s settled row', r => r.id === resumedId && r.status !== 'running', bound(60_000))
      check('B the resumed crewmate\'s turn ends as its model answered (the line was a turn of its own, not a refusal)', settled !== null && settled.status === 'completed', j(settled))
      const gone = await waitSleepChildren(false, stale, bound(10_000))
      check('B no shell child of the scene is left', gone.length === 0, j(gone))
    }
    await second.stop(bound(8_000))
    await first.fx.close()
    exportWorld('reopened', first.home, {
      'frames-first.jsonl': first.runner.frames.map(l => JSON.stringify(l)).join('\n') + '\n',
      'frames-second.jsonl': second.frames.map(l => JSON.stringify(l)).join('\n') + '\n',
      'stderr-second.txt': second.stderr(),
      'hits.json': JSON.stringify(first.fx.hits, null, 2),
    })
    if (failed() === first.failedAtOpen) await removeWorld(first.home)
    else console.log(`  [forensics] reopened world kept: ${first.home}\n${second.stderr().split('\n').slice(-12).join('\n')}`)
  }

  if (runs('starting')) {
    section('C a line the host has stopped waiting for is not handed to the crewmate behind its back (the session\'s servers are still starting)')
    const first = await openWorld('starting', ['--session-id', SID])
    const stale = sleepPids()
    void first.runner.prompt(LEAD_ASK_SLEEPER, U2)
    const row = await waitRow(first.runner, 'the crewmate\'s row', r => r.kind === 'agent' && r.name === SEAT_NAME && r.status === 'running', bound(90_000))
    check('C the first process launched the crewmate', row !== null, j(first.fx.hits.map(h => h.route)))
    await waitSleepChildren(true, stale, bound(30_000))
    const stopped = row === null ? null : await ask(first.runner, 'agent/stop', { agent_id: row.id }, bound(15_000))
    check('C the crewmate is stopped in the first process', stopped?.subtype === 'success', j(stopped))
    await waitSleepChildren(false, stale, bound(10_000))
    await first.runner.waitFor('the first process\'s turn', isOutcome, bound(60_000))
    await first.runner.stop(bound(8_000))
    const settings = join(first.home, '.mercury.json')
    const config = existsSync(settings) ? (JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>) : {}
    config.mcpServers = { 'never-answers': { command: '/bin/sleep', args: [String(SERVER_SLEEP_SECONDS)] } }
    writeFileSync(settings, JSON.stringify(config))
    const second = bootRunner({ cwd: first.cwd, env: { ...first.env, MERCURY_CONCOURSE_WORKER: '1', MERCURY_MCP_TIMEOUT_MS: String(SERVER_WAIT_MS) }, extraArgv: [] })
    const claimed = await second.request('session/claim', { session_id: SID, resume: true } as never, bound(60_000)).then(() => true, () => false)
    check('C a runner that waits for its session is handed it with resume, one of its servers never answering', claimed, second.stderr().split('\n').slice(-5).join(' | '))
    if (row !== null && claimed) {
      const before = seatAsks(first.fx, SLOW_LINE)
      const sentAt = Date.now()
      let reply = await ask(second, 'agent/resume', { agent_id: row.id, note: SLOW_LINE }, HOST_WAIT_MS)
      while (reply?.subtype === 'error' && reply.error.includes('still starting') && Date.now() - sentAt < 20_000) {
        await sleep(250)
        reply = await ask(second, 'agent/resume', { agent_id: row.id, note: SLOW_LINE }, HOST_WAIT_MS)
      }
      check('C the host stops waiting for the line before the session\'s servers have settled', reply === null, j(reply))
      const gaveUpAt = Date.now()
      while (Date.now() - gaveUpAt < SERVER_WAIT_MS + 5_000 && seatAsks(first.fx, SLOW_LINE) === before) await sleep(300)
      check('C the crewmate\'s model is never asked with the line the host gave up on', seatAsks(first.fx, SLOW_LINE) === before, j(first.fx.hits.map(h => `${h.route}:${h.ask.trim().slice(0, 70)}`)))
      const rows = await rowsOf(second)
      check('C …and no crewmate was started for it', !rows.some(r => r.kind === 'agent' && r.status === 'running'), j(rows.map(r => `${r.kind}:${r.name}:${r.status}`)))
      const again = await ask(second, 'agent/resume', { agent_id: row.id, note: SLOW_LINE }, bound(30_000))
      check('C the same line sent again once the servers have settled is taken', again?.subtype === 'success' && typeof again.response.agent_id === 'string', j(again))
      const until = Date.now() + bound(60_000)
      while (seatAsks(first.fx, SLOW_LINE) === before && Date.now() < until) await sleep(300)
      const resumedId = again?.subtype === 'success' && typeof again.response.agent_id === 'string' ? again.response.agent_id : row.id
      const settled = await waitRow(second, 'the resumed crewmate\'s settled row', r => r.id === resumedId && r.status !== 'running', bound(60_000))
      check('C …and the crewmate asks its model with it once and its turn ends as its model answered', seatAsks(first.fx, SLOW_LINE) === before + 1 && settled !== null && settled.status === 'completed', j({ asks: seatAsks(first.fx, SLOW_LINE) - before, settled }))
    }
    await second.stop(bound(8_000))
    await sleep(500)
    const servers = (spawnSync('pgrep', ['-f', `sleep ${SERVER_SLEEP_SECONDS}`], { encoding: 'utf8' }).stdout ?? '').split('\n').map(s => s.trim()).filter(s => s !== '')
    check('C no server process and no shell child of the scene is left', servers.length === 0 && (await waitSleepChildren(false, stale, bound(10_000))).length === 0, j(servers))
    await first.fx.close()
    exportWorld('starting', first.home, {
      'frames-second.jsonl': second.frames.map(l => JSON.stringify(l)).join('\n') + '\n',
      'stderr-second.txt': second.stderr(),
      'hits.json': JSON.stringify(first.fx.hits, null, 2),
    })
    if (failed() === first.failedAtOpen) await removeWorld(first.home)
    else console.log(`  [forensics] starting world kept: ${first.home}\n${second.stderr().split('\n').slice(-12).join('\n')}`)
  }
}

finish()

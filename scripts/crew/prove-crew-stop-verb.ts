#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootRunner,
  bound,
  childEnv,
  DIST,
  exportWorld,
  isInit,
  isResult,
  j,
  makeTally,
  removeWorld,
  SCRATCH_ROOT,
  seedHome,
  sleep,
  user,
  type Frame,
  type Runner,
} from '../daemon/dupline-world.ts'
import {
  LEAD_ASK_HELD,
  LEAD_ASK_MATE,
  LEAD_ASK_SLEEPER,
  MATE_NAME,
  SEAT_NAME,
  SEAT_SLEEP_SECONDS,
  startCrewStopFixture,
  type Fixture,
} from './crew-stop-fixture.ts'

const { check, section, finish, failed } = makeTally('prove-crew-stop-verb')
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length)
const runs = (scene: string): boolean => ONLY === undefined || ONLY.split(',').includes(scene)

const U0 = '00000000-0000-4000-8000-000000000000'
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'
const STOP_WORDS = 'stopped from the crew view'

type Row = { id: string; kind: string; name: string; status: string; stop_reason?: string; agent_id?: string }
type World = { name: string; home: string; fx: Fixture; runner: Runner; failedAtOpen: number; seq: number }

async function openWorld(name: string): Promise<World> {
  const failedAtOpen = failed()
  const home = join(SCRATCH_ROOT, `mercury-crew-stop-${name}-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  const fx = await startCrewStopFixture({ seatTool: 'bash' })
  const env = childEnv(home, fx.port)
  delete env.MERCURY_TEAMMATES
  delete env.MERCURY_DAEMON_PERMISSION_MODE
  delete env.MERCURY_SKIP_PERMISSIONS
  const runner = bootRunner({ cwd, env })
  runner.send(user('hello there', U0))
  const init = await runner.waitFor('the init frame', isInit, bound(90_000))
  const first = await runner.waitFor('the first turn', isResult, bound(90_000))
  check(`${name}: the runner is up and the first turn answered`, init !== null && first !== null, runner.stderr().split('\n').slice(-5).join(' | '))
  return { name, home, fx, runner, failedAtOpen, seq: 0 }
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

const answerTo = (id: string) => (f: Frame): boolean => f.type === 'control_response' && (f.response as { request_id?: string } | undefined)?.request_id === id
const responseOf = (f: Frame | null): { subtype?: string; response?: Record<string, unknown>; error?: string } => (f?.response as { subtype?: string; response?: Record<string, unknown>; error?: string }) ?? {}

async function control(w: World, request: Record<string, unknown>, timeoutMs: number): Promise<Frame | null> {
  const id = `cs-${w.name}-${++w.seq}`
  const before = w.runner.frames.length
  w.runner.send({ type: 'control_request', request_id: id, request })
  return w.runner.waitFor(`the answer to ${id}`, answerTo(id), timeoutMs, before)
}

async function facts(w: World): Promise<Row[]> {
  const frame = await control(w, { subtype: 'session_facts' }, bound(15_000))
  const work = responseOf(frame).response?.work
  return Array.isArray(work) ? (work as Row[]) : []
}

async function waitRow(w: World, label: string, test: (r: Row) => boolean, timeoutMs: number): Promise<Row | null> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const rows = await facts(w)
    const hit = rows.find(test)
    if (hit !== undefined) return hit
    if (Date.now() >= until) {
      console.log(`  [wait] ${label}: no such row within ${timeoutMs} ms — rows ${j(rows.map(r => `${r.kind}:${r.name}:${r.status}`))}`)
      return null
    }
    await sleep(300)
  }
}

function sleepPids(): string[] {
  const out = spawnSync('pgrep', ['-f', `sleep ${SEAT_SLEEP_SECONDS}`], { encoding: 'utf8' })
  return (out.stdout ?? '').split('\n').map(s => s.trim()).filter(s => s !== '')
}

async function waitSleepChild(present: boolean, timeoutMs: number): Promise<string[]> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const pids = sleepPids()
    if ((pids.length > 0) === present) return pids
    if (Date.now() >= until) return pids
    await sleep(250)
  }
}

const notificationFor = (taskId: string) => (f: Frame): boolean => f.type === 'system' && f.subtype === 'task_notification' && f.task_id === taskId
const hitsOf = (fx: Fixture, ...routes: string[]): number => fx.hits.filter(h => routes.includes(h.route)).length

if (!existsSync(DIST)) {
  console.log(`\nFAIL ${DIST} missing — build first, or name a bundle with --dist`)
  check('the built bundle is present', false, DIST)
} else {
  console.log(`bundle: ${DIST}`)

  if (runs('mate')) {
    section('S1 the operator stops a named teammate (the crew view\'s x x on its row): the runner ends it and says so')
    const w = await openWorld('mate')
    w.runner.send(user(LEAD_ASK_MATE, U1))
    const row = await waitRow(w, 'the teammate row', r => r.kind === 'teammate' && r.name === MATE_NAME && r.status === 'running', bound(60_000))
    check('S1 the teammate row runs before the stop', row !== null, j(w.fx.hits.map(h => h.route)))
    if (row !== null) {
      const until = Date.now() + bound(20_000)
      while (hitsOf(w.fx, 'mate', 'mate-ack') === 0 && Date.now() < until) await sleep(200)
      check('S1 the teammate asked the model once and idles on its mailbox', hitsOf(w.fx, 'mate', 'mate-ack') >= 1, j(w.fx.hits.map(h => h.route)))
      await sleep(1_000)
      const askedAtStop = hitsOf(w.fx, 'mate', 'mate-ack')
      const before = w.runner.frames.length
      const reply = await control(w, { subtype: 'stop_task', task_id: row.id }, bound(15_000))
      const r = responseOf(reply)
      check('S1 the runner answers the stop', reply !== null, 'no control_response within the bound')
      const after = await facts(w)
      const same = after.find(x => x.id === row.id)
      const stillRunning = same !== undefined && same.status === 'running'
      check('S1 the receipt is true: a success answer means the teammate is no longer running at the next facts read', r.subtype === 'success' ? !stillRunning : r.subtype === 'error', `${j(r)} · row ${j(same)}`)
      check('S1 the row leaves running (killed) or is gone within the facts\' next beat', same === undefined || same.status === 'killed', j(same))
      const notice = await w.runner.waitFor('the stop notice frame', notificationFor(row.id), bound(8_000), before)
      check('S1 the stop notice frame names the row with the status stopped', notice !== null && notice.status === 'stopped', j(notice))
      await sleep(2_000)
      check('S1 the teammate asks the model no more after the stop', hitsOf(w.fx, 'mate', 'mate-ack') === askedAtStop, j(w.fx.hits.map(h => h.route)))
      const later = await facts(w)
      check('S1 the row never returns to running', !later.some(x => x.id === row.id && x.status === 'running'), j(later.map(x => `${x.kind}:${x.name}:${x.status}`)))
    }
    await closeWorld(w)
  }

  if (runs('sleeper')) {
    section('S2 the operator stops a dispatched sub-agent inside a shell tool: its shell child dies, its record settles with the reason, the notice says so')
    const w = await openWorld('sleeper')
    const stale = sleepPids()
    check('S2 no stray sleep child of this length runs on the box before the scene', stale.length === 0, j(stale))
    w.runner.send(user(LEAD_ASK_SLEEPER, U2))
    const row = await waitRow(w, 'the sub-agent row', r => r.kind === 'agent' && r.name === SEAT_NAME && r.status === 'running', bound(60_000))
    check('S2 the sub-agent row runs before the stop', row !== null, j(w.fx.hits.map(h => h.route)))
    const child = await waitSleepChild(true, bound(30_000))
    check('S2 the sub-agent\'s shell child is alive before the stop', child.length > 0, j(w.fx.hits.map(h => h.route)))
    if (row !== null) {
      const before = w.runner.frames.length
      const seatAcksBefore = hitsOf(w.fx, 'seat-ack')
      const reply = await control(w, { subtype: 'stop_task', task_id: row.id }, bound(15_000))
      const r = responseOf(reply)
      check('S2 the runner answers the stop', reply !== null, 'no control_response within the bound')
      const gone = await waitSleepChild(false, bound(10_000))
      check('S2 the shell child is gone after the stop', gone.length === 0, j(gone))
      const settled = await waitRow(w, 'the settled row', x => x.id === row.id && x.status !== 'running', bound(8_000))
      check('S2 the record settles killed with the operator\'s reason', settled !== null && settled.status === 'killed' && settled.stop_reason === STOP_WORDS, j(settled))
      check('S2 the receipt is true: success only once the record left running', r.subtype === 'success' ? settled !== null : r.subtype === 'error', j(r))
      const notice = await w.runner.waitFor('the stop notice frame', notificationFor(row.id), bound(15_000), before)
      check('S2 the stop notice reaches the session\'s model with the reason', notice !== null && notice.status === 'stopped' && String(notice.summary ?? '').includes(STOP_WORDS), j(notice))
      await sleep(1_500)
      check('S2 the stopped seat never settled its turn with the model (no request after the stop)', hitsOf(w.fx, 'seat-ack') === seatAcksBefore, j(w.fx.hits.map(h => h.route)))
      const afterStop = await control(w, { subtype: 'stop_task', task_id: row.id }, bound(15_000))
      const r2 = responseOf(afterStop)
      check('S3a a second stop of the settled row is refused with its status, never applied', r2.subtype === 'error' && /not running/.test(String(r2.error ?? '')), j(r2))
    }
    const miss = await control(w, { subtype: 'stop_task', task_id: 'anope1234' }, bound(15_000))
    const rm = responseOf(miss)
    check('S3b a stop of an id the registry does not hold is refused with the words, never applied', rm.subtype === 'error' && /No task found with id anope1234|No running task with id anope1234/.test(String(rm.error ?? '')), j(rm))
    await closeWorld(w)
  }

  if (runs('held')) {
    section('S4 the operator stops a sub-agent the chat\'s turn waits on: the seat ends, the turn goes on and settles')
    const w = await openWorld('held')
    const before = w.runner.frames.length
    w.runner.send(user(LEAD_ASK_HELD, U3))
    const row = await waitRow(w, 'the held sub-agent row', r => r.kind === 'agent' && r.name === SEAT_NAME && r.status === 'running', bound(60_000))
    check('S4 the held sub-agent row runs before the stop', row !== null, j(w.fx.hits.map(h => h.route)))
    const child = await waitSleepChild(true, bound(30_000))
    check('S4 its shell child is alive before the stop', child.length > 0)
    if (row !== null) {
      const reply = await control(w, { subtype: 'stop_task', task_id: row.id }, bound(15_000))
      const r = responseOf(reply)
      check('S4 the runner answers the stop', reply !== null && (r.subtype === 'success' || r.subtype === 'error'), j(r))
      const gone = await waitSleepChild(false, bound(10_000))
      check('S4 the shell child is gone after the stop', gone.length === 0, j(gone))
      const settled = await waitRow(w, 'the settled held row', x => x.id === row.id && x.status !== 'running', bound(8_000))
      check('S4 the held seat\'s record settles killed', settled !== null && settled.status === 'killed', j(settled))
      const result = await w.runner.waitFor('the turn\'s result', isResult, bound(60_000), before)
      check('S4 the chat\'s own turn settles after the seat was stopped (never left hanging)', result !== null, j(w.fx.hits.map(h => h.route)))
      console.log(`  [record] S4 the turn's result: ${j({ subtype: result?.subtype, is_error: result?.is_error, result: String(result?.result ?? '').slice(0, 160) })}`)
      console.log(`  [record] S4 the fixture's routes: ${j(w.fx.hits.map(h => h.route))}`)
    }
    await closeWorld(w)
  }

  if (runs('resume')) {
    section('S5 the operator resumes a stopped named teammate (the crew view\'s r on its row): the runner spawns it again under a new row and says so')
    const w = await openWorld('resume')
    w.runner.send(user(LEAD_ASK_MATE, U1))
    const row = await waitRow(w, 'the teammate row', r => r.kind === 'teammate' && r.name === MATE_NAME && r.status === 'running', bound(60_000))
    check('S5 the teammate row runs before the stop', row !== null, j(w.fx.hits.map(h => h.route)))
    if (row !== null) {
      const until = Date.now() + bound(20_000)
      while (hitsOf(w.fx, 'mate', 'mate-ack') === 0 && Date.now() < until) await sleep(200)
      const asksAtStop = hitsOf(w.fx, 'mate', 'mate-ack')
      const stopped = responseOf(await control(w, { subtype: 'stop_task', task_id: row.id }, bound(15_000)))
      check('S5 the stop is applied', stopped.subtype === 'success', j(stopped))
      const before = w.runner.frames.length
      const resumed = await control(w, { subtype: 'resume_task', task_id: row.id }, bound(30_000))
      const rr = responseOf(resumed)
      check('S5 the runner answers the resume applied, naming a new row under the same agent id', rr.subtype === 'success' && typeof rr.response?.task_id === 'string' && rr.response.task_id !== row.id && rr.response.agent_id === `${MATE_NAME}@${MATE_TEAM}`, j(rr))
      const again = await waitRow(w, 'the respawned teammate row', x => x.kind === 'teammate' && x.name === MATE_NAME && x.status === 'running' && x.id !== row.id, bound(30_000))
      check('S5 a new teammate row runs under a new id', again !== null && again.id === rr.response?.task_id, j(again))
      const untilAsk = Date.now() + bound(20_000)
      while (hitsOf(w.fx, 'mate', 'mate-ack') <= asksAtStop && Date.now() < untilAsk) await sleep(200)
      check('S5 the respawned teammate asks the model again from its prompt', hitsOf(w.fx, 'mate', 'mate-ack') > asksAtStop, j(w.fx.hits.map(h => h.route)))
      const told = await w.runner.waitFor('the resume notice frame', f => f.type === 'system' && f.subtype === 'task_notification' && String(f.summary ?? '').includes('spawned again from the crew view'), bound(15_000), before)
      check('S5 the main agent is told the teammate was spawned again from the crew view', told !== null, j(told))
      const stopTold = w.runner.frames.slice(before).find(f => f.type === 'system' && f.subtype === 'task_notification' && String(f.summary ?? '').includes('stopped from the crew view'))
      check('S5 the main agent was told of the stop too, with the door that stopped it', stopTold !== undefined, j(w.runner.frames.slice(before).filter(f => f.type === 'system' && f.subtype === 'task_notification').map(f => f.summary)))
      const later = await facts(w)
      check('S5 the stopped row never returns to running', !later.some(x => x.id === row.id && x.status === 'running'), j(later.map(x => `${x.kind}:${x.name}:${x.status}`)))
    }
    await closeWorld(w)
  }
}

finish()

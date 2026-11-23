#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'connector-completion-part-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { CompletionPart } = await import('../../src/engine/connector/daemon/completion.ts')
const { concourseWorkersPath } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')

let failures = 0
const WHERE = 'the part under test is CompletionPart in src/engine/connector/daemon/completion.ts: change its behaviour there to match the check, or update this check if the law moved'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${WHERE}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const SESSION = 'the-session'
type Marks = { sessionId?: string; lastTurnSettledAt?: number; lastDeliveryAt?: number; endedAt?: number }
function workers(records: Record<string, Marks> | 'none' | 'unreadable'): void {
  const path = concourseWorkersPath()
  if (records === 'none') {
    rmSync(path, { force: true })
    return
  }
  const text = records === 'unreadable' ? '{ not a workers file' : JSON.stringify({ version: 1, workers: Object.fromEntries(Object.entries(records).map(([runnerId, marks]) => [runnerId, { schema: 1, runnerId, sessionId: SESSION, workspaceId: SCRATCH, isolation: 'shared', modelKey: 'm', spawnedAt: 1, lastLiveAt: 1, ...marks }])) })
  writeFileSync(`${path}.next`, text)
  renameSync(`${path}.next`, path)
}

const realNow = Date.now
let clock = 1_000_000
Date.now = () => clock

type Neighbours = { busy: boolean; unread: boolean; ticks: number }
function part(neighbours: Partial<Neighbours> = {}): { part: InstanceType<typeof CompletionPart>; n: Neighbours } {
  const n: Neighbours = { busy: false, unread: false, ticks: 0, ...neighbours }
  return {
    n,
    part: new CompletionPart({
      sessionId: () => SESSION,
      factsBusy: () => n.busy,
      hasUnreadTranscript: () => n.unread,
      tick: async () => {
        n.ticks++
      },
    }),
  }
}

section('§1 the edge: a turn that was in flight and is no longer')
{
  workers('none')
  const { part: p } = part()
  check('born at rest with no record of the runner: nothing has completed and a step at rest completes nothing', p.lastTurnCompletedAtMs() === null && p.stepTurnCompletion(false) === false && p.lastTurnCompletedAtMs() === null)
  check('a step in flight completes nothing', p.stepTurnCompletion(true) === false && p.lastTurnCompletedAtMs() === null)
  check('the step that finds the turn at rest completes it, stamped with the clock', p.stepTurnCompletion(false) === true && p.lastTurnCompletedAtMs() === clock, String(p.lastTurnCompletedAtMs()))
  check('a second step at rest completes nothing more', p.stepTurnCompletion(false) === false && p.lastTurnCompletedAtMs() === clock)
  p.stepTurnCompletion(true)
  check('a second turn completed in the same millisecond still moves the mark forward by one', p.stepTurnCompletion(false) === true && p.lastTurnCompletedAtMs() === clock + 1, String(p.lastTurnCompletedAtMs()))
  const busyAtBirth = part({ busy: true })
  check('born while the facts say busy: the first step at rest is the end of that turn', busyAtBirth.part.stepTurnCompletion(false) === true)
}

section("§2 the stamp: the runner's own record of a settled turn")
{
  workers({ 'runner-1': { lastTurnSettledAt: 500 } })
  const born = part()
  check('a stamp already on the record at birth is no new turn', born.part.stepTurnCompletion(false) === false && born.part.lastTurnCompletedAtMs() === null)
  workers({ 'runner-1': { lastTurnSettledAt: 600 } })
  born.part.refreshWorkerTurnMarks()
  check('a newer stamp read at rest completes a turn the edge never showed', born.part.stepTurnCompletion(false) === true && born.part.lastTurnCompletedAtMs() === clock)
  check('the same stamp read again completes nothing', born.part.stepTurnCompletion(false) === false)
  born.part.stepTurnCompletion(true)
  check('the edge that follows with no delivery after that stamp is the same turn, not a second one', born.part.stepTurnCompletion(false) === false && born.part.lastTurnCompletedAtMs() === clock)
  born.part.stepTurnCompletion(true)
  check('the next edge is a turn of its own', born.part.stepTurnCompletion(false) === true && born.part.lastTurnCompletedAtMs() === clock + 1)

  workers({ 'runner-1': { lastTurnSettledAt: 500 } })
  const both = part()
  both.part.stepTurnCompletion(true)
  workers({ 'runner-1': { lastTurnSettledAt: 700, lastDeliveryAt: 650 } })
  both.part.refreshWorkerTurnMarks()
  check('the edge and a newer stamp in one step are one turn', both.part.stepTurnCompletion(false) === true && both.part.stepTurnCompletion(false) === false && both.part.lastTurnCompletedAtMs() === clock)

  workers({ 'runner-1': { lastTurnSettledAt: 500 } })
  const late = part()
  late.part.stepTurnCompletion(true)
  check('the edge first…', late.part.stepTurnCompletion(false) === true)
  workers({ 'runner-1': { lastTurnSettledAt: 800, lastDeliveryAt: clock - 10 } })
  late.part.refreshWorkerTurnMarks()
  check('…then its stamp, with no delivery after the edge: still one turn', late.part.stepTurnCompletion(false) === false && late.part.lastTurnCompletedAtMs() === clock)
  workers({ 'runner-1': { lastTurnSettledAt: 900, lastDeliveryAt: clock + 10 } })
  late.part.refreshWorkerTurnMarks()
  check('a later stamp is a turn of its own', late.part.stepTurnCompletion(false) === true && late.part.lastTurnCompletedAtMs() === clock + 1)

  workers({ 'runner-1': { lastTurnSettledAt: 500 } })
  const answered = part()
  workers({ 'runner-1': { lastTurnSettledAt: 950, lastDeliveryAt: 940 } })
  answered.part.refreshWorkerTurnMarks()
  answered.part.stepTurnCompletion(false)
  workers({ 'runner-1': { lastTurnSettledAt: 950, lastDeliveryAt: 960 } })
  answered.part.refreshWorkerTurnMarks()
  answered.part.stepTurnCompletion(true)
  check('a delivery after the stamp, seen in flight, makes the next edge a turn of its own', answered.part.stepTurnCompletion(false) === true && answered.part.lastTurnCompletedAtMs() === clock + 1)
}

section('§3 the neighbours: the transcript still unread, a send demoted to the queue')
{
  workers('none')
  const { part: p, n } = part({ unread: true })
  p.stepTurnCompletion(true)
  check('an edge over an unread transcript completes nothing and asks for a tick', p.stepTurnCompletion(false) === false && n.ticks === 1 && p.lastTurnCompletedAtMs() === null, `ticks ${n.ticks}`)
  check('…and asks again while the transcript stays unread', p.stepTurnCompletion(false) === false && n.ticks === 2)
  n.unread = false
  check('…and the edge is kept: once the transcript is read, the step completes the turn', p.stepTurnCompletion(false) === true && n.ticks === 2)

  workers({ 'runner-1': { lastTurnSettledAt: 500 } })
  const demoted = part()
  demoted.part.stepTurnCompletion(true)
  demoted.part.noteSendDemoted()
  check('a send demoted to the queue at rest, with a runner that can settle it later, is no end of a turn', demoted.part.stepTurnCompletion(false) === false && demoted.part.lastTurnCompletedAtMs() === null)
  demoted.part.stepTurnCompletion(true)
  check('the note is spent by the step that read it: the next edge completes', demoted.part.stepTurnCompletion(false) === true)

  const taken = part()
  taken.part.stepTurnCompletion(true)
  taken.part.noteSendDemoted()
  taken.part.noteSendTaken()
  check('a send taken in the same step speaks for a turn: the edge completes', taken.part.stepTurnCompletion(false) === true)

  const wasBusy = part({ busy: true })
  wasBusy.part.stepTurnCompletion(true)
  wasBusy.n.busy = false
  wasBusy.part.noteSendDemoted()
  check('facts that said busy while in flight speak for a turn: the edge completes', wasBusy.part.stepTurnCompletion(false) === true)

  workers('none')
  const alone = part()
  alone.part.stepTurnCompletion(true)
  alone.part.noteSendDemoted()
  check('with no record of the runner nothing can settle it later: the edge completes', alone.part.stepTurnCompletion(false) === true)
}

section("§4 the marks: this session's own record")
{
  workers({ ended: { lastTurnSettledAt: 5000, endedAt: 1 }, other: { sessionId: 'another-session', lastTurnSettledAt: 6000 }, older: { lastTurnSettledAt: 100, lastDeliveryAt: 90 }, newer: { lastTurnSettledAt: 300, lastDeliveryAt: 310 } })
  const { part: p } = part()
  workers({ ended: { lastTurnSettledAt: 9000, endedAt: 1 }, other: { sessionId: 'another-session', lastTurnSettledAt: 9000 }, older: { lastTurnSettledAt: 100, lastDeliveryAt: 90 }, newer: { lastTurnSettledAt: 300, lastDeliveryAt: 310 } })
  p.refreshWorkerTurnMarks()
  check("a record that ended and another session's record are not read: their newer stamps complete nothing", p.stepTurnCompletion(false) === false)
  workers({ older: { lastTurnSettledAt: 100, lastDeliveryAt: 90 }, newer: { lastTurnSettledAt: 400, lastDeliveryAt: 310 } })
  p.refreshWorkerTurnMarks()
  check('of two live records of the session the one with the latest mark speaks', p.stepTurnCompletion(false) === true)
  workers('unreadable')
  p.refreshWorkerTurnMarks()
  p.stepTurnCompletion(true)
  p.noteSendDemoted()
  check('a workers file that cannot be read keeps the marks last read (the runner still counts as able to settle)', p.stepTurnCompletion(false) === false)
}

Date.now = realNow
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-connector-completion-part: the part holds' : `\nprove-connector-completion-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

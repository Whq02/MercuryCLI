#!/usr/bin/env bun
import type { SessionFactsV1 } from '../../src/engine/connector/seatProjections.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { AdmissionPart } = await import('../../src/engine/connector/daemon/admission.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  const hint = 'change the AdmissionPart method this check calls (awaiting, factsArrive, runnerShown, awaitAdmission, sendDelivered, runnerLive, parksAgain, parked) in src/engine/connector/daemon/admission.ts until this holds'
  const shown = !ok ? [detail, hint].filter(Boolean).join(' — ') : ''
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)

type Runner = NonNullable<SessionFactsV1['runner']>
const realNow = Date.now
let clock = 50_000
Date.now = () => clock
const starting = (sinceMs: number, respawns = 0): Runner => ({ state: 'starting', sinceMs, respawns, maxRespawns: 3 })
const settles = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function part(factsAtMs: number | null, awaitingRunner: boolean): { admission: InstanceType<typeof AdmissionPart>; seen: { wakes: number }; openedAt: number } {
  const seen = { wakes: 0 }
  const admission = new AdmissionPart({ wakeLive: () => void seen.wakes++ })
  admission.seed(factsAtMs, awaitingRunner)
  return { admission, seen, openedAt: clock }
}

section('§1 a window on a session whose runner is up: nothing is awaited')
{
  const { admission } = part(100, false)
  const runner = starting(clock + 500)
  check('it awaits no runner, holds no admission and no refusal', admission.awaiting() === false && admission.pending() === null && admission.admissionRefusal() === null)
  check("the runner's own fact is shown as it stands, and no runner shows none", admission.runnerShown(runner) === runner && admission.runnerShown(null) === null)
  check('any facts are taken', admission.factsArrive(1) === true && admission.factsArrive(100) === true)
}

section('§2 a window opened before its runner: the start is shown from the moment it opened')
{
  const { admission, openedAt } = part(100, true)
  clock += 400
  check('while the runner is awaited the header shows a start that began when the window opened', admission.awaiting() && j(admission.runnerShown(null)) === j({ state: 'starting', sinceMs: openedAt, respawns: 0, maxRespawns: 0 }), j(admission.runnerShown(null)))
  check('facts no newer than the ones seeded at birth are not the runner speaking: they are turned away', admission.factsArrive(100) === false && admission.factsArrive(99) === false && admission.awaiting())
  check('newer facts are the runner speaking: they are taken and the wait is over', admission.factsArrive(101) === true && admission.awaiting() === false)
  const late = starting(openedAt + 900)
  check("a runner still starting is shown on the window's clock, not its own later one", j(admission.runnerShown(late)) === j({ ...late, sinceMs: openedAt }))
  const early = starting(openedAt - 50)
  check('a runner that began before the window opened keeps its own clock', admission.runnerShown(early) === early)
  admission.runnerReported(starting(openedAt + 900))
  check("a first start reported keeps the window's clock", j(admission.runnerShown(late)) === j({ ...late, sinceMs: openedAt }))
  admission.runnerReported(starting(openedAt + 900, 1))
  check("a respawn lets the window's clock go: the runner's own is shown", admission.runnerShown(late) === late)
  const unseeded = part(null, true)
  check('with no facts seeded at birth the first facts are taken', unseeded.admission.factsArrive(1) === true && !unseeded.admission.awaiting())
  const settled = part(100, true)
  settled.admission.factsArrive(101)
  settled.admission.runnerReported(undefined)
  check("facts that report no starting runner let the window's clock go", settled.admission.runnerShown(late) === late)
}

section('§3 the admission: a refusal is said, a new attempt takes it back')
{
  const { admission, seen } = part(null, true)
  let open: (refusal: string | null) => void = () => {}
  const first = new Promise<string | null>(resolve => (open = resolve))
  admission.awaitAdmission(first)
  check('a running admission is held for a send to wait on, and wakes nobody', admission.pending() === first && seen.wakes === 0)
  open(null)
  await settles()
  check('an admission that ends with no refusal is let go, says nothing and wakes nobody', admission.pending() === null && admission.admissionRefusal() === null && seen.wakes === 0)
  admission.awaitAdmission(Promise.resolve('the runner could not start'))
  await settles()
  check('a refused admission says its refusal and wakes the listeners once', admission.admissionRefusal() === 'the runner could not start' && seen.wakes === 1 && admission.pending() === null)
  check('a refused start shows no runner in the header', admission.runnerShown(starting(clock)) === null)
  const second = new Promise<string | null>(resolve => (open = resolve))
  admission.awaitAdmission(second)
  check('a new attempt takes the refusal back at once and wakes the listeners', admission.admissionRefusal() === null && seen.wakes === 2)
  const third = Promise.resolve(null)
  admission.awaitAdmission(third)
  open('the refusal of an attempt that was replaced')
  await settles()
  check('the refusal of an attempt that was replaced is not said', admission.admissionRefusal() === null && seen.wakes === 2)
}

section('§4 after a refusal: facts, a send, the record')
{
  const refusedPart = async (): Promise<ReturnType<typeof part>> => {
    const p = part(100, true)
    p.admission.awaitAdmission(Promise.resolve('refused'))
    await settles()
    return p
  }
  const byFacts = await refusedPart()
  const late = starting(byFacts.openedAt + 900)
  check('facts that arrive after a refusal end the wait, take the refusal back and show the runner on its own clock', byFacts.admission.factsArrive(101) && byFacts.admission.admissionRefusal() === null && byFacts.admission.runnerShown(late) === late)
  const bySend = await refusedPart()
  clock += 700
  bySend.admission.sendDelivered()
  check('a send that is delivered takes the refusal back and restarts the shown start at that moment', bySend.admission.admissionRefusal() === null && j(bySend.admission.runnerShown(null)) === j({ state: 'starting', sinceMs: clock, respawns: 0, maxRespawns: 0 }))
  const calm = part(100, true)
  clock += 300
  calm.admission.sendDelivered()
  check('a send delivered with no refusal standing leaves the shown start where it was', j(calm.admission.runnerShown(null)) === j({ state: 'starting', sinceMs: calm.openedAt, respawns: 0, maxRespawns: 0 }))
  const byRunner = await refusedPart()
  byRunner.admission.runnerLive()
  check('a record that says the runner is live takes the refusal back, ends the wait and keeps the window clock for the start', byRunner.admission.admissionRefusal() === null && !byRunner.admission.awaiting() && j(byRunner.admission.runnerShown(starting(byRunner.openedAt + 900))) === j({ ...starting(byRunner.openedAt + 900), sinceMs: byRunner.openedAt }))
}

section('§5 the record parks the session again')
{
  const up = part(100, false)
  check('a record with a runner never parks', up.admission.parksAgain('runner-1') === false)
  check('a record with no runner parks a window that awaited none', up.admission.parksAgain('') === true)
  clock += 1000
  up.admission.parked(250)
  check('parked: the runner is awaited again, from this moment, with the facts read now as the seed', up.admission.awaiting() && j(up.admission.runnerShown(null)) === j({ state: 'starting', sinceMs: clock, respawns: 0, maxRespawns: 0 }) && up.admission.factsArrive(250) === false && up.admission.factsArrive(251) === true)
  const waiting = part(100, true)
  check('a window already awaiting its runner is not parked twice', waiting.admission.parksAgain('') === false)
  waiting.admission.awaitAdmission(Promise.resolve('refused'))
  await settles()
  check('…unless its admission was refused: then the record parks it afresh', waiting.admission.parksAgain('') === true)
  waiting.admission.parked(null)
  check('…and the refusal is taken back', waiting.admission.admissionRefusal() === null && waiting.admission.awaiting())
}

Date.now = realNow
console.log(failures === 0 ? '\nprove-connector-admission-part: the part holds' : `\nprove-connector-admission-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import type { SessionFactsV1 } from '../../src/engine/connector/seatProjections.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { WorkPart } = await import('../../src/engine/connector/daemon/work.ts')

let failures = 0
const WHERE = 'the part under test is WorkPart in src/engine/connector/daemon/work.ts: change its behaviour there to match the check, or update this check if the law moved'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${WHERE}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)

type Facts = Partial<SessionFactsV1> | null
function part(first: Facts = null): { work: InstanceType<typeof WorkPart>; seen: { work: number; checkpoints: number }; say: (next: Facts) => void; carrier: { gone: boolean } } {
  let facts = first
  const carrier = { gone: false }
  const seen = { work: 0, checkpoints: 0 }
  const work = new WorkPart({ facts: () => facts as SessionFactsV1 | null, carrierGone: () => carrier.gone })
  work.subscribeWork(() => void seen.work++)
  work.subscribeCheckpoints(() => void seen.checkpoints++)
  return {
    work,
    seen,
    carrier,
    say: next => {
      facts = next
      work.refreshCheckpoints()
      work.refreshWork()
    },
  }
}
const crew = (id: string, status = 'running'): NonNullable<SessionFactsV1['work']>[number] => ({ id, agentId: id, kind: 'agent', name: `the ${id} errand`, status, startTime: 1 })

section('§1 the work roster: what the facts say, as one snapshot')
{
  const { work, seen, say } = part()
  check('before the first read the roster is empty and says nothing of a report', j(work.workRoster()) === j({ rows: [], mission: [] }))
  say(null)
  check('with no facts the roster says the runner reported no work', j(work.workRoster()) === j({ rows: [], mission: [], missionCard: null, samples: [], reported: false }) && seen.work === 1, j(work.workRoster()))
  const rows = [crew('agent-a'), crew('agent-b', 'completed')]
  const mission = [{ id: 'm1', title: 'the mission', status: 'running' }] as unknown as NonNullable<SessionFactsV1['mission']>
  say({ work: rows, mission, missionCard: null, samples: [] })
  const first = work.workRoster()
  check("the facts' rows, mission and samples are the roster's own, and a reported roster carries no reported word", first.rows === rows && first.mission === mission && !('reported' in first) && seen.work === 2, j(first))
  say({ work: [crew('agent-a'), crew('agent-b', 'completed')], mission: [...mission], missionCard: null, samples: [] })
  check('the same content in new objects wakes nobody and keeps the snapshot', seen.work === 2 && work.workRoster() === first)
  say({ work: [crew('agent-a', 'completed'), crew('agent-b', 'completed')], mission, missionCard: null, samples: [] })
  check('a row that moved wakes the listeners with a new snapshot', seen.work === 3 && work.workRoster() !== first && work.workRoster().rows[0]?.status === 'completed')
  say({ mission })
  check('facts that report no work say so', work.workRoster().reported === false && work.workRoster().rows.length === 0 && seen.work === 4)
}

section('§2 the facts the roster carries beside the rows')
{
  const { work, seen, say, carrier } = part({ work: [crew('agent-a')] })
  say({ work: [crew('agent-a')] })
  check('a roster with no gate fact carries no pauseGate key', !('pauseGate' in work.workRoster()) && !('gone' in work.workRoster()))
  say({ work: [crew('agent-a')], pauseGate: { paused: true, parked: 2 } })
  check('the gate fact rides the roster and wakes the listeners', j(work.workRoster().pauseGate) === j({ paused: true, parked: 2 }) && seen.work === 2)
  const before = work.workRoster()
  say({ work: [crew('agent-a')], pauseGate: { paused: true, parked: 2 }, swarm: { on: true, snapshot: { seq: 1 } } } as unknown as Facts)
  say({ work: [crew('agent-a')], pauseGate: { paused: true, parked: 2 }, swarm: { on: true, snapshot: { seq: 2 } } } as unknown as Facts)
  say({ work: [crew('agent-a')], pauseGate: { paused: true, parked: 2 }, swarm: { on: false, snapshot: { seq: 2 } } } as unknown as Facts)
  check('a move of the swarm board wakes the work listeners each time, with the same rows', seen.work === 5 && work.workRoster() !== before && j(work.workRoster()) === j(before))
  carrier.gone = true
  work.refreshWork()
  check('a carrier read gone marks the roster gone and wakes the listeners', work.workRoster().gone === true && seen.work === 6)
  work.refreshWork()
  check('…once', seen.work === 6)
  carrier.gone = false
  work.refreshWork()
  check('a carrier that is back takes the mark off', !('gone' in work.workRoster()) && seen.work === 7)
}

section('§3 the checkpoint facts')
{
  const { work, seen, say } = part()
  const unknown = work.checkpointFacts()
  check('before any facts the capture is unknown and nothing is restorable', unknown.capture === 'unknown' && unknown.restorable.size === 0)
  say({})
  check('facts with no checkpoint fact leave it unknown and wake nobody', work.checkpointFacts() === unknown && seen.checkpoints === 0)
  say({ fileCheckpoints: { capture: true, restorable: ['u1', 'u2'], files: ['src/a.ts'], undo: 'u2' } })
  const on = work.checkpointFacts()
  check('capture on: the restorable ids as a set, the files and the undo id', on.capture === 'on' && j([...on.restorable]) === j(['u1', 'u2']) && j(on.files) === j(['src/a.ts']) && on.undo === 'u2' && seen.checkpoints === 1, j({ capture: on.capture, restorable: [...on.restorable] }))
  say({ fileCheckpoints: { capture: true, restorable: ['u1', 'u2'], files: ['src/a.ts'], undo: 'u2' } })
  check('the same fact read again wakes nobody and keeps the snapshot', work.checkpointFacts() === on && seen.checkpoints === 1)
  say({ fileCheckpoints: { capture: false, restorable: [] } })
  const off = work.checkpointFacts()
  check('capture off, with no files and no undo, carries neither key', off.capture === 'off' && off.restorable.size === 0 && !('files' in off) && !('undo' in off) && seen.checkpoints === 2)
  say(null)
  check('facts that are gone put the capture back to unknown and wake the listeners', work.checkpointFacts() === unknown && seen.checkpoints === 3)
  check('the checkpoint reads woke no work listener beyond the roster own moves', seen.work === 1, String(seen.work))
}

section('§4 the listeners')
{
  const { work, seen, say } = part()
  let extra = 0
  const off = work.subscribeWork(() => void extra++)
  work.subscribeWork(() => {
    throw new Error('a listener that throws')
  })
  say({ work: [crew('agent-a')] })
  off()
  say({ work: [crew('agent-b')] })
  check('a listener that left is not woken, and one that throws does not stop the others', extra === 1 && seen.work === 2)
  let leaving = 0
  const gone = work.subscribeCheckpoints(() => void leaving++)
  say({ fileCheckpoints: { capture: true, restorable: [] } })
  gone()
  say({ fileCheckpoints: { capture: false, restorable: [] } })
  check('the checkpoint listeners keep their own list', leaving === 1 && seen.checkpoints === 2)
}

console.log(failures === 0 ? '\nprove-connector-work-part: the part holds' : `\nprove-connector-work-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

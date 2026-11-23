#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionFactsV1 } from '../../src/engine/connector/seatProjections.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const scratch = mkdtempSync(join(tmpdir(), 'connector-carrier-part-'))
const plane = join(scratch, 'daemon')
mkdirSync(plane, { recursive: true })
process.env.MERCURY_DAEMON_DIR = plane

const { CarrierPart } = await import('../../src/engine/connector/daemon/carrier.ts')
const { daemonStatePath } = await import('../../src/daemon/control/controlSocket.ts')
await import('../../src/daemon/control/ownerWatch.ts')

let failures = 0
const WHERE = 'the part under test is CarrierPart in src/engine/connector/daemon/carrier.ts: change its behaviour there to match the check, or update this check if the law moved'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${WHERE}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)

type Timer = { at: number; ms: number; fire: () => void; cleared: boolean; unref: () => Timer }
const timers: Timer[] = []
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now }
const g = globalThis as Record<string, unknown>
let clock = 2_000_000
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function fakeTheClock(): void {
  timers.length = 0
  clock = 2_000_000
  g.setTimeout = (fire: () => void, ms: number): Timer => {
    const timer: Timer = { at: clock + ms, ms, fire, cleared: false, unref: () => timer }
    timers.push(timer)
    return timer
  }
  g.clearTimeout = (timer: Timer | null | undefined): void => {
    if (timer) timer.cleared = true
  }
  Date.now = () => clock
}
function realClock(): void {
  g.setTimeout = real.setTimeout
  g.clearTimeout = real.clearTimeout
  Date.now = real.now
}
async function pass(ms: number): Promise<void> {
  const until = clock + ms
  for (;;) {
    const next = timers.filter(timer => !timer.cleared && timer.at <= until).sort((a, b) => a.at - b.at)[0]
    if (next === undefined) break
    clock = next.at
    next.cleared = true
    next.fire()
    await turn()
  }
  clock = until
  await turn()
}
const standing = (): Timer[] => timers.filter(timer => !timer.cleared)

type Reply = Record<string, unknown>
type World = { sessionId: string; busy: boolean; factsAtMs: number; answer: () => Promise<Reply> }
type Seen = { asked: Reply[]; calls: string[]; goneWhenToldAway: boolean[] }
function part(over: Partial<World> = {}): { carrier: InstanceType<typeof CarrierPart>; world: World; seen: Seen } {
  const world: World = { sessionId: 'carrier-part', busy: true, factsAtMs: 7, answer: async () => ({ ok: true, outcome: 'applied' }), ...over }
  const seen: Seen = { asked: [], calls: [], goneWhenToldAway: [] }
  const carrier: InstanceType<typeof CarrierPart> = new CarrierPart({
    sessionId: () => world.sessionId,
    rpc: req => {
      seen.asked.push(req)
      return world.answer()
    },
    factsBusy: () => world.busy,
    factsAtMs: () => {
      seen.calls.push('factsAtMs')
      return world.factsAtMs
    },
    dropBusy: () => {
      seen.calls.push('dropBusy')
      world.busy = false
    },
    recomputeLive: () => void seen.calls.push('recomputeLive'),
    carrierWentAway: () => {
      seen.calls.push('carrierWentAway')
      seen.goneWhenToldAway.push(carrier.gone())
    },
  })
  return { carrier, world, seen }
}

section('§1 the stalled turn: 45 s with no facts read asks the carrier, and only a carrier that does not vouch for the turn settles it')
{
  fakeTheClock()
  const { carrier, world, seen } = part()
  check('a new part has armed nothing', standing().length === 0 && carrier.gone() === false)
  carrier.armBusyStall()
  check('the first busy read arms one deadline of 45,000 ms', standing().length === 1 && standing()[0]!.ms === 45_000, j(standing().map(timer => timer.ms)))
  await pass(30_000)
  carrier.armBusyStall()
  await pass(15_000)
  check('a busy read at 30 s moves the deadline: 45 s after the first read nothing is asked', seen.asked.length === 0 && standing().length === 1, j({ asked: seen.asked.length, standing: standing().map(timer => timer.at - clock) }))
  await pass(29_999)
  const before = seen.asked.length
  await pass(1)
  check('45 s after the last busy read the carrier is asked for the facts of the session, once', before === 0 && seen.asked.length === 1 && j(seen.asked[0]) === j({ op: 'sessionControl', action: 'session-facts', sessionId: 'carrier-part', by: 'operator' }), j(seen.asked))
  check('a carrier that answers keeps the turn and the deadline is armed again', seen.calls.length === 0 && world.busy === true && standing().length === 1 && standing()[0]!.ms === 45_000, j({ calls: seen.calls, standing: standing().map(timer => timer.ms) }))
  world.busy = false
  await pass(45_000)
  check('an answer that comes when the facts no longer say busy arms nothing', seen.asked.length === 2 && standing().length === 0 && seen.calls.length === 0, j({ asked: seen.asked.length, standing: standing().length, calls: seen.calls }))

  const refused = part({ answer: async () => ({ ok: true, outcome: 'refused', detail: 'no runner holds the session' }) })
  refused.carrier.armBusyStall()
  await pass(45_000)
  check('a carrier that refuses settles the turn idle: the busy word drops, then the live state is recomputed', j(refused.seen.calls) === j(['dropBusy', 'recomputeLive']) && refused.world.busy === false && standing().length === 0, j(refused.seen.calls))
  const failed = part({ answer: async () => ({ ok: false, error: 'no such session' }) })
  failed.carrier.armBusyStall()
  await pass(45_000)
  const away = part({ answer: () => Promise.reject(new Error('ECONNREFUSED')) })
  away.carrier.armBusyStall()
  await pass(45_000)
  check('…and so do a failed reply and a carrier that does not answer', j(failed.seen.calls) === j(['dropBusy', 'recomputeLive']) && j(away.seen.calls) === j(['dropBusy', 'recomputeLive']), j({ failed: failed.seen.calls, away: away.seen.calls }))
  const atRest = part({ busy: false, answer: async () => ({ ok: true, outcome: 'refused' }) })
  atRest.carrier.armBusyStall()
  await pass(45_000)
  check('a refusal for a turn that is no longer busy settles nothing', atRest.seen.asked.length === 1 && atRest.seen.calls.length === 0, j(atRest.seen.calls))
  const left = part()
  left.carrier.armBusyStall()
  left.carrier.disarmBusyStall()
  await pass(90_000)
  check('a deadline disarmed asks nothing, and disarming with none armed is quiet', left.seen.asked.length === 0 && standing().length === 0 && (left.carrier.disarmBusyStall(), true))
  realClock()
}

const record = (extra: Record<string, unknown> = {}): void => writeFileSync(daemonStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: real.now(), dir: plane, controlSock: join(plane, 'control.sock'), ...extra }))
const noRecord = (): void => rmSync(daemonStatePath(), { force: true })
async function probed(carrier: InstanceType<typeof CarrierPart>, times = 1): Promise<void> {
  for (let n = 0; n < times; n++) {
    carrier.probeCarrier()
    for (let i = 0; i < 4; i++) await turn()
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await readFile(daemonStatePath(), 'utf8').catch(() => null)
      await new Promise(resolve => real.setTimeout(resolve, 1))
    }
    for (let i = 0; i < 4; i++) await turn()
  }
}

section("§2 the carrier that is gone: after one read that found the daemon's record alive, three reads in a row that find it gone settle the turn")
{
  noRecord()
  const never = part()
  await probed(never.carrier, 5)
  check('a carrier never seen alive is not said to be gone, however often its record is missing', never.carrier.gone() === false && never.seen.calls.length === 0, j(never.seen.calls))

  const { carrier, world, seen } = part({ factsAtMs: 41 })
  record()
  await probed(carrier)
  noRecord()
  await probed(carrier, 2)
  const afterTwo = { gone: carrier.gone(), calls: [...seen.calls] }
  record()
  await probed(carrier)
  noRecord()
  await probed(carrier, 2)
  const afterTwoMore = { gone: carrier.gone(), calls: [...seen.calls] }
  check('two reads that find it gone settle nothing, and a read that finds it alive starts the count again', afterTwo.gone === false && afterTwo.calls.length === 0 && afterTwoMore.gone === false && afterTwoMore.calls.length === 0, j({ afterTwo, afterTwoMore }))
  await probed(carrier)
  check('the third read in a row settles: the stamp of the facts is latched, the busy word dropped, and the door told the carrier went away, in that order', carrier.gone() === true && j(seen.calls) === j(['factsAtMs', 'dropBusy', 'carrierWentAway']) && world.busy === false, j(seen.calls))
  check('the verdict already stands when the door is told, so the roster it refreshes carries gone with the rows dropped', j(seen.goneWhenToldAway) === j([true]), j(seen.goneWhenToldAway))
  await probed(carrier, 4)
  check('a carrier settled gone is not read again and the door is told once', j(seen.calls) === j(['factsAtMs', 'dropBusy', 'carrierWentAway']), j(seen.calls))

  const stopping = part()
  record()
  await probed(stopping.carrier)
  record({ state: 'stopping', stoppingAt: real.now() })
  await probed(stopping.carrier, 3)
  const dead = part()
  record()
  await probed(dead.carrier)
  record({ pid: 2 ** 22 + 4321 })
  await probed(dead.carrier, 3)
  check('a record that says stopping, and one whose process is dead, are a carrier that is gone', stopping.carrier.gone() === true && dead.carrier.gone() === true, j({ stopping: stopping.carrier.gone(), dead: dead.carrier.gone() }))

  const twice = part()
  record()
  await probed(twice.carrier)
  noRecord()
  for (let n = 0; n < 2; n++) {
    twice.carrier.probeCarrier()
    await probed(twice.carrier)
  }
  const afterTwoPairs = twice.carrier.gone()
  twice.carrier.probeCarrier()
  await probed(twice.carrier)
  check('a second ask while a read is under way starts no second read: two pairs of asks count two, the third settles', afterTwoPairs === false && twice.carrier.gone() === true, j({ afterTwoPairs, gone: twice.carrier.gone() }))

  fakeTheClock()
  const armed = part()
  armed.carrier.armBusyStall()
  const armedBefore = standing().length
  record()
  await probed(armed.carrier)
  noRecord()
  await probed(armed.carrier, 3)
  check('settling the carrier gone disarms the stall deadline', armedBefore === 1 && armed.carrier.gone() === true && standing().length === 0, j({ armedBefore, standing: standing().map(timer => timer.ms) }))
  realClock()
  noRecord()
}

section("§3 the latch on the facts' stamp: the dead daemon's facts stay stripped, and facts with another stamp are believed again")
{
  const facts = (atMs: number): SessionFactsV1 => ({ schema: 1, sessionId: 'carrier-part', atMs, busy: true, work: [{ id: 'agent-a' }], mission: [{ id: 'm1' }], samples: [{ id: 's1' }], queue: [] }) as unknown as SessionFactsV1
  const { carrier, seen } = part({ factsAtMs: 41 })
  const first = facts(41)
  check('before any verdict the facts pass as they are', carrier.factsFromCarrier(first) === first)
  record()
  await probed(carrier)
  noRecord()
  await probed(carrier, 3)
  const stripped = carrier.factsFromCarrier(first)
  check('once gone, facts that carry the latched stamp come back idle with no work, mission or samples, and the rest as it was', carrier.gone() === true && stripped !== first && j(stripped) === j({ ...first, busy: false, work: [], mission: [], samples: [] }) && carrier.gone() === true, j(stripped))
  const fresh = facts(42)
  check('facts with another stamp pass as they are and lift the verdict', carrier.factsFromCarrier(fresh) === fresh && carrier.gone() === false)
  await probed(carrier, 2)
  const afterTwo = carrier.gone()
  await probed(carrier)
  check('…and the count starts again: the record still missing, it takes three more reads to settle', afterTwo === false && carrier.gone() === true && j(seen.calls) === j(['factsAtMs', 'dropBusy', 'carrierWentAway', 'factsAtMs', 'dropBusy', 'carrierWentAway']), j({ afterTwo, calls: seen.calls }))
  noRecord()
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-connector-carrier-part: the watch on the carrier stands alone' : `\nprove-connector-carrier-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'busy-stall-deadline-'))
const plane = join(scratch, 'daemon')
for (const dir of [join(scratch, 'home'), plane]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = plane
delete process.env.MERCURY_HOME

const { CarrierPart } = await import('../../src/engine/connector/daemon/carrier.ts')
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
const { daemonStatePath } = await import('../../src/daemon/control/controlSocket.ts')
await import('../../src/daemon/control/ownerWatch.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const j = (v: unknown): string => JSON.stringify(v)
const PART = 'src/engine/connector/daemon/carrier.ts'
const DOOR = 'src/engine/connector/daemonConnector.ts'

type Armed = { ms: number; at: number; fire: () => void; cleared: boolean; every: boolean; unref: () => Armed; ref: () => Armed; hasRef: () => boolean; refresh: () => Armed }
const armed: Armed[] = []
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now }
const g = globalThis as Record<string, unknown>
let clock = 5_000_000
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const PRODUCT = join(import.meta.dir, '..', '..', 'src') + sep
const armedByTheProduct = (): boolean => {
  const stack = new Error().stack ?? ''
  return stack.includes(PRODUCT) || stack.includes(PRODUCT.split(sep).join('/'))
}
function fakeTheClock(): void {
  armed.length = 0
  const arm = (every: boolean) => (fire: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): unknown => {
    if (!armedByTheProduct()) return (every ? real.setInterval : real.setTimeout)(fire, ms, ...args)
    const one: Armed = { ms, at: clock + ms, fire: () => fire(...args), cleared: false, every, unref: () => one, ref: () => one, hasRef: () => false, refresh: () => one }
    armed.push(one)
    return one
  }
  const disarm = (realClear: (handle: never) => void) => (one: unknown): void => {
    if (one !== null && typeof one === 'object' && armed.includes(one as Armed)) (one as Armed).cleared = true
    else if (one !== null && one !== undefined) realClear(one as never)
  }
  g.setTimeout = arm(false)
  g.setInterval = arm(true)
  g.clearTimeout = disarm(real.clearTimeout)
  g.clearInterval = disarm(real.clearInterval)
  Date.now = () => clock
}
function realClock(): void {
  g.setTimeout = real.setTimeout
  g.clearTimeout = real.clearTimeout
  g.setInterval = real.setInterval
  g.clearInterval = real.clearInterval
  Date.now = real.now
}
async function pass(ms: number): Promise<void> {
  const until = clock + ms
  for (;;) {
    const next = armed.filter(one => !one.every && !one.cleared && one.at <= until).sort((a, b) => a.at - b.at)[0]
    if (next === undefined) break
    clock = next.at
    next.cleared = true
    next.fire()
    await turn()
  }
  clock = until
  await turn()
}
const stalls = (): Armed[] => armed.filter(one => !one.every && one.ms === 45_000 && !one.cleared)

type Reply = Record<string, unknown>
function carrier(world: { busy: boolean; answer: () => Promise<Reply> }): { part: InstanceType<typeof CarrierPart>; asked: Reply[]; calls: string[] } {
  const asked: Reply[] = []
  const calls: string[] = []
  const part = new CarrierPart({
    sessionId: () => 'stall-proof',
    rpc: req => {
      asked.push(req)
      return world.answer()
    },
    factsBusy: () => world.busy,
    factsAtMs: () => 0,
    dropBusy: () => {
      calls.push('dropBusy')
      world.busy = false
    },
    recomputeLive: () => void calls.push('recomputeLive'),
    carrierWentAway: () => void calls.push('carrierWentAway'),
  })
  return { part, asked, calls }
}

fakeTheClock()
{
  const world = { busy: true, answer: async (): Promise<Reply> => ({ ok: true, outcome: 'applied' }) }
  const { part, asked, calls } = carrier(world)
  part.armBusyStall()
  await pass(30_000)
  part.armBusyStall()
  await pass(44_999)
  const quiet = asked.length
  await pass(1)
  t(
    'the deadline rides the one primitive: a busy read moves it, and it runs out 45 s after the last one',
    stalls().length === 1 && quiet === 0 && asked.length === 1,
    `${j({ askedBefore: quiet, asked: asked.length, standing: stalls().length })} — armBusyStall of ${PART} arms armInactivityDeadline once and touches it at each later read`,
  )
  t(
    'expiry probes the truth owner (session-facts)',
    j(asked[0]) === j({ op: 'sessionControl', action: 'session-facts', sessionId: 'stall-proof', by: 'operator' }),
    `${j(asked)} — probeStalledTurn of ${PART} asks the carrier it was handed for the facts of the session`,
  )
  t(
    'a live answer re-arms instead of condemning',
    calls.length === 0 && world.busy === true && stalls().length === 1,
    `${j({ calls, standing: stalls().length })} — an answer that is ok and not refused arms the deadline again while the facts say busy, in probeStalledTurn of ${PART}`,
  )
  const refused = { busy: true, answer: async (): Promise<Reply> => ({ ok: true, outcome: 'refused', detail: 'no runner holds the session' }) }
  const first = carrier(refused)
  first.part.armBusyStall()
  await pass(45_000)
  const away = { busy: true, answer: (): Promise<Reply> => Promise.reject(new Error('ECONNREFUSED')) }
  const second = carrier(away)
  second.part.armBusyStall()
  await pass(45_000)
  t(
    'a refusal or unreachable daemon settles the view idle',
    j(first.calls) === j(['dropBusy', 'recomputeLive']) && j(second.calls) === j(['dropBusy', 'recomputeLive']) && !refused.busy && !away.busy,
    `${j({ refused: first.calls, unreachable: second.calls })} — settleStalledTurn of ${PART} drops the busy word and then has the live state recomputed`,
  )
  part.disarmBusyStall()
}

fakeTheClock()
{
  const SID = 'stall-door'
  const answer = {
    model: { effective: 'claude-sonnet-5-5', setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    workspace: { cwd: scratch, originalCwd: scratch, projectRoot: scratch },
    queue: [],
  }
  const say = (atMs: number, busy: boolean): void => publishSessionFacts({ schema: 1, sessionId: SID, atMs, pendingModel: null, busy, ...answer } as never)
  const heartbeat = async (): Promise<void> => {
    for (const one of armed.filter(each => each.every && each.ms !== 1000 && !each.cleared)) one.fire()
    await turn()
  }
  const aSecondPasses = async (): Promise<void> => {
    for (const one of armed.filter(each => each.every && each.ms === 1000 && !each.cleared)) one.fire()
    for (let i = 0; i < 8; i++) await readFile(daemonStatePath(), 'utf8').catch(() => null)
    await turn()
  }
  say(1, true)
  writeFileSync(daemonStatePath(), JSON.stringify({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: real.now(), dir: plane, controlSock: join(plane, 'control.sock') }))
  const door = new DaemonSessionConnector({ sessionId: SID, runnerId: 'runner-stall', title: 'the chat', projectLabel: 'proof', workspaceId: scratch, home: scratch })
  await door.attach()
  const atAttach = stalls()
  say(2, true)
  await heartbeat()
  const touched = stalls()
  say(3, false)
  await heartbeat()
  const fallen = stalls().length
  say(4, true)
  await heartbeat()
  const again = stalls().length
  for (let i = 0; i < 3; i++) await aSecondPasses()
  rmSync(daemonStatePath(), { force: true })
  for (let i = 0; i < 40 && door.workRoster().gone !== true; i++) await aSecondPasses()
  const gone = { gone: door.workRoster().gone === true, standing: stalls().length }
  const refusal = await door.setEffort('high')
  const stale = { standing: stalls().length, inFlight: door.live().inFlight }
  t(
    "the busy write arms/touches the stall deadline (the busy word read through the carrier latch: a dead daemon's stale busy never re-arms)",
    atAttach.length === 1 && touched.length === 1 && touched[0] === atAttach[0] && again === 1 && gone.gone && gone.standing === 0 && refusal.state === 'refused' && stale.standing === 0 && stale.inFlight === false,
    `${j({ atAttach: atAttach.length, afterASecondRead: touched.length, sameDeadline: touched[0] === atAttach[0], armedAgain: again, gone, refusal, stale })} — readFacts of ${DOOR} takes the facts through carrierPart.factsFromCarrier and arms with the busy word of what comes back, so the facts of a daemon read gone, read again by a verb the carrier refuses, arm nothing`,
  )
  t('…and the busy fall disarms it', fallen === 0, `${fallen} deadlines stand after facts that say idle — readFacts of ${DOOR} calls carrierPart.disarmBusyStall when the busy word falls`)
  say(5, true)
  await heartbeat()
  const back = stalls().length
  door.detach()
  const left = stalls().length
  const unattached = await door.setEffort('max')
  const armedUnattached = stalls().length
  door.detach()
  t(
    'detach disarms (no timer outlives the connector)',
    back === 1 && left === 0 && unattached.state === 'refused' && armedUnattached === 1 && stalls().length === 0,
    `${j({ armedByFreshFacts: back, afterDetach: left, armedByAReadWithNoWindow: armedUnattached, afterASecondDetach: stalls().length })} — detach of ${DOOR} disarms before it asks whether a window is attached, so a deadline armed by a read with no window leaves too`,
  )
}
realClock()

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? 'BUSY STALL DEADLINE: ALL PASS' : 'BUSY STALL DEADLINE: RED')
process.exit(failures)

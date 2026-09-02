#!/usr/bin/env bun
// ============================================================================
//  scripts/browser/prove-browser-lifecycle.ts — the browser child's LIFECYCLE
//  seams, driven on the REAL owner store, launch body and disposer with a
//  FIXTURE driver standing in for puppeteer-core (no Chrome: the gate, the
//  cap census, the slot reserve, the handoff and the teardown are the real
//  code; only the spawn is scripted, and it lands when the proof says so).
//  One pin per law:
//
//   L1  a teardown during the launch: the disposer awaits the flight, the
//       landing child is closed (never handed to the forgotten state), the
//       joined caller gets the 'torn-down' refusal, and the disposal settles
//       only AFTER the child is gone;
//   L2  the relaunch behind a teardown: an ensure behind that teardown
//       launches a fresh child for the fresh state; when both flights settle
//       exactly ONE child lives — the new one — and the census sees it;
//   L3  a setup failure after the spawn closes the child on the way out
//       (the error still surfaces; the next ensure launches cleanly);
//   L4  the census counts a flight: a launch in the air holds a cap slot
//       (url null) and another owner past the cap is refused by name;
//   L5  op:"close" during a launch waits for the landing and closes it;
//   L6  the shutdown sweep during a launch settles only once the landing
//       child is closed (the drain barrier);
//   L7  dispose is idempotent (a repeat, and a never-seen owner, are no-ops);
//   L8  the Browser tool's open op names the teardown as a refusal, never
//       as a missing engine (no provision hint).
//
//  Run: ~/.bun/bin/bun run scripts/browser/prove-browser-lifecycle.ts
// ============================================================================
import { join } from 'node:path'
import type { Browser as DriverBrowser } from 'puppeteer-core'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
// The resolver's operator pin is an existence check — any real file stands
// in for the engine; the fixture driver below never spawns it.
process.env.MERCURY_BROWSER_PATH = process.execPath
process.env.MERCURY_BROWSER ??= '1'
delete process.env.MERCURY_BROWSER_MAX_SESSIONS

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const session = await import('../../src/services/browser/browserSession.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { disposeAllOwnersForShutdown } = await import('../../src/services/run/ownerLifecycle.ts')

// ── the fixture driver ──────────────────────────────────────────────────────
// A spawned child that lands (resolves the driver's launch) only when told,
// can fail its setup call, and records close/kill — the events the laws
// above are stated in.
class FixtureChild {
  connected = true
  closed = false
  killed = false
  failSetup = false
  readonly page = {
    url: () => 'about:blank',
    on: () => undefined,
    viewport: () => ({ width: 1280, height: 800 }),
    close: async () => undefined,
  }
  readonly landed: Promise<void>
  #land: () => void = () => undefined
  constructor(
    readonly id: number,
    private readonly log: string[],
  ) {
    this.landed = new Promise<void>(resolve => {
      this.#land = resolve
    })
  }
  land(): void {
    this.#land()
  }
  process() {
    return {
      pid: 900_000 + this.id,
      kill: () => {
        this.killed = true
        this.connected = false
        this.log.push(`killed:${this.id}`)
      },
    }
  }
  async pages() {
    if (this.failSetup) throw new Error(`fixture child ${this.id}: setup failed after the spawn`)
    return [this.page]
  }
  async newPage() {
    return this.page
  }
  async close() {
    this.closed = true
    this.connected = false
    this.log.push(`closed:${this.id}`)
  }
}

const log: string[] = []
const spawned: FixtureChild[] = []
session.setBrowserLaunchDriverForProof(async () => {
  const child = new FixtureChild(spawned.length + 1, log)
  spawned.push(child)
  log.push(`spawned:${child.id}`)
  await child.landed
  return child as unknown as DriverBrowser
})
const live = (): FixtureChild[] => spawned.filter(c => !c.closed && !c.killed)
const census = (owner: string) => session.liveBrowserSessionCensus().filter(r => r.owner === owner)
function reset(): void {
  log.length = 0
  spawned.length = 0
}

console.log('============================================================')
console.log(' browser lifecycle — no stranded child, on a fixture driver')
console.log('============================================================')

// ── L1 a teardown during the launch ─────────────────────────────────────────
console.log('L1 a teardown during the launch')
{
  reset()
  const OWNER = processOwnerForLane('fixture-teardown-mid-launch')
  const flight = session.ensureBrowserSession(OWNER)
  check('L1 the launch is in the air (one child spawned, none landed)', spawned.length === 1 && live().length === 1)
  let disposed = false
  const disposal = session.disposeBrowserOwner(OWNER).then(() => {
    disposed = true
    log.push('disposed')
  })
  await tick(20)
  check('L1 the disposer waits for the flight (unsettled while the launch is in the air)', disposed === false)
  spawned[0]!.land()
  const outcome = await flight
  await disposal
  check(
    "L1 the joined caller gets the 'torn-down' refusal",
    'state' in outcome && outcome.state === 'torn-down' && outcome.note.includes('torn down'),
    JSON.stringify(outcome),
  )
  check('L1 the landing child was closed, never handed over', spawned[0]!.closed && live().length === 0)
  check(
    'L1 the disposal settles AFTER the child is gone (event order)',
    log.indexOf('closed:1') !== -1 && log.indexOf('closed:1') < log.indexOf('disposed'),
    log.join(' '),
  )
  check('L1 nothing is live for the owner (census + activeSession)', census(OWNER).length === 0 && session.activeSession(OWNER) === null)
}

// ── L2 the relaunch behind a teardown: one child in the end, the new one ────
console.log('L2 the relaunch behind a teardown')
{
  reset()
  const OWNER = processOwnerForLane('fixture-relaunch-behind-teardown')
  const first = session.ensureBrowserSession(OWNER)
  const disposal = session.disposeBrowserOwner(OWNER)
  const second = session.ensureBrowserSession(OWNER)
  check('L2 an ensure behind the teardown launches a fresh child (two in the air)', spawned.length === 2 && live().length === 2)
  check(
    'L2 the census shows the owner once (the live state, launching) while both are in the air',
    census(OWNER).length === 1 && census(OWNER)[0]!.url === null,
    JSON.stringify(census(OWNER)),
  )
  spawned[0]!.land()
  const o1 = await first
  await disposal
  spawned[1]!.land()
  const o2 = await second
  check('L2 the first landing was closed and its caller refused', 'state' in o1 && o1.state === 'torn-down' && spawned[0]!.closed)
  check(
    'L2 the second landing is the live session (object identity)',
    !('state' in o2) && live().length === 1 && live()[0] === spawned[1] && (session.activeSession(OWNER)?.browser as unknown) === spawned[1],
  )
  check('L2 exactly one live child in the census — the new one', census(OWNER).length === 1 && census(OWNER)[0]!.url === 'about:blank')
  await session.disposeBrowserOwner(OWNER)
  check('L2 the owner teardown closes the live child; nothing remains', live().length === 0 && census(OWNER).length === 0)
}

// ── L3 a setup failure after the spawn ──────────────────────────────────────
console.log('L3 a setup failure after the spawn')
{
  reset()
  const OWNER = processOwnerForLane('fixture-setup-failure')
  const flight = session.ensureBrowserSession(OWNER)
  spawned[0]!.failSetup = true
  spawned[0]!.land()
  let surfaced = ''
  try {
    await flight
  } catch (err) {
    surfaced = (err as Error).message
  }
  check('L3 the setup failure surfaces to the caller', surfaced.includes('setup failed'), surfaced)
  check('L3 the spawned child was closed on the way out', spawned[0]!.closed && live().length === 0, log.join(' '))
  check('L3 the owner holds no session and no flight afterwards', census(OWNER).length === 0 && session.activeSession(OWNER) === null)
  const again = session.ensureBrowserSession(OWNER)
  check('L3 the next ensure launches cleanly (a fresh child)', spawned.length === 2)
  spawned[1]!.land()
  const o = await again
  check('L3 …and lands a live session', !('state' in o) && live().length === 1)
  await session.disposeBrowserOwner(OWNER)
  check('L3 its teardown closes it', live().length === 0)
}

// ── L4 the census counts a flight ───────────────────────────────────────────
console.log('L4 the census counts a flight')
{
  reset()
  process.env.MERCURY_BROWSER_MAX_SESSIONS = '1'
  const A = processOwnerForLane('fixture-cap-a')
  const B = processOwnerForLane('fixture-cap-b')
  const flightA = session.ensureBrowserSession(A)
  const rowsA = census(A)
  check('L4 a launch in the air holds a cap slot (census row, url null, attributed)', rowsA.length === 1 && rowsA[0]!.url === null && rowsA[0]!.lane.includes('fixture-cap-a'), JSON.stringify(rowsA))
  const oB = await session.ensureBrowserSession(B)
  check(
    'L4 another owner past the cap is refused by the flight, by name (no second spawn)',
    'state' in oB && oB.state === 'at-capacity' && oB.note.includes('fixture-cap-a') && spawned.length === 1,
    JSON.stringify(oB),
  )
  spawned[0]!.land()
  await flightA
  await session.disposeBrowserOwner(A)
  const flightB = session.ensureBrowserSession(B)
  check('L4 the slot frees with the teardown', spawned.length === 2)
  spawned[1]!.land()
  await flightB
  await session.disposeBrowserOwner(B)
  check('L4 both children gone at the end', live().length === 0)
  delete process.env.MERCURY_BROWSER_MAX_SESSIONS
}

// ── L5 op:"close" during a launch ───────────────────────────────────────────
console.log('L5 close during a launch')
{
  reset()
  const OWNER = processOwnerForLane('fixture-close-mid-launch')
  const flight = session.ensureBrowserSession(OWNER)
  let closedEarly = false
  const closing = session.closeBrowserSession(OWNER).then(result => {
    closedEarly = true
    return result
  })
  await tick(20)
  check('L5 close waits for the landing', closedEarly === false)
  spawned[0]!.land()
  const o = await flight
  const result = await closing
  check('L5 the open caller got its session (the child landed) before close took it', !('state' in o))
  check(
    'L5 close closed the landing child and reports it',
    result === true && spawned[0]!.closed && live().length === 0 && session.activeSession(OWNER) === null,
    `result=${String(result)} ${log.join(' ')}`,
  )
  await session.disposeBrowserOwner(OWNER)
}

// ── L6 the shutdown sweep during a launch ───────────────────────────────────
console.log('L6 the shutdown sweep during a launch')
{
  reset()
  const OWNER = processOwnerForLane('fixture-shutdown-sweep')
  const flight = session.ensureBrowserSession(OWNER)
  let swept = false
  const sweep = disposeAllOwnersForShutdown().then(() => {
    swept = true
    log.push('swept')
  })
  await tick(20)
  check('L6 the sweep waits for the flight (the drain barrier holds)', swept === false)
  spawned[0]!.land()
  const o = await flight
  await sweep
  check('L6 the landing child was closed and the caller refused', 'state' in o && o.state === 'torn-down' && spawned[0]!.closed && live().length === 0)
  check('L6 the sweep settles only after the child is gone (event order)', log.indexOf('closed:1') !== -1 && log.indexOf('closed:1') < log.indexOf('swept'), log.join(' '))
}

// ── L7 dispose is idempotent ────────────────────────────────────────────────
console.log('L7 dispose is idempotent')
{
  reset()
  const OWNER = processOwnerForLane('fixture-idempotent')
  await session.disposeBrowserOwner(OWNER)
  const flight = session.ensureBrowserSession(OWNER)
  spawned[0]!.land()
  await flight
  await session.disposeBrowserOwner(OWNER)
  await session.disposeBrowserOwner(OWNER)
  check('L7 a never-seen owner and a repeat dispose are no-ops; the one child is gone', spawned.length === 1 && live().length === 0)
}

// ── L8 the tool's open op names the teardown ────────────────────────────────
console.log('L8 the open op names the teardown')
{
  reset()
  const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
  const ctx = { agentId: 'fixture-tool-teardown' } as Parameters<typeof BrowserTool.call>[1]
  const OWNER = processOwnerForLane('fixture-tool-teardown')
  const call = BrowserTool.call({ op: 'open', url: 'http://127.0.0.1:9/' } as Parameters<typeof BrowserTool.call>[0], ctx)
  check('L8 the open op is mid-launch', spawned.length === 1)
  const disposal = session.disposeBrowserOwner(OWNER)
  spawned[0]!.land()
  const { data } = await call
  await disposal
  check(
    'L8 the refusal names the teardown, never a missing engine (no provision hint)',
    data.outcome === 'failed' &&
      data.result.includes('browser session refused') &&
      data.result.includes('torn down') &&
      !data.result.includes('op:"provision"'),
    data.result,
  )
  check('L8 nothing is live afterwards', live().length === 0 && census(OWNER).length === 0)
}

session.setBrowserLaunchDriverForProof(null)
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ ALL BROWSER-LIFECYCLE PROOFS PASS')
else console.log(`❌ ${failures} BROWSER-LIFECYCLE PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

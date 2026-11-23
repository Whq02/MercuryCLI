import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'parked-wake-exit-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SATURN_DISABLE
delete process.env.MERCURY_DAEMON_PERSIST
delete process.env.MERCURY_DAEMON_OWNER_PID
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const saturn = await import('../../src/daemon/saturn/saturn.ts')
const { tickSaturnOnce, saturnDueAtOf } = await import('../../src/daemon/saturn/saturnTicker.ts')
const { SESSIONLESS_EXIT_GRACE_MS } = await import('../../src/daemon/control/sessionlessExit.ts')
const { makeSessionlessBeat } = await import('../../src/daemon/run/owner.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')
const bridge = await import('../../src/daemon/saturn/sessionScheduleBridge.ts')
const { ScheduleWakeupTool } = await import('../../src/tools/schedule-wakeup/ScheduleWakeupTool.ts')
const { CronCreateTool } = await import('../../src/tools/cron/CronCreateTool.ts')
const NOW = Date.parse('2026-10-25T12:00:00Z')
const SESSION = 'parked-wake-fixture'
const SHORT = 'concourse-w1'
const account = { family: 'fixture', source: 'api-key' as const }
const deps = { deriveAccount: () => ({ ok: true as const, account }) }
const realNow = Date.now
let now = NOW
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${JSON.stringify(detail)} — fix by what the label names: the tool's schedule edit and applyConcourseScheduleOp in src/daemon/saturn/saturn.ts, the wake firing in tickSaturnOnce in src/daemon/saturn/saturnTicker.ts, the park in parkConcourseSession in src/daemon/concourse-workers/park.ts, the daemon's hold or exit in makeSessionlessBeat in src/daemon/run/owner.ts` : ''}`)
}
const record = () => workers.readSessionWorkers()[SHORT]!
const verdict = (superseded = false): { exit: boolean; hold: string } => {
  const host = makeDaemonRunState({ dir: home, bootBuildTree: null, foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
  host.sessionless = { hosted: true, emptySince: now - SESSIONLESS_EXIT_GRACE_MS }
  host.currentOwnerPid = process.pid
  host.planeServedByOther = superseded ? { pid: process.pid, buildTree: null, alive: true } : null
  const said: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))
  let exit = false
  try {
    makeSessionlessBeat(host, {
      liveWorkers: () => ({ live: 0 }),
      requestShutdown: () => {
        exit = true
      },
    })()
  } finally {
    console.error = realError
  }
  return { exit, hold: said.join(' ') }
}
const deliveries: Array<{ parked: boolean; sessionId: string; prompt: string }> = []
const ports = {
  now: () => now,
  records: () => Object.values(workers.readSessionWorkers()).filter(r => r.endedAt === undefined),
  ...deps,
  liveFacts: () => ({ credentialed: true, stranded: false, expiresAt: null, refreshable: false }),
  deliver: async (d: typeof deliveries[number]) => { deliveries.push(d); return { ok: true } },
  birth: async () => ({ ok: false }),
  screenOpen: () => false,
  dir: process.env.MERCURY_DAEMON_DIR,
}
function seed(): void {
  now = NOW
  deliveries.length = 0
  bridge._resetScheduleBridgeForTesting()
  bridge.markScheduleSeatObserved()
  workers.updateConcourseWorkers(rows => {
    for (const key of Object.keys(rows)) delete rows[key]
    rows[SHORT] = { schema: 1, runnerId: SHORT, sessionId: SESSION, workspaceId: home, isolation: 'shared', modelKey: 'fixture-model', spawnedAt: now - 1000, lastLiveAt: now - 1000, lastDeliveryAt: now - 1000, lastTurnSettledAt: now - 500 }
  })
}
try {
  Date.now = () => now
  for (const kind of ['self-paced wake', 'cron schedule', 'delayMinutes one-shot'] as const) {
    seed()
    if (kind === 'self-paced wake') await ScheduleWakeupTool.call({ delaySeconds: 900, prompt: kind } as never)
    else await CronCreateTool.call({ ...(kind === 'cron schedule' ? { cron: '*/15 * * * *' } : { delayMinutes: 15 }), prompt: kind } as never, {} as never)
    for (const edit of bridge.takePendingScheduleEdits()) {
      const added = saturn.applyConcourseScheduleOp(SESSION, edit, `model:${SESSION}`, deps)
      check(`${kind}: the tool's edit lands on the record`, added.outcome === 'applied', added)
    }
    const armed = record().schedules?.[0]
    check(`${kind}: a pending schedule exists`, armed !== undefined, record())
    if (!armed) continue
    const due = saturnDueAtOf(armed)!
    const parked = workers.parkConcourseSession(SESSION, 'operator:test', { kill: () => true })
    check(`${kind}: the real park door leaves a parked record without a live worker`, parked.outcome === 'applied' && record().parkedAt !== undefined && record().pid === undefined, parked)
    await tickSaturnOnce(ports)
    const held = verdict()
    check(`${kind}: the daemon holds beyond its empty grace, naming the pending wake`, !held.exit && /wake/.test(held.hold), held)
    check(`${kind}: a pre-due tick preserves the schedule without firing`, record().schedules?.[0]?.id === armed.id && deliveries.length === 0, record())
    check(`${kind}: the superseded empty helper may leave while the successor holds the wake`, verdict(true).exit && !verdict().exit)
    now = due
    const fired = await tickSaturnOnce(ports)
    check(`${kind}: due with no screen, it reaches the wake delivery arm once`, fired.fired === 1 && deliveries.length === 1 && deliveries[0]?.parked === true && deliveries[0]?.sessionId === SESSION && deliveries[0]?.prompt === kind, { fired, deliveries })
    const again = await tickSaturnOnce(ports)
    check(`${kind}: a second tick does not double-fire`, again.fired === 0 && deliveries.length === 1, again)
    if (kind === 'cron schedule') {
      check(`${kind}: its next recurrence still holds the daemon`, !verdict().exit, verdict())
      saturn.applyConcourseScheduleOp(SESSION, { op: 'remove', scheduleId: armed.id }, 'operator:test', deps)
    }
    check(`${kind}: nothing pending restores the real empty exit`, verdict().exit, verdict())
  }
  seed()
  const heldFire = { scheduleId: 'aaaa1111', dueAt: now, reason: 'parked-queued' as const, envelope: { scheduleId: 'aaaa1111', dueAt: now, kind: 'fire' as const, prompt: 'held wake', onParked: 'queue' as const }, heldAt: now }
  workers.updateConcourseWorkers(rows => { rows[SHORT]!.parkedAt = now; rows[SHORT]!.heldFires = [heldFire] })
  check('a pending held wake also holds the daemon without a schedule row', !verdict().exit, verdict())
  workers.updateConcourseWorkers(rows => { rows[SHORT]!.endedAt = now })
  check('an ended record never holds the daemon', verdict().exit, verdict())
} finally {
  Date.now = realNow
  bridge._resetScheduleBridgeForTesting()
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-parked-wake-exit: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)

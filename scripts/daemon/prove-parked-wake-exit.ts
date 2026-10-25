import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'parked-wake-exit-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SATURN_DISABLE
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const workers = await import('../../src/daemon/concourseWorkers.ts')
const saturn = await import('../../src/daemon/saturn.ts')
const { tickSaturnOnce, saturnDueAtOf } = await import('../../src/daemon/saturnTicker.ts')
const { decideSessionlessExit, SESSIONLESS_EXIT_GRACE_MS } = await import('../../src/daemon/sessionlessExit.ts')
const { handoverState } = await import('../../src/daemon/handover.ts')
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
const { ScheduleWakeupTool } = await import('../../src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts')
const { CronCreateTool } = await import('../../src/tools/ScheduleCronTool/CronCreateTool.ts')
const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/daemon/main.ts'), 'utf8')
const scheduledInput = main.match(/const scheduled = ([^\n]+)/)?.[1]
if (!scheduledInput) throw new Error('the sessionless scheduled input is missing')
const scheduled = new Function('readSessionWorkers', 'candidate', 'superseded', `return ${scheduledInput}`) as (read: typeof workers.readSessionWorkers, candidate: boolean, superseded: boolean) => boolean
const recordInput = main.slice(main.indexOf('stopSaturnTicker = startSaturnTicker(')).match(/records: \(\) => \{([\s\S]*?)\n\s+\},/)?.[1]
if (!recordInput) throw new Error('the ticker record input is missing')
const tickerRecords = new Function('readSessionWorkers', 'planeServedByOther', 'isProcessAlive', 'roster', 'handover', recordInput) as (...args: unknown[]) => ReturnType<typeof workers.readSessionWorkers>[string][]
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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const record = () => workers.readSessionWorkers()[SHORT]!
const verdict = (superseded = false) => decideSessionlessExit({ hosted: true, emptySince: now - SESSIONLESS_EXIT_GRACE_MS }, {
  live: 0, birthsInFlight: 0, superseded, persist: false, foreground: false,
  scheduled: scheduled(workers.readSessionWorkers, true, superseded), now,
})
const deliveries: Array<{ parked: boolean; sessionId: string; prompt: string }> = []
const ports = {
  now: () => now,
  records: () => tickerRecords(workers.readSessionWorkers, null, () => true, undefined, undefined),
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
    const handover = handoverState(process.pid, () => false, () => Object.values(workers.readSessionWorkers()), [{ pid: process.pid, runners: [] }])
    const predecessorRecords = tickerRecords(workers.readSessionWorkers, { pid: process.pid }, () => true, { has: () => ({ alive: false }) }, undefined)
    const successorRecords = tickerRecords(workers.readSessionWorkers, null, () => true, undefined, handover)
    check(`${kind}: only the successor walks the parked record after handover`, predecessorRecords.length === 0 && successorRecords.some(r => r.sessionId === SESSION), { predecessorRecords, successorRecords })
    check(`${kind}: the superseded empty helper may leave while the successor holds the wake`, verdict(true).exit && !verdict().exit)
    now = due
    const fired = await tickSaturnOnce({ ...ports, records: () => successorRecords })
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
  check('the production delivery wakes through the existing resumeSessionId door', main.includes('...(d.parked ? { resumeSessionId: d.sessionId } : { targetSessionId: d.sessionId })'))
} finally {
  Date.now = realNow
  bridge._resetScheduleBridgeForTesting()
  rmSync(home, { recursive: true, force: true })
}
console.log(`prove-parked-wake-exit: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
